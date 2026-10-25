import { currentRequestWorkspaceId, runWithRequestWorkspace } from './data-dir.ts'

export type MetadataRuntimeMode = 'sqlite' | 'mysql' | 'shadow'

export type MetadataRepository = {
  list(table: string): Promise<Array<Record<string, unknown>>>
  upsert?(table: string, row: Record<string, unknown>): Promise<unknown>
  replaceTable(table: string, rows: Array<Record<string, unknown>>): Promise<void>
  getShareByToken?(token: string): Promise<Record<string, unknown> | null>
  deleteShareByToken?(token: string): Promise<unknown>
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
      return
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

  changed(...tables: string[]) {
    if (this.mode === 'sqlite' || !this.repository) return
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

  deleteShareToken(token: string) {
    if (this.mode === 'sqlite' || !this.repository?.deleteShareByToken) return
    const write = () => this.repository!.deleteShareByToken!(token).then(() => undefined)
    if (this.mode === 'shadow') {
      this.pending = this.pending.then(write).catch((error) => this.onShadowError(error))
    } else {
      this.pending = this.pending.then(write)
    }
  }

  async flush() {
    await this.pending
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
