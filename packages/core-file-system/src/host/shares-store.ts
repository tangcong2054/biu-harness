import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { clearRequestMemo, currentAccountId, currentRequestWorkspaceId, openAndMigrateBiu } from '@biu/host-plugin-loader/data-dir'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { normalizeCollectionPath } from '../paths.ts'
import type { ShareKind, ShareRecord } from '../share-snapshot.ts'
import {
  SqliteMetadataRuntime,
  type MetadataRepository,
  type MetadataRuntimeMode,
} from '@biu/host-plugin-loader/metadata-runtime'

export type { ShareKind, ShareRecord } from '../share-snapshot.ts'

type DatabaseSync = import('node:sqlite').DatabaseSync

type ShareRow = {
  token: string
  kind: string
  collection: string
  view_id: string
  record_id: string
  password_salt: string
  password_hash: string
  share_plugins: number
  allow_copy: number
  created_at: number
  updated_at: number
}

function mintToken() {
  return randomBytes(18).toString('base64url')
}

function hashPassword(password: string, salt = randomBytes(16)) {
  return { salt: salt.toString('hex'), hash: scryptSync(password, salt, 32).toString('hex') }
}

function asKind(value: unknown): ShareKind | '' {
  return value === 'view' || value === 'record' ? value : ''
}

function publicShare(row: ShareRow): ShareRecord {
  return {
    token: row.token,
    kind: asKind(row.kind) || 'view',
    collection: row.collection,
    viewId: row.view_id,
    recordId: row.record_id,
    hasPassword: Boolean(row.password_hash),
    sharePlugins: Boolean(row.share_plugins),
    allowCopy: row.allow_copy !== 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }
}

/** 请求内缓存的分享查询（列表装饰时按集合取一次）都以这个前缀开头，写入时作废。 */
export const SHARE_MEMO = 'sync\tshares.'

export class SharesStore {
  private base: DatabaseSync | null = null
  private runtime: SqliteMetadataRuntime | null = null
  private workspaceFallback: () => string = () => ''

  /**
   * 请求没带空间头时用哪个空间（Desktop 为当前活动空间）。
   * 不设时为空串：同一目标在"带空间"和"不带空间"两种请求里会被当成两条分享。
   */
  setWorkspaceFallback(resolve: () => string | null | undefined) {
    this.workspaceFallback = () => {
      try {
        return String(resolve() ?? '').trim()
      } catch {
        return ''
      }
    }
  }

  configureRuntime(
    mode: MetadataRuntimeMode,
    repository: MetadataRepository | null,
    onShadowError?: (error: unknown) => void,
  ) {
    this.runtime = new SqliteMetadataRuntime(
      mode,
      repository,
      () => this.baseConn(),
      ['shares'],
      onShadowError,
      { workspaceDb: () => SharesStore.ensureFlagColumns(openAndMigrateBiu(':memory:', { foreignKeys: false })) },
    )
  }

  prepare() {
    // 远端分享可能刚被重新载入；本请求里之前缓存的分享查询作废。
    return (this.runtime?.prepare() ?? Promise.resolve()).then(() => { clearRequestMemo(SHARE_MEMO) })
  }

  prepareToken(token: string) {
    return this.runtime?.prepareShareToken(token) ?? Promise.resolve()
  }

  creatorOf(token: string) {
    const row = this.conn().prepare('SELECT created_by FROM shares WHERE token = ?').get(token) as { created_by?: string } | undefined
    return String(row?.created_by ?? '')
  }

  withTokenWorkspace<T>(token: string, run: () => Promise<T>) {
    return this.runtime?.withShareWorkspace(token, run) ?? run()
  }

  flush() {
    return this.runtime?.flush() ?? Promise.resolve()
  }

  open(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.base = SharesStore.ensureFlagColumns(openAndMigrateBiu(path, { foreignKeys: false }))
    return this
  }

  private static ensureFlagColumns(db: DatabaseSync) {
    const cols = db.prepare('PRAGMA table_info(shares)').all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has('share_plugins')) db.exec('ALTER TABLE shares ADD COLUMN share_plugins INTEGER NOT NULL DEFAULT 0')
    if (!names.has('allow_copy')) db.exec('ALTER TABLE shares ADD COLUMN allow_copy INTEGER NOT NULL DEFAULT 1')
    // 分享按空间隔离：本机多空间时同一目标可以各自分享。旧行 workspace_id 为空，按“任意空间都可见”兼容。
    if (!names.has('workspace_id')) db.exec("ALTER TABLE shares ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''")
    if (!names.has('created_by')) db.exec("ALTER TABLE shares ADD COLUMN created_by TEXT NOT NULL DEFAULT ''")
    const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'shares_target'").get() as
      | { sql?: string }
      | undefined
    if (legacy && !String(legacy.sql ?? '').includes('workspace_id')) db.exec('DROP INDEX shares_target')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS shares_workspace_target ON shares(workspace_id, kind, collection, view_id, record_id)')
    return db
  }

  /** 当前请求空间；参数化查询里与空串一起使用，兼容尚未带空间的旧分享。 */
  private workspace() {
    return currentRequestWorkspaceId() || this.workspaceFallback()
  }

  private baseConn() {
    if (!this.base) this.open(':memory:')
    return this.base!
  }

  /** MySQL 模式下返回当前请求工作区自己的覆盖层。 */
  private conn() {
    return this.runtime ? this.runtime.database() : this.baseConn()
  }

  get(token: string): ShareRecord | null {
    const row = this.conn().prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRow | undefined
    return row ? publicShare(row) : null
  }

  find(kind: ShareKind, collection: string, viewId = '', recordId = ''): ShareRecord | null {
    const row = this.conn().prepare(
      `SELECT * FROM shares WHERE kind = ? AND collection = ? AND view_id = ? AND record_id = ?
       AND workspace_id IN (?, '') ORDER BY workspace_id DESC LIMIT 1`,
    ).get(kind, normalizeCollectionPath(collection), viewId, recordId, this.workspace()) as ShareRow | undefined
    return row ? publicShare(row) : null
  }

  /** 记录分享会带上当时的视图 id，归属判断不能只查空 view_id。 */
  findRecord(collection: string, recordId: string): ShareRecord | null {
    const id = String(recordId ?? '').trim()
    if (!id) return null
    const row = this.conn().prepare(
      `SELECT * FROM shares WHERE kind = ? AND collection = ? AND record_id = ? AND workspace_id IN (?, '')
       ORDER BY updated_at DESC LIMIT 1`,
    ).get('record', normalizeCollectionPath(collection), id, this.workspace()) as ShareRow | undefined
    return row ? publicShare(row) : null
  }

  /** 这张表里开了公开链接的记录 id，一次读出，列表分组不逐行查库。 */
  recordIds(collection: string): Set<string> {
    const rows = this.conn().prepare(
      `SELECT DISTINCT record_id FROM shares WHERE kind = ? AND collection = ? AND record_id <> ?
       AND workspace_id IN (?, '')`,
    ).all('record', normalizeCollectionPath(collection), '', this.workspace()) as Array<{ record_id: string }>
    return new Set(rows.map((row) => row.record_id))
  }

  verifyPassword(token: string, password: string) {
    const row = this.conn().prepare('SELECT password_salt, password_hash FROM shares WHERE token = ?').get(token) as
      | { password_salt: string; password_hash: string }
      | undefined
    if (!row) return false
    if (!row.password_hash) return true
    const salt = Buffer.from(row.password_salt, 'hex')
    const expected = Buffer.from(row.password_hash, 'hex')
    const actual = scryptSync(String(password ?? ''), salt, expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  upsert(input: {
    kind: ShareKind
    collection: string
    viewId?: string
    recordId?: string
    password?: string | null
    sharePlugins?: boolean
    allowCopy?: boolean
  }): ShareRecord {
    clearRequestMemo(SHARE_MEMO)
    this.runtime?.requireShareWriter()
    const kind = asKind(input.kind)
    if (!kind) throw new Error('invalid share kind')
    const collection = normalizeCollectionPath(input.collection)
    if (!collection || collection === '/') throw new Error('invalid collection')
    const requestedViewId = String(input.viewId ?? '').trim()
    const recordId = String(input.recordId ?? '').trim()
    if (kind === 'record' && !recordId) throw new Error('record share needs recordId')
    const now = Date.now()
    const existing = kind === 'record'
      ? this.findRecord(collection, recordId)
      : this.find(kind, collection, requestedViewId, recordId)
    const viewId = existing?.kind === 'record' ? existing.viewId : requestedViewId
    const previous = existing
      ? this.conn().prepare('SELECT * FROM shares WHERE token = ?').get(existing.token) as ShareRow
      : null
    let salt = ''
    let hash = ''
    if (input.password === undefined) {
      if (existing) {
        const row = this.conn().prepare('SELECT password_salt, password_hash FROM shares WHERE token = ?').get(existing.token) as ShareRow
        salt = row.password_salt
        hash = row.password_hash
      }
    } else if (input.password) {
      const next = hashPassword(input.password)
      salt = next.salt
      hash = next.hash
    }
    const sharePlugins = input.sharePlugins ?? existing?.sharePlugins ?? false
    const allowCopy = input.allowCopy ?? existing?.allowCopy ?? true
    const token = existing?.token ?? mintToken()
    const workspaceId = previous ? String((previous as { workspace_id?: unknown }).workspace_id ?? '') : this.workspace()
    this.conn().prepare(`
      INSERT INTO shares (token, workspace_id, kind, collection, view_id, record_id, password_salt, password_hash, share_plugins, allow_copy, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, kind, collection, view_id, record_id) DO UPDATE SET
        created_by=CASE WHEN shares.created_by = '' THEN excluded.created_by ELSE shares.created_by END,
        password_salt=excluded.password_salt,
        password_hash=excluded.password_hash,
        share_plugins=excluded.share_plugins,
        allow_copy=excluded.allow_copy,
        updated_at=excluded.updated_at
    `).run(
      token,
      workspaceId,
      kind,
      collection,
      viewId,
      recordId,
      salt,
      hash,
      sharePlugins ? 1 : 0,
      allowCopy ? 1 : 0,
      existing?.createdAt ?? now,
      now,
      currentAccountId(),
    )
    const saved = this.conn().prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRow
    // 远端按请求空间写入；本机这一列不往外传。
    const outbound = (row: ShareRow) => {
      const { workspace_id: _workspace, ...rest } = row as ShareRow & { workspace_id?: unknown }
      return rest
    }
    this.runtime?.saveShare(outbound(saved), previous ? outbound(previous) : null)
    return publicShare(saved)
  }

  revoke(token: string) {
    clearRequestMemo(SHARE_MEMO)
    this.runtime?.requireShareWriter()
    this.conn().prepare(`DELETE FROM shares WHERE token = ? AND workspace_id IN (?, '')`).run(token, this.workspace())
    this.runtime?.deleteShareToken(token)
  }

  revokeTarget(kind: ShareKind, collection: string, viewId = '', recordId = '') {
    clearRequestMemo(SHARE_MEMO)
    this.runtime?.requireShareWriter()
    const path = normalizeCollectionPath(collection)
    this.conn().prepare(
      `DELETE FROM shares WHERE kind = ? AND collection = ? AND view_id = ? AND record_id = ? AND workspace_id IN (?, '')`,
    ).run(kind, path, viewId, recordId, this.workspace())
    this.runtime?.deleteShares({ kind, collection: path, view_id: viewId, record_id: recordId })
  }

  revokeRecord(collection: string, recordId: string) {
    clearRequestMemo(SHARE_MEMO)
    const id = String(recordId ?? '').trim()
    if (!id) return
    this.runtime?.requireShareWriter()
    const path = normalizeCollectionPath(collection)
    this.conn().prepare(`DELETE FROM shares WHERE kind = ? AND collection = ? AND record_id = ? AND workspace_id IN (?, '')`)
      .run('record', path, id, this.workspace())
    this.runtime?.deleteShares({ kind: 'record', collection: path, record_id: id })
  }

  revokeView(collection: string, viewId: string) {
    clearRequestMemo(SHARE_MEMO)
    const id = String(viewId ?? '').trim()
    if (!id) return
    this.runtime?.requireShareWriter()
    const path = normalizeCollectionPath(collection)
    this.conn().prepare(`DELETE FROM shares WHERE kind = ? AND collection = ? AND view_id = ? AND workspace_id IN (?, '')`)
      .run('view', path, id, this.workspace())
    this.runtime?.deleteShares({ kind: 'view', collection: path, view_id: id })
  }

  list(): ShareRecord[] {
    const rows = this.conn().prepare(
      `SELECT * FROM shares WHERE workspace_id IN (?, '') ORDER BY updated_at DESC, token DESC`,
    ).all(this.workspace()) as Array<ShareRow & { workspace_id?: string }>
    // 修复前同一目标可能留下"带空间"和"空空间"两条；本空间那条优先，旧的空空间行不再重复列出。
    const scoped = new Set(rows.filter((row) => row.workspace_id).map(shareTargetKey))
    return rows.filter((row) => row.workspace_id || !scoped.has(shareTargetKey(row))).map(publicShare)
  }
}

function shareTargetKey(row: ShareRow) {
  return `${row.kind}\0${row.collection}\0${row.view_id}\0${row.record_id}`
}

export function dropSharesForRemovedViews(
  shares: SharesStore,
  collection: string,
  previous: Array<{ id?: string }>,
  next: Array<{ id?: string }>,
) {
  const keep = new Set(next.map((item) => String(item.id ?? '').trim()).filter(Boolean))
  for (const view of previous) {
    const id = String(view.id ?? '').trim()
    if (id && !keep.has(id)) shares.revokeView(collection, id)
  }
}
