import { currentRequestWorkspaceId, runWithRequestWorkspace } from './data-dir.ts'
import { captureSavedViewMutations, type SavedViewMutation, type SavedViewMutationResult } from './saved-view-mutations.ts'
import { mutateSqliteSavedViews } from './sqlite-saved-view-mutations.ts'

export { applySavedViewMutation, captureSavedViewMutations, savedViewMutationError } from './saved-view-mutations.ts'
export type { SavedViewMutation, SavedViewMutationResult } from './saved-view-mutations.ts'

export type MetadataRuntimeMode = 'sqlite' | 'mysql' | 'shadow'

export type MetadataRepository = {
  list(table: string): Promise<Array<Record<string, unknown>>>
  upsert?(table: string, row: Record<string, unknown>): Promise<unknown>
  replaceTable(table: string, rows: Array<Record<string, unknown>>): Promise<void>
  getShareByToken?(token: string): Promise<Record<string, unknown> | null>
  deleteShareByToken?(token: string): Promise<unknown>
  saveShare?(row: Record<string, unknown>, previous: Record<string, unknown> | null): Promise<void>
  deleteShares?(where: Record<string, unknown>): Promise<unknown>
  mutateSavedViews?(accountId: string, mutations: readonly SavedViewMutation[]): Promise<SavedViewMutationResult[]>
}

type DatabaseSync = import('node:sqlite').DatabaseSync

/**
 * 同一工作区的元数据多久从 MySQL 重读一次。多实例部署下别的实例写入的视图 / 合集 /
 * 分享，本实例最晚在这个时间后看到。设为 0 表示每次 prepare 都重读。
 */
function reloadAfterMs() {
  const raw = Number(process.env.BIU_METADATA_RELOAD_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000
}

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error(`unsafe metadata table: ${value}`)
  return `"${value}"`
}

export class SqliteMetadataRuntime {
  private activeWorkspace = ''
  private prepared = false
  private loadedAt = 0
  private pending: Promise<void> = Promise.resolve()
  /** 本地表被改过的次数。从 MySQL 装回内存时用来丢掉过期快照。 */
  private revision = 0
  private incrementalViews = false
  private invalidViewCache = false

  get savedViewCacheValid() {
    return !this.invalidViewCache
  }

  constructor(
    readonly mode: MetadataRuntimeMode,
    private readonly repository: MetadataRepository | null,
    private readonly db: () => DatabaseSync,
    readonly tables: readonly string[],
    private readonly onShadowError: (error: unknown) => void = () => {},
  ) {}

  async prepare() {
    if (this.mode !== 'mysql' || !this.repository) return
    const workspaceId = currentRequestWorkspaceId().trim()
    if (!workspaceId) throw new Error('MySQL metadata runtime requires a workspace')
    if (this.prepared && this.activeWorkspace === workspaceId && Date.now() - this.loadedAt < reloadAfterMs()) {
      await this.flush()
      if (this.prepared && this.activeWorkspace === workspaceId) return
    }
    await this.flush()
    const database = this.db()
    let seen = this.revision
    let snapshots = await this.loadSnapshots()
    while (this.revision !== seen) {
      await this.flush()
      seen = this.revision
      snapshots = await this.loadSnapshots()
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      if (this.revision !== seen) {
        database.exec('ROLLBACK')
        return this.prepare()
      }
      for (const [table, rows] of snapshots) {
        database.prepare(`DELETE FROM ${identifier(table)}`).run()
        this.insertRows(database, table, rows)
      }
      if (this.revision !== seen) {
        database.exec('ROLLBACK')
        return this.prepare()
      }
      database.exec('COMMIT')
      this.activeWorkspace = workspaceId
      this.invalidViewCache = false
      this.prepared = true
      this.loadedAt = Date.now()
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  async prepareShareToken(token: string) {
    if (this.mode !== 'mysql' || !this.repository?.getShareByToken) return
    const row = await this.repository.getShareByToken(token)
    const database = this.db()
    database.prepare('DELETE FROM shares WHERE token = ?').run(token)
    if (row) this.insertRows(database, 'shares', [row])
  }

  async withShareWorkspace<T>(token: string, run: () => Promise<T>): Promise<T> {
    if (this.mode !== 'mysql' || !this.repository?.getShareByToken) return run()
    const row = await this.repository.getShareByToken(token)
    const workspaceId = String(row?.workspace_id ?? '').trim()
    return workspaceId ? runWithRequestWorkspace(workspaceId, run) : run()
  }

  async mutateSavedViews(accountId: string, input: readonly SavedViewMutation[]): Promise<SavedViewMutationResult[]> {
    const mutations = captureSavedViewMutations(input)
    if (!mutations.length) return []
    if (!this.tables.includes('saved_views')) throw new Error('Runtime does not manage saved views')
    if (this.mode === 'shadow') throw new Error('Incremental saved views are not enabled in shadow mode')
    const workspaceId = currentRequestWorkspaceId()
    if (this.mode === 'mysql' && (!workspaceId.trim() || !this.repository?.mutateSavedViews)) {
      throw new Error('MySQL incremental saved view repository and workspace are required')
    }
    this.incrementalViews = true
    const write = async () => {
      this.revision += 1
      this.prepared = false
      try {
        if (this.mode === 'sqlite') return mutateSqliteSavedViews(this.db(), workspaceId, accountId, mutations)
        const results = await runWithRequestWorkspace(workspaceId, () => this.repository!.mutateSavedViews!(accountId, mutations))
        try {
          const database = this.db()
          database.exec('BEGIN IMMEDIATE')
          try {
            for (const result of results) {
              database.prepare('DELETE FROM saved_views WHERE workspace_id = ? AND collection = ? AND view_id = ?')
                .run(workspaceId, result.collection, result.id)
              this.insertRows(database, 'saved_views', [{
                workspace_id: workspaceId, collection: result.collection, view_id: result.id,
                payload_json: JSON.stringify(result.view), updated_at: Date.now(),
              }])
            }
            database.exec('COMMIT')
          } catch (error) {
            database.exec('ROLLBACK')
            throw error
          }
        } catch (cause) {
          this.invalidViewCache = true
          throw Object.assign(new Error('Saved views committed; local cache must be reloaded', { cause }), {
            code: 'SAVED_VIEW_CACHE_FAILED', status: 503, committed: true,
          })
        }
        return results
      } finally {
        this.revision += 1
        this.prepared = false
      }
    }
    const result = this.pending.then(write)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  changed(...tables: string[]) {
    if (this.incrementalViews && tables.includes('saved_views')) {
      throw new Error('Saved views require incremental mutations')
    }
    if (this.mode === 'sqlite' || !this.repository) return
    if (tables.includes('shares')) throw new Error('Shares require row-level writes')
    this.revision += 1
    const unique = [...new Set(tables)]
    const workspaceId = currentRequestWorkspaceId().trim()
    const captured = unique.map((table) => [table, this.snapshot(table, workspaceId)] as const)
    const write = async () => {
      const run = async () => {
        for (const [table, rows] of captured) {
          await this.repository!.replaceTable(table, rows)
        }
      }
      if (workspaceId) await runWithRequestWorkspace(workspaceId, run)
      else await run()
    }
    if (this.mode === 'shadow') {
      this.pending = this.pending.then(write).catch((error) => {
        this.onShadowError(error)
      })
      return
    }
    this.pending = this.pending.then(write)
  }

  requireShareWriter() {
    if (this.mode === 'sqlite') return
    if (!this.tables.includes('shares') || !this.repository?.saveShare || !this.repository?.deleteShares
      || !currentRequestWorkspaceId().trim()) throw new Error('Workspace-scoped share repository required')
  }

  saveShare(row: Record<string, unknown>, previous: Record<string, unknown> | null) {
    this.requireShareWriter()
    const next = { ...row }
    const before = previous ? { ...previous } : null
    this.queueShareWrite(() => this.repository!.saveShare!(next, before))
  }

  deleteShares(where: Record<string, unknown>) {
    this.requireShareWriter()
    const captured = { ...where }
    this.queueShareWrite(() => this.repository!.deleteShares!(captured).then(() => undefined))
  }

  deleteShareToken(token: string) {
    this.deleteShares({ token })
  }

  private queueShareWrite(write: () => Promise<void>) {
    if (this.mode === 'sqlite') return
    const workspaceId = currentRequestWorkspaceId()
    this.revision += 1
    const queued = this.pending.then(async () => {
      try {
        await runWithRequestWorkspace(workspaceId, write)
      } finally {
        this.revision += 1
        this.prepared = false
      }
    })
    if (this.mode === 'shadow') {
      this.pending = queued.catch((error) => this.onShadowError(error))
    } else {
      this.pending = queued.catch((error) => {
        this.prepared = false
        try { this.db().prepare('DELETE FROM shares').run() } catch { /* The next prepare must reload the overlay. */ }
        throw error
      })
      void this.pending.catch(() => {})
    }
  }

  async flush() {
    const pending = this.pending
    try {
      await pending
    } catch (error) {
      if (this.tables.includes('shares') && this.pending === pending) this.pending = Promise.resolve()
      throw error
    }
  }

  private async loadSnapshots() {
    return Promise.all(this.tables.map(async (table) => [table, await this.repository!.list(table)] as const))
  }

  /** 在变更发生时就把行和空间记下。稍后的异步回写不能再读已经被别的请求换掉的内存表。 */
  private snapshot(table: string, workspaceId: string) {
    const database = this.db()
    const hasWorkspace = (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>)
      .some((column) => column.name === 'workspace_id')
    const rows = (hasWorkspace
      ? database.prepare(`SELECT * FROM ${identifier(table)} WHERE workspace_id = ?`).all(workspaceId)
      : database.prepare(`SELECT * FROM ${identifier(table)}`).all()) as Array<Record<string, unknown>>
    return rows.map(({ workspace_id: _workspaceId, ...row }) => {
      if (table === 'facets') {
        const { notes: _legacyNotes, ...facet } = row
        return facet
      }
      return row
    })
  }

  private insertRows(database: DatabaseSync, table: string, rows: Array<Record<string, unknown>>) {
    const columns = new Set(
      (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map((item) => item.name),
    )
    for (const row of rows) {
      const names = Object.keys(row).filter((name) => columns.has(name))
      if (!names.length) continue
      database.prepare(
        `INSERT INTO ${identifier(table)} (${names.map(identifier).join(', ')})
         VALUES (${names.map(() => '?').join(', ')})`,
      ).run(...names.map((name) => row[name] as never))
    }
  }
}
