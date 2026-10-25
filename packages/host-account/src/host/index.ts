import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Service, type Context } from 'cordis'
import { biuSqlitePath, currentAccountId, currentRequestWorkspaceId, eventsSqlitePath, isOnlineRuntime, isOperationsRuntime, openAndMigrateBiu, openSqlite, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import {
  MAX_PRIVATE_BACKUP_BYTES,
  type CloudStorageService,
  type MysqlAccountRepository,
  type RuntimeRepositoryMode,
} from '@biu/host-cloud-storage'
import type { RouteContext } from '@biu/type-http'
import {
  CollabError,
  CollabStore,
  DEFAULT_SESSION_MS,
  OPERATIONS_ADMIN_ACCOUNT_ID,
  OPERATIONS_WORKSPACE_ID,
  controlPlaneHashPassword,
  controlPlaneId,
  controlPlaneInviteToken,
  controlPlaneTokenHash,
  controlPlaneVerifyPassword,
  isRegisteredBuiltinPlugin,
} from './store.ts'
import { httpRemote, RecordReplica } from './replica.ts'
import { applySnapshot, exchangeSnapshot, restoreSnapshotSafely, takeSnapshot, type MirrorSnapshot } from './mirror.ts'
import type { AuthorizationService, ResourceRole } from './authorization.ts'
import { workspaceMembersCollection } from './workspace-members-collection.ts'

/** 插件授权同步缓存的有效期。多实例部署下这是撤销授权的最长生效延迟。 */
const PLUGIN_ACCESS_TTL_MS = 30_000

/** 与 SQLite `CollabStore.workspaceHasPlugin` 保持一致：平台运营插件只绑定运营 admin。 */
function mysqlPluginAllowed(accountId: string, workspaceId: string, pluginId: string) {
  if (!accountId || !workspaceId || !pluginId) return false
  if (pluginId !== 'platform-operations') return true
  return workspaceId === OPERATIONS_WORKSPACE_ID && accountId === OPERATIONS_ADMIN_ACCOUNT_ID
}

export type { Actor, Action, ResourceRef, ResourceRole, WorkspaceRole, Decision } from './authorization.ts'

export const name = 'account'
export const inject = ['http']

type AccountConfig = { sqlitePath?: string }
export const MYSQL_ACCOUNT_UNMIGRATED: readonly string[] = []
type CloudConnection = {
  localAccountId: string
  origin: string
  remoteAccountId: string
  remoteName: string
  remoteEmail: string
  token: string
  connectedAt: number
}

export class AccountService extends Service {
  store: CollabStore
  authorization: AuthorizationService
  readonly mysql: MysqlAccountRepository | null
  readonly accountMode: RuntimeRepositoryMode
  private readonly pluginAccessCache = new Map<string, { allowed: boolean; at: number }>()
  replica: RecordReplica | null = null
  private db: {
    close(): void
    exec(sql: string): void
    prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown }
  }

  constructor(ctx: Context, config: AccountConfig = {}) {
    super(ctx, 'account')
    const db = openAndMigrateBiu(config.sqlitePath ?? biuSqlitePath())
    this.db = db
    this.store = new CollabStore(db)
    let cloud: CloudStorageService | undefined
    try {
      cloud = ctx.get('cloudStorage') as CloudStorageService | undefined
    } catch {
      /* Offline/SQLite deployments do not require cloud storage. */
    }
    this.accountMode = isOnlineRuntime() ? (cloud?.accountMode ?? 'sqlite') : 'sqlite'
    this.mysql = this.accountMode === 'sqlite' ? null : (cloud?.accountRepository ?? null)
    if (this.accountMode !== 'sqlite' && !this.mysql) {
      throw new Error(`BIU_ACCOUNT_MYSQL_MODE=${this.accountMode} requires the MySQL account repository`)
    }
    if ((isOnlineRuntime() && this.accountMode === 'sqlite' && !process.env.VITEST) || isOperationsRuntime()) {
      this.store.bootstrapOperations({
        email: process.env.BIU_OPERATIONS_ADMIN_EMAIL || 'admin',
        password: process.env.BIU_OPERATIONS_ADMIN_PASSWORD || (isOperationsRuntime() ? undefined : '97ortanon'),
        name: process.env.BIU_OPERATIONS_ADMIN_NAME || '平台管理员',
        workspaceName: process.env.BIU_OPERATIONS_WORKSPACE_NAME || 'Biu 平台运营',
      })
    }
    this.authorization = this.store.authorization
    db.exec(`CREATE TABLE IF NOT EXISTS record_place (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      place TEXT NOT NULL,
      PRIMARY KEY (collection, record_id)
    )`)
    const origin = process.env.BIU_REMOTE_ORIGIN
    if (!isOnlineRuntime() && origin) {
      this.replica = new RecordReplica(db, httpRemote(origin))
      let snapshotSyncing = false
      const timer = setInterval(() => {
        const device = this.replica?.active()
        if (!device?.token || !device.workspaceId || snapshotSyncing) return
        snapshotSyncing = true
        void exchangeSnapshot(ctx, origin, device.token, device.accountId, device.workspaceId)
          .catch((error) => {
            console.warn('[replica] sync failed', error)
          })
          .finally(() => {
            snapshotSyncing = false
          })
      }, 15_000)
      ctx.on('dispose', () => clearInterval(timer))
      ctx.on('account/request', (event) => {
        const localAccountId = String((event as { accountId?: string }).accountId ?? '')
        if (!localAccountId) return
        this.syncReplicaCredential(localAccountId)
      })
      const saved = this.db.prepare('SELECT local_account_id FROM cloud_connections WHERE active = 1').all() as Array<{ local_account_id: string }>
      for (const row of saved) this.syncReplicaCredential(row.local_account_id)
    }
    ctx.inject(['database'], (inner) =>
      inner.database.register(
        workspaceMembersCollection(
          this.store,
          (workspaceId) => this.workspaceLocation(workspaceId) === 'cloud',
          true,
        ),
      ),
    )
    ctx.on('dispose', () => db.close())
  }

  usesMysqlAccounts() {
    return isOnlineRuntime() && this.accountMode === 'mysql'
  }

  requireMigrated(method: string): never {
    throw new CollabError(`MySQL 账号控制面尚未迁移此方法：${method}`, 501)
  }

  async resolveMcpCredential(token: string) {
    if (this.usesMysqlAccounts()) {
      return this.mysql!.resolveMcpCredential(controlPlaneTokenHash(token))
    }
    return this.store.resolveMcpCredential(token)
  }

  async auditMcp(
    tenant: { credentialId: string; accountId: string; workspaceId: string },
    toolName: string,
    success: boolean,
  ) {
    if (this.usesMysqlAccounts()) return this.mysql!.auditMcp(tenant, toolName, success)
    this.store.auditMcp(tenant, toolName, success)
  }

  async tenantForRecord(collection: string, recordId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.tenantForRecord(collection, recordId)
    return this.store.tenantForRecord(collection, recordId)
  }

  async accountByToken(token: string) {
    if (this.usesMysqlAccounts()) {
      const found = await this.mysql!.accountByTokenHash(controlPlaneTokenHash(token))
      if (!found || await this.mysql!.isSuspended(found.id)) return null
      return found
    }
    return this.store.accountByToken(token)
  }

  async activeWorkspaceFor(accountId: string) {
    if (this.usesMysqlAccounts()) return (await this.mysql!.accountById(accountId))?.activeWorkspaceId ?? ''
    return this.store.listWorkspaces(accountId).find((item) => item.id === this.store.activeWorkspaceId())?.id ?? ''
  }

  activeWorkspaceId() {
    if (this.usesMysqlAccounts()) return currentRequestWorkspaceId()
    return this.store.activeWorkspaceId()
  }

  async isMemberAsync(accountId: string, workspaceId: string) {
    if (this.usesMysqlAccounts()) {
      return (await this.mysql!.listWorkspaces(accountId)).some((item) => item.id === workspaceId)
    }
    return this.store.isMember(accountId, workspaceId)
  }

  async canAccessPlugin(accountId: string, workspaceId: string, pluginId: string) {
    const allowed = this.usesMysqlAccounts()
      ? mysqlPluginAllowed(accountId, workspaceId, pluginId) &&
        await this.mysql!.canAccessPlugin(accountId, workspaceId, pluginId, {
          includeWorkspaceGrant: isRegisteredBuiltinPlugin(pluginId),
        })
      : this.store.canAccessPlugin(accountId, workspaceId, pluginId)
    this.rememberPluginAccess(accountId, workspaceId, pluginId, allowed)
    return allowed
  }

  /** 预热：Agent 回合开始前把这个账号在这个空间的插件授权读进同步缓存。 */
  async warmPluginAccess(accountId: string, workspaceId: string, pluginIds: Iterable<string>) {
    if (!this.usesMysqlAccounts() || !accountId || !workspaceId) return
    const ids = [...new Set(pluginIds)].filter(Boolean)
    await Promise.all(ids.map((pluginId) => this.canAccessPlugin(accountId, workspaceId, pluginId).catch(() => false)))
  }

  async workspaceHasPlugin(workspaceId: string, pluginId: string, accountId = '') {
    if (this.usesMysqlAccounts()) return this.canAccessPlugin(accountId, workspaceId, pluginId)
    return this.store.workspaceHasPlugin(workspaceId, pluginId, accountId)
  }

  async isApprovedPluginPackage(pluginId: string, version: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.isApprovedPluginPackage(pluginId, version)
    return this.store.isApprovedPluginPackage(pluginId, version)
  }

  canAccessPluginCached(accountId: string, workspaceId: string, pluginId: string) {
    if (!this.usesMysqlAccounts()) return this.store.canAccessPlugin(accountId, workspaceId, pluginId)
    const key = `${accountId}\t${workspaceId}\t${pluginId}`
    const hit = this.pluginAccessCache.get(key)
    if (!hit) return false
    // 多实例部署下别的实例撤销了授权，本实例收不到通知；靠 TTL 收敛。
    if (Date.now() - hit.at > PLUGIN_ACCESS_TTL_MS) {
      this.pluginAccessCache.delete(key)
      return false
    }
    return hit.allowed
  }

  private rememberPluginAccess(accountId: string, workspaceId: string, pluginId: string, allowed: boolean) {
    this.pluginAccessCache.set(`${accountId}\t${workspaceId}\t${pluginId}`, { allowed, at: Date.now() })
  }

  /** 成员被移除、角色变更、空间删除、插件包删除后，相关授权缓存全部作废。 */
  forgetPluginAccess(match: { accountId?: string; workspaceId?: string; pluginId?: string } = {}) {
    for (const key of this.pluginAccessCache.keys()) {
      const [account, workspace, plugin] = key.split('\t')
      if (match.accountId && account !== match.accountId) continue
      if (match.workspaceId && workspace !== match.workspaceId) continue
      if (match.pluginId && plugin !== match.pluginId) continue
      this.pluginAccessCache.delete(key)
    }
  }

  async pluginLoadsFor(accountId: string, workspaceId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.pluginLoadsFor(accountId, workspaceId)
    return this.store.pluginLoadsFor(accountId, workspaceId)
  }

  async loadedPluginIds() {
    if (this.usesMysqlAccounts()) return this.mysql!.loadedPluginIds()
    return this.store.loadedPluginIds()
  }

  async setPluginLoad(accountId: string, workspaceId: string, pluginId: string, loaded: boolean) {
    if (this.usesMysqlAccounts()) {
      if (loaded && !mysqlPluginAllowed(accountId, workspaceId, pluginId)) throw new Error('plugin is not assigned')
      return this.mysql!.setPluginLoad(accountId, workspaceId, pluginId, loaded, Date.now(), {
        includeWorkspaceGrant: isRegisteredBuiltinPlugin(pluginId),
      })
    }
    this.store.setPluginLoad(accountId, workspaceId, pluginId, loaded)
  }

  async recordPluginPackage(accountId: string, input: Record<string, unknown>) {
    if (this.usesMysqlAccounts()) return this.mysql!.recordPluginPackage(accountId, input)
    this.store.recordPluginPackage(accountId, input as never)
  }

  async syncInstalledPluginPackage(input: Record<string, unknown>) {
    if (this.usesMysqlAccounts()) {
      const actorId = currentAccountId()
      if (!actorId) return false
      await this.mysql!.recordPluginPackage(actorId, input)
      return true
    }
    return this.store.syncInstalledPluginPackage(input as never)
  }

  async ensurePluginOwnerAssignments(pluginId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.ensurePluginOwnerAssignments(pluginId)
    return this.store.ensurePluginOwnerAssignments(pluginId)
  }

  async installPluginForWorkspace(accountId: string, workspaceId: string, pluginId: string, version = '') {
    const result = this.usesMysqlAccounts()
      ? await this.mysql!.installPluginForWorkspace(accountId, workspaceId, pluginId, version)
      : this.store.installPluginForWorkspace(accountId, workspaceId, pluginId, version)
    // 空间级授权只对内置插件生效，不能把结果直接写成 true。
    this.forgetPluginAccess({ workspaceId, pluginId })
    return result
  }

  async uninstallPluginFromWorkspace(accountId: string, workspaceId: string, pluginId: string) {
    const result = this.usesMysqlAccounts()
      ? await this.mysql!.uninstallPluginFromWorkspace(accountId, workspaceId, pluginId)
      : this.store.uninstallPluginFromWorkspace(accountId, workspaceId, pluginId)
    this.forgetPluginAccess({ workspaceId, pluginId })
    return result
  }

  async installPluginForAccount(accountId: string, workspaceId: string, pluginId: string, version = '') {
    const result = this.usesMysqlAccounts()
      ? await this.mysql!.installPluginForAccount(accountId, workspaceId, pluginId, version)
      : this.store.installPluginForAccount(accountId, workspaceId, pluginId, version)
    this.forgetPluginAccess({ accountId, workspaceId, pluginId })
    return result
  }

  async uninstallPluginForAccount(accountId: string, workspaceId: string, pluginId: string) {
    const result = this.usesMysqlAccounts()
      ? await this.mysql!.uninstallPluginForAccount(accountId, workspaceId, pluginId)
      : this.store.uninstallPluginForAccount(accountId, workspaceId, pluginId)
    this.forgetPluginAccess({ accountId, workspaceId, pluginId })
    return result
  }

  async removePluginPackage(accountId: string, pluginId: string) {
    try {
      if (this.usesMysqlAccounts()) return await this.mysql!.removePluginPackage(accountId, pluginId)
      this.store.removePluginPackage(accountId, pluginId)
    } finally {
      this.forgetPluginAccess({ pluginId })
    }
  }

  /** 执行租约：MySQL 控制面下存在云端，多台 Online 实例共享同一把锁。 */
  async acquireExecutionLease(accountId: string, sessionId: string, executorId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.acquireExecutionLease(accountId, sessionId, executorId)
    return this.store.acquireExecutionLease(accountId, sessionId, executorId)
  }

  async renewExecutionLease(accountId: string, sessionId: string, leaseId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.renewExecutionLease(accountId, sessionId, leaseId)
    return this.store.renewExecutionLease(accountId, sessionId, leaseId)
  }

  async requireExecutionLease(accountId: string, sessionId: string, leaseId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.requireExecutionLease(accountId, sessionId, leaseId)
    this.store.requireExecutionLease(accountId, sessionId, leaseId)
  }

  async releaseExecutionLease(accountId: string, sessionId: string, leaseId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.releaseExecutionLease(accountId, sessionId, leaseId)
    return this.store.releaseExecutionLease(accountId, sessionId, leaseId)
  }

  async hasExecutionLease(sessionId: string) {
    if (this.usesMysqlAccounts()) return this.mysql!.hasExecutionLease(sessionId)
    return this.store.hasExecutionLease(sessionId)
  }

  isRemote(collection: string, id: string) {
    const row = this.db.prepare('SELECT place FROM record_place WHERE collection = ? AND record_id = ?').get(collection, id) as
      | { place?: string }
      | undefined
    return row?.place === 'remote'
  }

  isLocal(collection: string, id: string) {
    const row = this.db.prepare('SELECT place FROM record_place WHERE collection = ? AND record_id = ?').get(collection, id) as
      | { place?: string }
      | undefined
    return row?.place === 'local'
  }

  markLocal(collection: string, id: string) {
    this.db
      .prepare(
        `INSERT INTO record_place (collection, record_id, place) VALUES (?, ?, 'local')
         ON CONFLICT(collection, record_id) DO UPDATE SET place = 'local'`,
      )
      .run(collection, id)
  }

  markRemote(collection: string, id: string) {
    this.db
      .prepare(
        `INSERT INTO record_place (collection, record_id, place) VALUES (?, ?, 'remote')
         ON CONFLICT(collection, record_id) DO UPDATE SET place = 'remote'`,
      )
      .run(collection, id)
  }

  clearPlace(collection: string, id: string) {
    this.db.prepare('DELETE FROM record_place WHERE collection = ? AND record_id = ?').run(collection, id)
  }

  remoteIds(collection: string) {
    const rows = this.db.prepare(`SELECT record_id FROM record_place WHERE collection = ? AND place = 'remote'`).all(collection) as Array<{
      record_id: string
    }>
    return rows.map((row) => row.record_id)
  }

  cloudConnection(localAccountId: string): CloudConnection | null {
    const row = this.db
      .prepare(
        `SELECT local_account_id, origin, remote_account_id, remote_name, remote_email, token, connected_at
         FROM cloud_connections WHERE local_account_id = ? AND active = 1
         ORDER BY connected_at DESC LIMIT 1`,
      )
      .get(localAccountId) as
      | {
          local_account_id: string
          origin: string
          remote_account_id: string
          remote_name: string
          remote_email: string
          token: string
          connected_at: number
        }
      | undefined
    return row ? this.cloudRow(row) : null
  }

  listCloudConnections(localAccountId: string): Array<CloudConnection & { active: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT local_account_id, origin, remote_account_id, remote_name, remote_email, token, connected_at, active
         FROM cloud_connections WHERE local_account_id = ?
         ORDER BY active DESC, connected_at DESC`,
      )
      .all(localAccountId) as Array<{
        local_account_id: string
        origin: string
        remote_account_id: string
        remote_name: string
        remote_email: string
        token: string
        connected_at: number
        active: number
      }>
    return rows.map((row) => ({ ...this.cloudRow(row), active: row.active === 1 }))
  }

  private cloudRow(row: {
    local_account_id: string
    origin: string
    remote_account_id: string
    remote_name: string
    remote_email: string
    token: string
    connected_at: number
  }): CloudConnection {
    return {
      localAccountId: row.local_account_id,
      origin: row.origin,
      remoteAccountId: row.remote_account_id,
      remoteName: row.remote_name,
      remoteEmail: row.remote_email,
      token: row.token,
      connectedAt: row.connected_at,
    }
  }

  saveCloudConnection(input: Omit<CloudConnection, 'connectedAt'> & { connectedAt?: number }) {
    const connectedAt = input.connectedAt ?? Date.now()
    this.db.prepare('UPDATE cloud_connections SET active = 0 WHERE local_account_id = ?').run(input.localAccountId)
    this.db
      .prepare(
        `INSERT INTO cloud_connections
          (local_account_id, origin, remote_account_id, remote_name, remote_email, token, connected_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(local_account_id, origin, remote_account_id) DO UPDATE SET
           remote_name = excluded.remote_name,
           remote_email = excluded.remote_email,
           token = excluded.token,
           connected_at = excluded.connected_at,
           active = 1`,
      )
      .run(
        input.localAccountId,
        input.origin,
        input.remoteAccountId,
        input.remoteName,
        input.remoteEmail,
        input.token,
        connectedAt,
      )
    const saved = this.cloudConnection(input.localAccountId)!
    this.syncReplicaCredential(input.localAccountId)
    return saved
  }

  /** 已关联的云端身份。当前请求没有账号时，一台设备只有一条关联也可以取到。 */
  linkedCloud(localAccountId = currentAccountId()) {
    if (localAccountId) return this.cloudConnection(localAccountId)
    const rows = this.db
      .prepare('SELECT local_account_id FROM cloud_connections WHERE active = 1')
      .all() as Array<{ local_account_id: string }>
    if (rows.length !== 1) return null
    return this.cloudConnection(rows[0]?.local_account_id ?? '')
  }

  syncReplicaCredential(localAccountId: string) {
    if (!this.replica || !localAccountId) return
    const connection = this.cloudConnection(localAccountId)
    if (!connection) return
    const active = this.store.activeWorkspaceId()
    const currentCloud = active && this.workspaceLocation(active) === 'cloud' ? active : ''
    const previous = this.replica.devices().find((item) => item.accountId === localAccountId)
    this.replica.remember({
      accountId: localAccountId,
      workspaceId: currentCloud || previous?.workspaceId || '',
      token: connection.token,
    })
  }

  /** 断开当前连接，保留已关联的云端账号和令牌。 */
  disconnectCloud(localAccountId: string) {
    this.db.prepare('UPDATE cloud_connections SET active = 0 WHERE local_account_id = ?').run(localAccountId)
    this.replica?.forget(localAccountId)
  }

  activateCloud(localAccountId: string, origin: string, remoteAccountId: string) {
    const row = this.db
      .prepare(
        `SELECT token FROM cloud_connections
         WHERE local_account_id = ? AND origin = ? AND remote_account_id = ?`,
      )
      .get(localAccountId, origin, remoteAccountId) as { token?: string } | undefined
    if (!row?.token) throw new CollabError('还没有关联这个云端账号', 404)
    this.db.prepare('UPDATE cloud_connections SET active = 0 WHERE local_account_id = ?').run(localAccountId)
    this.db
      .prepare(
        `UPDATE cloud_connections SET active = 1, connected_at = ?
         WHERE local_account_id = ? AND origin = ? AND remote_account_id = ?`,
      )
      .run(Date.now(), localAccountId, origin, remoteAccountId)
    this.syncReplicaCredential(localAccountId)
    return this.cloudConnection(localAccountId)!
  }

  removeCloudConnection(localAccountId: string) {
    this.disconnectCloud(localAccountId)
  }

  /** 删掉一条已保存的云端关联。如果删的是当前连接，同时清掉本机正在使用的云端凭证。 */
  forgetCloudConnection(localAccountId: string, origin: string, remoteAccountId: string) {
    const active = this.cloudConnection(localAccountId)
    const result = this.db
      .prepare(
        `DELETE FROM cloud_connections
         WHERE local_account_id = ? AND origin = ? AND remote_account_id = ?`,
      )
      .run(localAccountId, origin, remoteAccountId) as { changes?: number }
    if (!result.changes) throw new CollabError('还没有关联这个云端账号', 404)
    if (active?.origin === origin && active.remoteAccountId === remoteAccountId) {
      this.replica?.forget(localAccountId)
    }
  }

  workspaceLocation(workspaceId: string): 'device' | 'cloud' {
    if (isOnlineRuntime()) return 'cloud'
    const row = this.db.prepare('SELECT place FROM workspace_place WHERE workspace_id = ?').get(workspaceId) as
      | { place?: string }
      | undefined
    return row?.place === 'cloud' ? 'cloud' : 'device'
  }

  markCloudWorkspace(workspaceId: string) {
    this.db
      .prepare(
        `INSERT INTO workspace_place (workspace_id, place) VALUES (?, 'cloud')
         ON CONFLICT(workspace_id) DO UPDATE SET place = 'cloud'`,
      )
      .run(workspaceId)
  }
}

function bearer(route: RouteContext) {
  const header = String(route.req.headers.authorization ?? '')
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (match?.[1]) return match[1]
  const cookie = String(route.req.headers.cookie ?? '')
  const encoded = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('biu_account='))
  return encoded ? decodeURIComponent(encoded.slice('biu_account='.length)) : ''
}

function rememberLogin(route: RouteContext, token: string) {
  route.res.setHeader('set-cookie', `biu_account=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`)
}

function configuredRemoteOrigin() {
  if (isOnlineRuntime()) return ''
  return process.env.BIU_REMOTE_ORIGIN?.replace(/\/$/, '') || ''
}

async function relayAccount(route: RouteContext, account: AccountService, localAccountId: string, path: string) {
  const connection = account.linkedCloud(localAccountId)
  if (!connection) return null
  const activeWorkspaceId = account.store.activeWorkspaceId()
  const cloudWorkspaceId =
    activeWorkspaceId && account.workspaceLocation(activeWorkspaceId) === 'cloud' ? activeWorkspaceId : ''
  const method = route.req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const raw = hasBody ? await route.json().catch(() => ({})) : undefined
  let res: Response
  try {
    res = await fetch(`${connection.origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(cloudWorkspaceId ? { 'x-biu-workspace-id': cloudWorkspaceId } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(raw ?? {}) : undefined,
    })
  } catch {
    throw new CollabError('云端暂时连不上', 503)
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, payload }
}

function cacheWorkspaceList(account: AccountService, accountId: string, payload: Record<string, unknown>) {
  const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : []
  for (const item of workspaces) {
    if (!item || typeof item !== 'object') continue
    const row = item as { id?: string; name?: string; ownerId?: string; role?: string; createdAt?: number }
    if (!row.id) continue
    account.store.upsertPulledWorkspace({
      accountId,
      id: String(row.id),
      name: String(row.name ?? ''),
      ownerId: row.ownerId,
      role: row.role,
      createdAt: row.createdAt,
    })
    account.markCloudWorkspace(String(row.id))
  }
}

function purgeSessionEvents(sessionIds: string[]) {
  if (!sessionIds.length) return
  const path = eventsSqlitePath()
  if (!existsSync(path)) return
  const db = openSqlite(path, { foreignKeys: false })
  try {
    const stmt = db.prepare('DELETE FROM events WHERE session_id = ?')
    for (const id of sessionIds) stmt.run(id)
  } catch {
    /* 事件库还没有这张表时，空间记录本身已经删除。 */
  } finally {
    db.close()
  }
}

function fail(route: RouteContext, error: unknown) {
  if (error instanceof CollabError) {
    route.send(error.status, { error: error.message })
    return
  }
  route.send(500, { error: String(error instanceof Error ? error.message : error) })
}

export function apply(ctx: Context, config: AccountConfig = {}) {
  const account = new AccountService(ctx, config)
  const workspaceRefreshes = new Set<string>()

  function cloudStorage() {
    let storage: CloudStorageService | undefined
    try {
      storage = ctx.get('cloudStorage') as CloudStorageService | undefined
    } catch {
      /* SQLite-only installations intentionally have no cloud backup store. */
    }
    if (!storage?.privateBackups) throw new CollabError('私人云备份暂不可用', 503)
    return storage
  }

  function actor(route: RouteContext) {
    if (account.usesMysqlAccounts()) account.requireMigrated(route.req.url || 'HTTP endpoint')
    const token = bearer(route)
    const found = token ? account.store.accountByToken(token) : null
    if (!found) throw new CollabError('需要登录', 401)
    if (isOperationsRuntime() && !account.store.isOperationsOperator(found.id)) {
      throw new CollabError('没有平台运营权限', 403)
    }
    rememberLogin(route, token)
    return found
  }

  async function mysqlActor(route: RouteContext) {
    const token = bearer(route)
    if (!token || !account.mysql) throw new CollabError('需要登录', 401)
    const found = await account.mysql.accountByTokenHash(controlPlaneTokenHash(token))
    if (!found) throw new CollabError('需要登录', 401)
    if (await account.mysql.isSuspended(found.id)) throw new CollabError('账号已被暂停', 403)
    rememberLogin(route, token)
    return found
  }

  function checkedDeviceWorkspace(accountId: string, requested: unknown) {
    const workspaceId = String(requested ?? account.store.activeWorkspaceId() ?? '').trim()
    if (!workspaceId || workspaceId.length > 64) throw new CollabError('需要有效的本机 Workspace', 400)
    const owned = account.store.listWorkspaces(accountId).some((item) => item.id === workspaceId)
    if (!owned || account.workspaceLocation(workspaceId) !== 'device') {
      throw new CollabError('只能备份或恢复当前账号的本机 Workspace', 403)
    }
    return workspaceId
  }

  function failBackup(route: RouteContext, error: unknown) {
    if (
      error instanceof Error &&
      /^(invalid |backup (?:has too many items|is too large))/.test(error.message)
    ) {
      fail(route, new CollabError(error.message, 400))
      return
    }
    fail(route, error)
  }

  async function cloudBackupRequest(
    accountId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    const connection = account.cloudConnection(accountId)
    if (!connection) throw new CollabError('请先登录云端账号', 401)
    let response: Response
    try {
      response = await fetch(`${connection.origin}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${connection.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new CollabError('云端暂时连不上', 503)
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) throw new CollabError(String(payload.error ?? '云备份请求失败'), response.status)
    return payload
  }

  async function relayCloudWorkspace(
    route: RouteContext,
    localAccountId: string,
    workspaceId: string,
    path: string,
  ) {
    if (isOnlineRuntime()) return false
    if (account.workspaceLocation(workspaceId) !== 'cloud') return false
    const relayed = await relayAccount(route, account, localAccountId, path)
    if (!relayed) throw new CollabError('请先登录云端账号', 401)
    route.send(relayed.status, relayed.payload)
    return true
  }

  function requireCollaborativeWorkspace(workspaceId: string) {
    if (!workspaceId || account.workspaceLocation(workspaceId) !== 'cloud') {
      throw new CollabError('本机空间仅供当前本地账号使用，不提供成员、分享或权限功能', 404)
    }
  }

  async function connectCloudIdentity(
    local: { id: string },
    action: 'login' | 'register',
    email: string,
    password: string,
  ) {
    if (isOnlineRuntime()) throw new CollabError('服务端不能连接另一个云端账号', 400)
    const origin = configuredRemoteOrigin()
    if (!origin) throw new CollabError('还没有配置云端服务地址', 400)
    let remote: Response
    try {
      remote = await fetch(`${origin}/api/account/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    } catch {
      throw new CollabError('云端暂时连不上', 503)
    }
    const payload = (await remote.json().catch(() => ({}))) as {
      id?: string
      name?: string
      token?: string
      workspaceId?: string
      error?: string
    }
    if (!remote.ok || !payload.id || !payload.token) {
      throw new CollabError(payload.error || (action === 'login' ? '云端登录失败' : '云端注册失败'), remote.status || 400)
    }
    const connection = account.saveCloudConnection({
      localAccountId: local.id,
      origin,
      remoteAccountId: payload.id,
      remoteName: payload.name || email,
      remoteEmail: email.trim().toLowerCase(),
      token: payload.token,
    })
    let workspaces: unknown[] = []
    try {
      const listed = await fetch(`${origin}/api/account/workspaces`, {
        headers: { authorization: `Bearer ${payload.token}` },
      })
      const listedBody = (await listed.json().catch(() => ({}))) as Record<string, unknown>
      if (listed.ok) {
        cacheWorkspaceList(account, local.id, listedBody)
        workspaces = Array.isArray(listedBody.workspaces) ? listedBody.workspaces : []
      }
    } catch {
      /* 登录已经成功，空间稍后重试加载 */
    }
    const workspaceId = String(payload.workspaceId ?? '')
    if (workspaceId) {
      account.markCloudWorkspace(workspaceId)
      account.replica?.remember({ accountId: local.id, workspaceId, token: payload.token })
    }
    return {
      account: {
        id: connection.remoteAccountId,
        name: connection.remoteName,
        email: connection.remoteEmail,
      },
      workspaceId,
      workspaces,
    }
  }

  async function connectCloud(route: RouteContext, action: 'login' | 'register') {
    if (isOnlineRuntime()) throw new CollabError('服务端不能连接另一个云端账号', 400)
    const local = actor(route)
    const body = (await route.json()) as { email?: string; password?: string }
    return connectCloudIdentity(local, action, String(body.email ?? ''), String(body.password ?? ''))
  }

  ctx.http.route('GET', '/api/account/cloud', async (route) => {
    try {
      if (isOnlineRuntime()) return route.send(200, { available: false, connected: false })
      const me = actor(route)
      const connection = account.cloudConnection(me.id)
      const accounts = account.listCloudConnections(me.id).map((item) => ({
        id: item.remoteAccountId,
        name: item.remoteName,
        email: item.remoteEmail,
        origin: item.origin,
        active: item.active,
      }))
      route.send(200, {
        available: Boolean(configuredRemoteOrigin()),
        serviceOrigin: configuredRemoteOrigin(),
        connected: Boolean(connection),
        accounts,
        ...(connection
          ? {
              account: {
                id: connection.remoteAccountId,
                name: connection.remoteName,
                email: connection.remoteEmail,
              },
              origin: connection.origin,
            }
          : {}),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/cloud/login', async (route) => {
    try {
      route.send(200, await connectCloud(route, 'login'))
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/cloud/register', async (route) => {
    try {
      route.send(201, await connectCloud(route, 'register'))
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/cloud/sync-create', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('服务端不能连接另一个云端账号', 400)
      const local = actor(route)
      if (!local.email) throw new CollabError('本地账号没有可同步的邮箱', 400)
      const password = account.store.recalledPassword(local.id)
      if (!password) throw new CollabError('请退出后重新登录一次，就能用本地密码创建云端账号', 400)
      try {
        route.send(201, { ...(await connectCloudIdentity(local, 'register', local.email, password)), created: true })
      } catch (error) {
        if (!(error instanceof CollabError) || error.status !== 409) throw error
        route.send(200, { ...(await connectCloudIdentity(local, 'login', local.email, password)), created: false })
      }
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/cloud/active', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('服务端不能切换云端账号', 400)
      const me = actor(route)
      const body = (await route.json()) as { remoteAccountId?: string; origin?: string }
      const connection = account.activateCloud(me.id, String(body.origin ?? ''), String(body.remoteAccountId ?? ''))
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(200, {
        account: { id: connection.remoteAccountId, name: connection.remoteName, email: connection.remoteEmail },
        origin: connection.origin,
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/cloud', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('服务端没有云端连接可断开', 400)
      const me = actor(route)
      account.removeCloudConnection(me.id)
      route.send(200, { ok: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/cloud/saved', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('服务端没有云端连接可删除', 400)
      const me = actor(route)
      const origin = String(route.query.get('origin') ?? '').trim()
      const remoteAccountId = String(route.query.get('remoteAccountId') ?? '').trim()
      if (!origin || !remoteAccountId) throw new CollabError('需要指定要删除的云端账号', 400)
      account.forgetCloudConnection(me.id, origin, remoteAccountId)
      route.send(200, { ok: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/active', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        route.send(200, {
          workspaceId: me.activeWorkspaceId || null,
          ...(me.activeWorkspaceId ? { location: 'cloud' } : {}),
        })
        return
      }
      actor(route)
      const workspaceId = account.store.activeWorkspaceId()
      route.send(200, {
        workspaceId,
        ...(workspaceId ? { location: account.workspaceLocation(workspaceId) } : {}),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/active', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { workspaceId?: string }
        const workspaceId = String(body.workspaceId ?? '')
        if (!(await account.mysql!.setActiveWorkspace(me.id, workspaceId))) {
          throw new CollabError('不在这个空间', 403)
        }
        route.send(200, { workspaceId, location: 'cloud' })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { workspaceId?: string }
      const workspaceId = account.store.setActive(me.id, String(body.workspaceId ?? ''))
      if (account.workspaceLocation(workspaceId) === 'cloud') {
        const connection = account.cloudConnection(me.id)
        if (connection) account.replica?.remember({ accountId: me.id, workspaceId, token: connection.token })
      }
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(200, { workspaceId, location: account.workspaceLocation(workspaceId) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/register', async (route) => {
    try {
      if (isOperationsRuntime()) throw new CollabError('运营端不开放自助注册', 403)
      const body = (await route.json()) as { email?: string; password?: string }
      const password = String(body.password ?? '')
      const email = String(body.email ?? '')
      if (!password.trim()) throw new CollabError('密码不能为空', 400)
      if (!email.trim()) throw new CollabError('邮箱不能为空', 400)
      if (account.usesMysqlAccounts()) {
        if (password.trim().length < 6) throw new CollabError('密码至少 6 位', 400)
        const normalized = email.trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new CollabError('邮箱格式不对', 400)
        const now = Date.now()
        const accountId = controlPlaneId('acc')
        const workspaceId = controlPlaneId('ws')
        const sessionId = controlPlaneId('ses')
        const token = randomBytes(24).toString('hex')
        await account.mysql!.register({
          accountId,
          name: normalized,
          email: normalized,
          passwordHash: controlPlaneHashPassword(password.trim()),
          accountToken: randomBytes(24).toString('hex'),
          workspaceId,
          workspaceName: '我的工作区',
          sessionId,
          sessionTokenHash: controlPlaneTokenHash(token),
          deviceName: String(route.req.headers['user-agent'] ?? '浏览器').slice(0, 120),
          expiresAt: now + DEFAULT_SESSION_MS,
          now,
        })
        rememberLogin(route, token)
        route.send(201, { id: accountId, name: normalized, createdAt: now, token, workspaceId })
        return
      }
      const created = account.store.register('', Date.now(), password, email)
      const workspaceId = account.store.enter(created.id)
      const session = account.store.openSession(created.id, String(route.req.headers['user-agent'] ?? '浏览器').slice(0, 120))
      rememberLogin(route, session.token)
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(201, { id: created.id, name: created.name, createdAt: created.createdAt, token: session.token, workspaceId })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/login', async (route) => {
    try {
      const body = (await route.json()) as { email?: string; password?: string }
      if (account.usesMysqlAccounts()) {
        const found = await account.mysql!.accountByEmail(String(body.email ?? ''))
        if (!found?.passwordHash || !controlPlaneVerifyPassword(String(body.password ?? ''), found.passwordHash)) {
          throw new CollabError('邮箱或密码不对', 401)
        }
        if (await account.mysql!.isSuspended(found.id)) throw new CollabError('账号已被暂停', 403)
        const token = randomBytes(24).toString('hex')
        const now = Date.now()
        await account.mysql!.openSession({
          id: controlPlaneId('ses'),
          accountId: found.id,
          tokenHash: controlPlaneTokenHash(token),
          deviceName: String(route.req.headers['user-agent'] ?? '浏览器').slice(0, 120),
          expiresAt: now + DEFAULT_SESSION_MS,
          now,
        })
        const workspaces = await account.mysql!.listWorkspaces(found.id)
        const workspaceId = workspaces.some((row) => row.id === found.activeWorkspaceId)
          ? found.activeWorkspaceId
          : workspaces[0]?.id ?? ''
        if (workspaceId && workspaceId !== found.activeWorkspaceId) {
          await account.mysql!.setActiveWorkspace(found.id, workspaceId)
        }
        rememberLogin(route, token)
        route.send(200, {
          id: found.id, name: found.name, createdAt: found.createdAt, token, workspaceId,
          mustChangePassword: found.mustChangePassword,
        })
        return
      }
      const found = account.store.login(
        String(body.email ?? ''),
        String(body.password ?? ''),
        String(route.req.headers['user-agent'] ?? '浏览器'),
      )
      if (isOperationsRuntime() && !account.store.isOperationsOperator(found.id)) {
        account.store.revokeSession(found.token)
        throw new CollabError('没有平台运营权限', 403)
      }
      const workspaceId = account.store.enter(found.id)
      rememberLogin(route, found.token)
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(200, {
        id: found.id,
        name: found.name,
        createdAt: found.createdAt,
        token: found.token,
        workspaceId,
        mustChangePassword: found.mustChangePassword === true,
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/logout', async (route) => {
    const token = bearer(route)
    if (account.usesMysqlAccounts()) {
      if (token) await account.mysql!.revokeSession(controlPlaneTokenHash(token))
      route.res.setHeader('set-cookie', [
        'biu_account=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        'biu_legacy_account=; Path=/; SameSite=Strict; Max-Age=0',
      ])
      route.send(200, { ok: true })
      return
    }
    const found = token ? account.store.accountByToken(token) : null
    account.store.revokeSession(token)
    if (found) ctx.http.disconnectRevokedSessions(found.id)
    route.res.setHeader('set-cookie', [
      'biu_account=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'biu_legacy_account=; Path=/; SameSite=Strict; Max-Age=0',
    ])
    route.send(200, { ok: true })
  })

  ctx.http.route('POST', '/api/account/password', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { currentPassword?: string; nextPassword?: string }
        const next = String(body.nextPassword ?? '').trim()
        if (next.length < 6) throw new CollabError('密码至少 6 位', 400)
        if (!controlPlaneVerifyPassword(String(body.currentPassword ?? ''), me.passwordHash)) {
          throw new CollabError('当前密码不对', 401)
        }
        await account.mysql!.changePassword(
          me.id,
          controlPlaneHashPassword(next),
          controlPlaneTokenHash(bearer(route)),
        )
        ctx.http.disconnectRevokedSessions(me.id)
        route.send(200, { ok: true })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { currentPassword?: string; nextPassword?: string }
      const changed = account.store.changePassword(me.id, String(body.currentPassword ?? ''), String(body.nextPassword ?? ''), bearer(route))
      ctx.http.disconnectRevokedSessions(me.id)
      route.send(200, changed)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/sessions', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        route.send(200, { sessions: await account.mysql!.listSessions(me.id) })
        return
      }
      const me = actor(route)
      route.send(200, { sessions: account.store.listSessions(me.id) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/sessions/:id', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const sessionId = String(route.params.id ?? '')
        if (!(await account.mysql!.revokeSessionById(me.id, sessionId))) {
          throw new CollabError('会话不存在', 404)
        }
        ctx.http.disconnectRevokedSessions(me.id)
        route.send(200, { id: sessionId })
        return
      }
      const me = actor(route)
      const revoked = account.store.revokeSessionById(me.id, String(route.params.id ?? ''))
      ctx.http.disconnectRevokedSessions(me.id)
      route.send(200, revoked)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/mcp/credentials', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { workspaceId?: string; allowedTools?: unknown; expiresInHours?: unknown }
        const workspaceId = String(body.workspaceId ?? '').trim()
        if (!workspaceId) throw new CollabError('需要空间', 400)
        const hours = Math.min(24 * 365, Math.max(1, Number(body.expiresInHours ?? 24 * 90)))
        const allowedTools = Array.isArray(body.allowedTools) ? [...new Set(body.allowedTools.map(String).filter(Boolean))] : []
        const token = randomBytes(24).toString('hex')
        const credential = {
          id: controlPlaneId('mcp'),
          token,
          workspaceId,
          allowedTools,
          expiresAt: Date.now() + hours * 60 * 60 * 1000,
        }
        await account.mysql!.issueMcpCredential({
          ...credential,
          tokenHash: controlPlaneTokenHash(token),
          accountId: me.id,
          now: Date.now(),
        })
        route.send(201, credential)
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { workspaceId?: string; allowedTools?: unknown; expiresInHours?: unknown }
      const workspaceId = String(body.workspaceId ?? '').trim()
      if (!workspaceId) throw new CollabError('需要空间', 400)
      const hours = Math.min(24 * 365, Math.max(1, Number(body.expiresInHours ?? 24 * 90)))
      const allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : []
      route.send(
        201,
        account.store.issueMcpCredential(me.id, workspaceId, {
          allowedTools,
          expiresAt: Date.now() + hours * 60 * 60 * 1000,
        }),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/mcp/credentials', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = String(route.query.get('workspaceId') ?? '').trim()
        if (!workspaceId) throw new CollabError('需要空间', 400)
        route.send(200, { credentials: await account.mysql!.listMcpCredentials(me.id, workspaceId) })
        return
      }
      const me = actor(route)
      const workspaceId = String(route.query.get('workspaceId') ?? '').trim()
      if (!workspaceId) throw new CollabError('需要空间', 400)
      route.send(200, { credentials: account.store.listMcpCredentials(me.id, workspaceId) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/mcp/credentials/:id', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const credentialId = String(route.params.id ?? '')
        if (!(await account.mysql!.revokeMcpCredential(me.id, credentialId))) {
          throw new CollabError('MCP 凭证不存在', 404)
        }
        route.send(200, { id: credentialId })
        return
      }
      route.send(200, account.store.revokeMcpCredential(actor(route).id, String(route.params.id ?? '')))
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/mcp/audit', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = String(route.query.get('workspaceId') ?? '').trim()
        if (!workspaceId) throw new CollabError('需要空间', 400)
        route.send(200, {
          events: await account.mysql!.listMcpAudit(me.id, workspaceId, Number(route.query.get('limit') ?? 100)),
        })
        return
      }
      const me = actor(route)
      const workspaceId = String(route.query.get('workspaceId') ?? '').trim()
      if (!workspaceId) throw new CollabError('需要空间', 400)
      route.send(200, {
        events: account.store.listMcpAudit(me.id, workspaceId, Number(route.query.get('limit') ?? 100)),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/me', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        route.send(200, {
          id: me.id,
          name: me.name,
          email: me.email,
          createdAt: me.createdAt,
          mustChangePassword: me.mustChangePassword,
          online: true,
          operations: isOperationsRuntime(),
        })
        return
      }
      const me = actor(route)
      route.send(200, { ...me, online: isOnlineRuntime(), operations: isOperationsRuntime() })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/plugins/audit', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = String(route.query.get('workspaceId') ?? '')
        if (!workspaceId) throw new CollabError('需要空间', 400)
        route.send(200, {
          events: await account.mysql!.listPluginAudit(me.id, workspaceId, Number(route.query.get('limit') ?? 100)),
        })
        return
      }
      const me = actor(route)
      route.send(200, {
        events: account.store.listPluginAudit(
          me.id,
          String(route.query.get('workspaceId') ?? ''),
          Number(route.query.get('limit') ?? 100),
        ),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/workspace-profile', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        if (!me.activeWorkspaceId) throw new CollabError('没有工作区', 400)
        route.send(200, await account.mysql!.workspaceProfile(me.id, me.activeWorkspaceId))
        return
      }
      const me = actor(route)
      const workspaceId = account.store.activeWorkspaceId()
      if (workspaceId && (await relayCloudWorkspace(route, me.id, workspaceId, '/api/account/workspace-profile'))) return
      route.send(200, account.store.workspaceProfile(me.id))
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspace-profile', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        if (!me.activeWorkspaceId) throw new CollabError('没有工作区', 400)
        const body = (await route.json()) as { name?: unknown; avatar?: unknown }
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : undefined
        let avatar = typeof body.avatar === 'string' ? body.avatar.trim() : undefined
        if (avatar && !avatar.startsWith('data:image/')) avatar = ''
        if ((avatar?.length ?? 0) > 240_000) throw new CollabError('头像太大', 400)
        route.send(200, await account.mysql!.saveWorkspaceProfile(me.id, me.activeWorkspaceId, { name, avatar }))
        return
      }
      const me = actor(route)
      const workspaceId = account.store.activeWorkspaceId()
      if (workspaceId && (await relayCloudWorkspace(route, me.id, workspaceId, '/api/account/workspace-profile'))) return
      const body = (await route.json()) as { name?: unknown; avatar?: unknown }
      route.send(
        200,
        account.store.saveWorkspaceProfile(me.id, {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
        }),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/workspaces', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaces = (await account.mysql!.listWorkspaces(me.id))
          .map((workspace) => ({ ...workspace, location: 'cloud' as const }))
        route.send(200, { workspaces, cloudConnected: true, cloudUnavailable: false })
        return
      }
      const me = actor(route)
      const local = account.store
        .listWorkspaces(me.id)
        .filter((workspace) => account.workspaceLocation(workspace.id) === 'device')
        .map((workspace) => ({ ...workspace, location: 'device' as const }))
      const cachedCloud = () =>
        account.store
          .listWorkspaces(me.id)
          .filter((workspace) => account.workspaceLocation(workspace.id) === 'cloud')
          .map((workspace) => ({ ...workspace, location: 'cloud' as const }))
      let cloud: Array<Record<string, unknown>> = isOnlineRuntime() ? cachedCloud() : []
      if (!isOnlineRuntime() && account.cloudConnection(me.id)) {
        cloud = cachedCloud()
        if (!workspaceRefreshes.has(me.id)) {
          workspaceRefreshes.add(me.id)
          void relayAccount(route, account, me.id, '/api/account/workspaces')
            .then((relayed) => {
              if (!relayed?.status || relayed.status >= 300) return
              cacheWorkspaceList(account, me.id, relayed.payload)
              ctx.http.broadcast('account/workspaces-changed', { accountId: me.id })
            })
            .catch(() => undefined)
            .finally(() => workspaceRefreshes.delete(me.id))
        }
      }
      if (!isOnlineRuntime() && !account.cloudConnection(me.id)) {
        const active = account.store.activeWorkspaceId()
        const device = local[0]
        if (active && account.workspaceLocation(active) === 'cloud' && device) account.store.setActive(me.id, device.id)
      }
      route.send(200, {
        workspaces: [...local, ...cloud],
        cloudConnected: Boolean(account.cloudConnection(me.id)),
        cloudUnavailable: false,
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspaces', async (route) => {
    try {
      if (isOperationsRuntime()) throw new CollabError('运营端使用固定 Workspace', 403)
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { name?: string }
        const name = String(body.name ?? '').trim() || '云端空间'
        if (name.length > 40) throw new CollabError('空间名称不能超过 40 个字符', 400)
        const workspace = await account.mysql!.createWorkspace({
          id: controlPlaneId('ws'),
          ownerId: me.id,
          name,
          createdAt: Date.now(),
        })
        route.send(201, { ...workspace, location: 'cloud' })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { name?: string; location?: string }
      const name = String(body.name ?? '').trim() || (body.location === 'device' ? '本机空间' : '云端空间')
      if (isOnlineRuntime()) {
        const workspace = account.store.createWorkspace(me.id, name)
        route.send(201, { ...workspace, location: 'cloud' })
        return
      }
      if (body.location === 'cloud') {
        const connection = account.cloudConnection(me.id)
        if (!connection) throw new CollabError('请先登录云端账号', 401)
        let response: Response
        try {
          response = await fetch(`${connection.origin}/api/account/workspaces`, {
            method: 'POST',
            headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name, location: 'cloud' }),
          })
        } catch {
          throw new CollabError('云端暂时连不上', 503)
        }
        const payload = (await response.json().catch(() => ({}))) as {
          id?: string
          name?: string
          ownerId?: string
          role?: string
          createdAt?: number
          error?: string
        }
        if (!response.ok || !payload.id) throw new CollabError(payload.error || '创建云端空间失败', response.status)
        account.store.upsertPulledWorkspace({
          accountId: me.id,
          id: payload.id,
          name: String(payload.name ?? name),
          ownerId: payload.ownerId,
          role: payload.role || 'owner',
          createdAt: payload.createdAt,
        })
        account.markCloudWorkspace(payload.id)
        account.store.setActive(me.id, payload.id)
        account.replica?.remember({ accountId: me.id, workspaceId: payload.id, token: connection.token })
        route.send(201, { ...payload, location: 'cloud' })
        return
      }
      const workspace = account.store.createWorkspace(me.id, name)
      route.send(201, { ...workspace, location: 'device' })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('PATCH', '/api/account/workspaces/:id', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { name?: string }
        const name = String(body.name ?? '').trim()
        if (!name) throw new CollabError('空间名称不能为空', 400)
        if (name.length > 40) throw new CollabError('空间名称不能超过 40 个字符', 400)
        const workspace = await account.mysql!.renameWorkspace(me.id, route.params.id!, name)
        ctx.http.broadcastWorkspace(route.params.id!, 'workspace/changed', {
          workspaceId: route.params.id!,
          name: workspace.name,
        })
        route.send(200, { ...workspace, location: 'cloud' })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { name?: string }
      const workspaceId = route.params.id!
      if (!isOnlineRuntime() && account.workspaceLocation(workspaceId) === 'cloud') {
        const connection = account.cloudConnection(me.id)
        if (!connection) throw new CollabError('请先登录云端账号', 401)
        let response: Response
        try {
          response = await fetch(`${connection.origin}/api/account/workspaces/${workspaceId}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          throw new CollabError('云端暂时连不上', 503)
        }
        const payload = (await response.json().catch(() => ({}))) as {
          id?: string
          name?: string
          ownerId?: string
          role?: string
          createdAt?: number
          error?: string
        }
        if (!response.ok || !payload.id) throw new CollabError(payload.error || '重命名云端空间失败', response.status)
        account.store.upsertPulledWorkspace({
          accountId: me.id,
          id: payload.id,
          name: String(payload.name ?? ''),
          ownerId: payload.ownerId,
          role: payload.role,
          createdAt: payload.createdAt,
        })
        ctx.http.broadcastWorkspace(workspaceId, 'workspace/changed', {
          workspaceId,
          name: String(payload.name ?? ''),
        })
        route.send(200, { ...payload, location: 'cloud' })
        return
      }
      const workspace = account.store.renameWorkspace(me.id, workspaceId, String(body.name ?? ''))
      ctx.http.broadcastWorkspace(workspaceId, 'workspace/changed', {
        workspaceId,
        name: workspace.name,
      })
      route.send(200, {
        ...workspace,
        location: account.workspaceLocation(workspaceId),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/workspaces/:id', async (route) => {
    try {
      if (isOperationsRuntime() || route.params.id === 'ws_operations') throw new CollabError('不能删除运营 Workspace', 403)
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json().catch(() => ({}))) as { name?: string }
        const deleted = await account.mysql!.deleteWorkspace(me.id, route.params.id!, String(body.name ?? ''))
        account.forgetPluginAccess({ workspaceId: route.params.id! })
        route.send(200, {
          id: deleted.id,
          deleted: true,
          activeWorkspaceId: deleted.activeWorkspaceId,
        })
        return
      }
      const me = actor(route)
      const body = (await route.json().catch(() => ({}))) as { name?: string }
      const confirmName = String(body.name ?? '')
      const workspaceId = route.params.id!
      if (!isOnlineRuntime() && account.workspaceLocation(workspaceId) === 'cloud') {
        const connection = account.cloudConnection(me.id)
        if (!connection) throw new CollabError('请先登录云端账号', 401)
        let response: Response
        try {
          response = await fetch(`${connection.origin}/api/account/workspaces/${workspaceId}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: confirmName }),
          })
        } catch {
          throw new CollabError('云端暂时连不上', 503)
        }
        const payload = (await response.json().catch(() => ({}))) as { error?: string; activeWorkspaceId?: string }
        if (!response.ok) throw new CollabError(payload.error || '删除云端空间失败', response.status)
      }
      const deleted = account.store.deleteWorkspace(me.id, workspaceId, confirmName)
      account.forgetPluginAccess({ workspaceId })
      purgeSessionEvents(deleted.sessionIds)
      route.send(200, { id: deleted.id, deleted: true, activeWorkspaceId: deleted.activeWorkspaceId })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/workspaces/:id/members', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        route.send(200, { members: await account.mysql!.members(me.id, route.params.id!) })
        return
      }
      const me = actor(route)
      if (await relayCloudWorkspace(route, me.id, route.params.id!, `/api/account/workspaces/${route.params.id}/members`)) return
      requireCollaborativeWorkspace(route.params.id!)
      route.send(200, { members: account.store.members(me.id, route.params.id!) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspaces/:id/members', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { email?: string; accountId?: string }
        const members = String(body.email ?? '').trim()
          ? await account.mysql!.addMemberByEmail(me.id, route.params.id!, String(body.email))
          : await account.mysql!.addMember(me.id, route.params.id!, String(body.accountId ?? ''))
        if (!members) throw new CollabError('没有这个邮箱，对方需要先注册', 404)
        route.send(200, { members })
        return
      }
      const me = actor(route)
      if (await relayCloudWorkspace(route, me.id, route.params.id!, `/api/account/workspaces/${route.params.id}/members`)) return
      requireCollaborativeWorkspace(route.params.id!)
      const body = (await route.json()) as { accountId?: string; email?: string }
      const email = String(body.email ?? '').trim()
      const members = email
        ? account.store.addMemberByEmail(me.id, route.params.id!, email)
        : account.store.addMember(me.id, route.params.id!, String(body.accountId ?? ''))
      route.send(200, { members })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspaces/:id/invites', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { role?: string; expiresInHours?: number }
        const role = body.role === 'member' ? 'member' : 'viewer'
        const now = Date.now()
        const token = controlPlaneInviteToken()
        const invite = {
          id: controlPlaneId('inv'),
          token,
          workspaceId: route.params.id!,
          kind: 'workspace' as const,
          role,
          expiresAt: now + Math.max(1, Math.min(24 * 30, Number(body.expiresInHours ?? 168))) * 60 * 60 * 1000,
        }
        await account.mysql!.createInvite({
          id: invite.id,
          tokenHash: controlPlaneTokenHash(token),
          workspaceId: invite.workspaceId,
          role,
          expiresAt: invite.expiresAt,
          actorId: me.id,
          now,
        })
        route.send(201, { ...invite, path: `/?workspaceInvite=${encodeURIComponent(token)}` })
        return
      }
      const me = actor(route)
      if (await relayCloudWorkspace(route, me.id, route.params.id!, `/api/account/workspaces/${route.params.id}/invites`)) return
      requireCollaborativeWorkspace(route.params.id!)
      const body = (await route.json()) as { role?: string; expiresInHours?: number }
      const role = body.role === 'member' ? 'member' : 'viewer'
      const invite = account.store.createWorkspaceInvite(
        me.id,
        route.params.id!,
        role,
        Number(body.expiresInHours ?? 168),
      )
      route.send(201, {
        ...invite,
        path: `/?workspaceInvite=${encodeURIComponent(invite.token)}`,
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/workspaces/:id/invites/:inviteId', async (route) => {
    try {
      if (!account.usesMysqlAccounts()) account.requireMigrated('DELETE workspace invite')
      const me = await mysqlActor(route)
      await account.mysql!.revokeInvite(me.id, route.params.id!, route.params.inviteId!)
      route.send(200, { id: route.params.inviteId, revoked: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/invites/:token/accept', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const result = await account.mysql!.acceptInvite(
          me.id,
          controlPlaneTokenHash(route.params.token!),
        )
        ctx.http.broadcast('database', { ts: Date.now() })
        route.send(200, result)
        return
      }
      const me = actor(route)
      const connection = !isOnlineRuntime() ? account.cloudConnection(me.id) : null
      if (connection) {
        const relayed = await relayAccount(route, account, me.id, `/api/account/invites/${route.params.token}/accept`)
        if (!relayed) throw new CollabError('请先登录云端账号', 401)
        if (relayed.status < 300) {
          try {
            const listed = await fetch(`${connection.origin}/api/account/workspaces`, {
              headers: { authorization: `Bearer ${connection.token}` },
            })
            const payload = (await listed.json().catch(() => ({}))) as Record<string, unknown>
            if (listed.ok) cacheWorkspaceList(account, me.id, payload)
          } catch {
            /* 接受已经成功，空间列表稍后刷新 */
          }
        }
        route.send(relayed.status, relayed.payload)
        return
      }
      if (!isOnlineRuntime()) throw new CollabError('本机空间不提供成员邀请', 403)
      const result = account.store.acceptWorkspaceInvite(me.id, route.params.token!)
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(200, result)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/guest-invites/:token/accept', async (route) => {
    try {
      if (!isOnlineRuntime()) throw new CollabError('本机空间不提供访客邀请', 403)
      if (account.usesMysqlAccounts()) {
        const body = (await route.json()) as { name?: string }
        const accountId = controlPlaneId('guest')
        const sessionId = controlPlaneId('gss')
        const token = randomBytes(24).toString('hex')
        const name = String(body.name ?? '').trim().slice(0, 40) || `临时访客-${accountId.slice(-4)}`
        const result = await account.mysql!.acceptGuestInvite({
          tokenHash: controlPlaneTokenHash(route.params.token!),
          accountId,
          sessionId,
          sessionTokenHash: controlPlaneTokenHash(token),
          legacyToken: randomBytes(24).toString('hex'),
          name,
          now: Date.now(),
        })
        rememberLogin(route, token)
        route.send(200, { ...result, token })
        return
      }
      const body = (await route.json()) as { name?: string }
      const result = account.store.acceptGuestInvite(route.params.token!, String(body.name ?? ''))
      rememberLogin(route, result.token)
      ctx.http.broadcast('database', { ts: Date.now() })
      route.send(200, result)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/workspaces/:id/members/:accountId', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        await account.mysql!.removeMember(me.id, route.params.id!, route.params.accountId!)
        account.forgetPluginAccess({ accountId: route.params.accountId!, workspaceId: route.params.id! })
        ctx.http.disconnectTenant(route.params.accountId!, route.params.id!)
        route.send(200, { members: await account.mysql!.members(me.id, route.params.id!) })
        return
      }
      const me = actor(route)
      if (
        await relayCloudWorkspace(
          route,
          me.id,
          route.params.id!,
          `/api/account/workspaces/${route.params.id}/members/${route.params.accountId}`,
        )
      ) return
      requireCollaborativeWorkspace(route.params.id!)
      account.store.removeMember(me.id, route.params.id!, route.params.accountId!)
      account.forgetPluginAccess({ accountId: route.params.accountId!, workspaceId: route.params.id! })
      ctx.http.disconnectTenant(route.params.accountId!, route.params.id!)
      route.send(200, { members: account.store.members(me.id, route.params.id!) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('PATCH', '/api/account/workspaces/:id/members/:accountId', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { role?: string }
        const role = String(body.role ?? '')
        if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') {
          throw new CollabError('角色只能是 owner、admin、member 或 viewer', 400)
        }
        await account.mysql!.updateMemberRole(me.id, route.params.id!, route.params.accountId!, role)
        account.forgetPluginAccess({ accountId: route.params.accountId!, workspaceId: route.params.id! })
        route.send(200, { members: await account.mysql!.members(me.id, route.params.id!) })
        return
      }
      const me = actor(route)
      if (
        await relayCloudWorkspace(
          route,
          me.id,
          route.params.id!,
          `/api/account/workspaces/${route.params.id}/members/${route.params.accountId}`,
        )
      ) return
      requireCollaborativeWorkspace(route.params.id!)
      const body = (await route.json()) as { role?: string }
      const role = String(body.role ?? '')
      if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') {
        throw new CollabError('角色只能是 owner、admin、member 或 viewer', 400)
      }
      account.store.updateMemberRole(me.id, route.params.id!, route.params.accountId!, role)
      account.forgetPluginAccess({ accountId: route.params.accountId!, workspaceId: route.params.id! })
      route.send(200, { members: account.store.members(me.id, route.params.id!) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/workspaces/:id/groups', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        route.send(200, { groups: await account.mysql!.groups(me.id, route.params.id!) })
        return
      }
      const me = actor(route)
      if (await relayCloudWorkspace(route, me.id, route.params.id!, `/api/account/workspaces/${route.params.id}/groups`)) return
      requireCollaborativeWorkspace(route.params.id!)
      route.send(200, { groups: account.store.groups(me.id, route.params.id!) })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspaces/:id/groups', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { name?: string }
        const name = String(body.name ?? '').trim()
        if (!name) throw new CollabError('组名不能为空', 400)
        const group = {
          id: controlPlaneId('grp'),
          workspaceId: route.params.id!,
          name,
          createdBy: me.id,
          createdAt: Date.now(),
        }
        await account.mysql!.createGroup({
          id: group.id,
          actorId: me.id,
          workspaceId: group.workspaceId,
          name,
          now: group.createdAt,
        })
        route.send(201, group)
        return
      }
      const me = actor(route)
      if (await relayCloudWorkspace(route, me.id, route.params.id!, `/api/account/workspaces/${route.params.id}/groups`)) return
      requireCollaborativeWorkspace(route.params.id!)
      const body = (await route.json()) as { name?: string }
      route.send(201, account.store.createGroup(me.id, route.params.id!, String(body.name ?? '')))
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/workspaces/:id/groups/:groupId/members', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { email?: string }
        const target = await account.mysql!.accountByEmail(String(body.email ?? ''))
        if (!target) throw new CollabError('没有这个邮箱，对方需要先注册', 404)
        await account.mysql!.addGroupMember(me.id, route.params.id!, route.params.groupId!, target.id)
        route.send(200, {
          members: await account.mysql!.groupMembers(me.id, route.params.id!, route.params.groupId!),
        })
        return
      }
      const me = actor(route)
      if (
        await relayCloudWorkspace(
          route,
          me.id,
          route.params.id!,
          `/api/account/workspaces/${route.params.id}/groups/${route.params.groupId}/members`,
        )
      ) return
      requireCollaborativeWorkspace(route.params.id!)
      const body = (await route.json()) as { email?: string }
      route.send(
        200,
        {
          members: account.store.addGroupMemberByEmail(
            me.id,
            route.params.id!,
            route.params.groupId!,
            String(body.email ?? ''),
          ),
        },
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/workspaces/:id/groups/:groupId/members', async (route) => {
    try {
      if (!account.usesMysqlAccounts()) account.requireMigrated('GET group members')
      const me = await mysqlActor(route)
      route.send(200, {
        members: await account.mysql!.groupMembers(me.id, route.params.id!, route.params.groupId!),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('PATCH', '/api/account/workspaces/:id/groups/:groupId', async (route) => {
    try {
      if (!account.usesMysqlAccounts()) account.requireMigrated('PATCH group')
      const me = await mysqlActor(route)
      const body = (await route.json()) as { name?: string }
      const name = String(body.name ?? '').trim()
      if (!name) throw new CollabError('组名不能为空', 400)
      await account.mysql!.renameGroup(me.id, route.params.id!, route.params.groupId!, name)
      route.send(200, { id: route.params.groupId, name })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/workspaces/:id/groups/:groupId', async (route) => {
    try {
      if (!account.usesMysqlAccounts()) account.requireMigrated('DELETE group')
      const me = await mysqlActor(route)
      await account.mysql!.deleteGroup(me.id, route.params.id!, route.params.groupId!)
      route.send(200, { id: route.params.groupId, deleted: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/workspaces/:id/groups/:groupId/members/:accountId', async (route) => {
    try {
      if (!account.usesMysqlAccounts()) account.requireMigrated('DELETE group member')
      const me = await mysqlActor(route)
      await account.mysql!.removeGroupMember(
        me.id,
        route.params.id!,
        route.params.groupId!,
        route.params.accountId!,
      )
      route.send(200, {
        members: await account.mysql!.groupMembers(me.id, route.params.id!, route.params.groupId!),
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/access', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = me.activeWorkspaceId
        if (!workspaceId) throw new CollabError('没有工作区', 400)
        const collection = String(route.query.get('collection') ?? '')
        const viewId = String(route.query.get('viewId') ?? '')
        route.send(
          200,
          viewId
            ? await account.mysql!.viewAccess(me.id, workspaceId, collection, viewId)
            : await account.mysql!.recordAccess(
                me.id,
                workspaceId,
                collection,
                String(route.query.get('recordId') ?? ''),
              ),
        )
        return
      }
      const me = actor(route)
      const activeWorkspace = account.store.activeWorkspaceId()
      if (
        activeWorkspace &&
        (await relayCloudWorkspace(
          route,
          me.id,
          activeWorkspace,
          `/api/account/access${route.query.toString() ? `?${route.query.toString()}` : ''}`,
        ))
      ) return
      requireCollaborativeWorkspace(activeWorkspace ?? '')
      const collection = String(route.query.get('collection') ?? '')
      const viewId = String(route.query.get('viewId') ?? '')
      route.send(
        200,
        viewId
          ? account.store.viewAccess(me.id, collection, viewId)
          : account.store.recordAccess(me.id, collection, String(route.query.get('recordId') ?? '')),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/access', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as {
          collection?: string; recordId?: string; viewId?: string; email?: string;
          groupId?: string; memberViewId?: string; role?: ResourceRole;
          collaboratorKind?: 'internal' | 'external'
        }
        const workspaceId = me.activeWorkspaceId
        if (!workspaceId) throw new CollabError('没有工作区', 400)
        const collection = String(body.collection ?? '')
        const role: ResourceRole =
          body.role === 'viewer' || body.role === 'manager' || body.role === 'owner' ? body.role : 'editor'
        const collaboratorKind = body.collaboratorKind === 'internal' ? 'internal' : 'external'
        if (body.viewId) {
          if (body.memberViewId) {
            await account.mysql!.grantView({
              actorId: me.id,
              workspaceId,
              collection,
              viewId: String(body.viewId),
              subjectType: 'member_view',
              subjectId: String(body.memberViewId),
              role,
              now: Date.now(),
            })
          } else {
            const target = await account.mysql!.shareViewWithEmail({
              actorId: me.id,
              workspaceId,
              collection,
              viewId: String(body.viewId),
              email: String(body.email ?? ''),
              role,
              collaboratorKind,
              now: Date.now(),
            })
            if (!target) throw new CollabError('没有这个邮箱，对方需要先注册', 404)
          }
          route.send(200, await account.mysql!.viewAccess(me.id, workspaceId, collection, String(body.viewId)))
          return
        }
        let subjectType: 'account' | 'group' | 'member_view'
        let subjectId: string
        if (body.memberViewId) {
          subjectType = 'member_view'
          subjectId = String(body.memberViewId)
        } else if (body.groupId) {
          subjectType = 'group'
          subjectId = String(body.groupId)
        } else {
          const target = await account.mysql!.shareRecordWithEmail({
            actorId: me.id,
            workspaceId,
            collection,
            recordId: String(body.recordId ?? ''),
            email: String(body.email ?? ''),
            role,
            collaboratorKind,
            now: Date.now(),
          })
          if (!target) throw new CollabError('没有这个邮箱，对方需要先注册', 404)
          route.send(200, await account.mysql!.recordAccess(
            me.id,
            workspaceId,
            collection,
            String(body.recordId ?? ''),
          ))
          return
        }
        await account.mysql!.grantRecord({
          actorId: me.id,
          workspaceId,
          collection,
          recordId: String(body.recordId ?? ''),
          subjectType,
          subjectId,
          role,
          now: Date.now(),
        })
        route.send(200, await account.mysql!.recordAccess(
          me.id,
          workspaceId,
          collection,
          String(body.recordId ?? ''),
        ))
        return
      }
      const me = actor(route)
      const activeWorkspace = account.store.activeWorkspaceId()
      if (activeWorkspace && (await relayCloudWorkspace(route, me.id, activeWorkspace, '/api/account/access'))) return
      requireCollaborativeWorkspace(activeWorkspace ?? '')
      const body = (await route.json()) as {
        collection?: string
        recordId?: string
        viewId?: string
        email?: string
        groupId?: string
        memberViewId?: string
        role?: ResourceRole
        collaboratorKind?: 'internal' | 'external'
      }
      const collection = String(body.collection ?? '')
      const recordId = String(body.recordId ?? '')
      const viewId = String(body.viewId ?? '')
      const role: ResourceRole =
        body.role === 'viewer' || body.role === 'manager' || body.role === 'owner' ? body.role : 'editor'
      const kind = body.collaboratorKind === 'internal' ? 'internal' : 'external'
      route.send(
        200,
        viewId
          ? body.memberViewId
            ? account.store.grantViewMemberView(me.id, collection, viewId, String(body.memberViewId), role)
            : account.store.shareViewWithEmail(me.id, collection, viewId, String(body.email ?? ''), role, kind)
          : body.memberViewId
          ? account.store.grantMemberView(me.id, collection, recordId, String(body.memberViewId), role)
          : body.groupId
          ? account.store.grantGroup(me.id, collection, recordId, String(body.groupId), role)
          : account.store.shareWithEmail(me.id, collection, recordId, String(body.email ?? ''), role, kind),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/access', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as {
          collection?: string; recordId?: string; viewId?: string;
          subjectType?: 'account' | 'group' | 'member_view'; subjectId?: string
        }
        const workspaceId = me.activeWorkspaceId
        if (!workspaceId) throw new CollabError('没有工作区', 400)
        const collection = String(body.collection ?? '')
        const subjectType =
          body.subjectType === 'group' || body.subjectType === 'member_view' ? body.subjectType : 'account'
        if (body.viewId) {
          await account.mysql!.revokeView({
            actorId: me.id,
            workspaceId,
            collection,
            viewId: String(body.viewId),
            subjectType: subjectType === 'member_view' ? 'member_view' : 'account',
            subjectId: String(body.subjectId ?? ''),
          })
          route.send(200, await account.mysql!.viewAccess(
            me.id,
            workspaceId,
            collection,
            String(body.viewId),
          ))
          return
        }
        await account.mysql!.revokeRecordGrant({
          actorId: me.id,
          workspaceId,
          collection,
          recordId: String(body.recordId ?? ''),
          subjectType,
          subjectId: String(body.subjectId ?? ''),
        })
        route.send(200, await account.mysql!.recordAccess(
          me.id,
          workspaceId,
          collection,
          String(body.recordId ?? ''),
        ))
        return
      }
      const me = actor(route)
      const activeWorkspace = account.store.activeWorkspaceId()
      if (activeWorkspace && (await relayCloudWorkspace(route, me.id, activeWorkspace, '/api/account/access'))) return
      requireCollaborativeWorkspace(activeWorkspace ?? '')
      const body = (await route.json()) as {
        collection?: string
        recordId?: string
        viewId?: string
        subjectType?: 'account' | 'group' | 'member_view'
        subjectId?: string
      }
      const viewId = String(body.viewId ?? '')
      const subjectType =
        body.subjectType === 'group' || body.subjectType === 'member_view' ? body.subjectType : 'account'
      route.send(
        200,
        viewId
          ? account.store.revokeViewGrant(
              me.id,
              String(body.collection ?? ''),
              viewId,
              subjectType === 'member_view' ? 'member_view' : 'account',
              String(body.subjectId ?? ''),
            )
          : account.store.revokeRecordGrant(
              me.id,
              String(body.collection ?? ''),
              String(body.recordId ?? ''),
              subjectType,
              String(body.subjectId ?? ''),
            ),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/access/guest-invite', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = me.activeWorkspaceId
        if (!workspaceId) throw new CollabError('没有工作区', 400)
        const body = (await route.json()) as {
          collection?: string; recordId?: string; viewId?: string; role?: string; expiresInHours?: number
        }
        const token = controlPlaneInviteToken()
        const now = Date.now()
        const invite = {
          id: controlPlaneId('inv'),
          token,
          workspaceId,
          kind: 'guest' as const,
          collection: String(body.collection ?? ''),
          recordId: String(body.viewId ?? '') ? '' : String(body.recordId ?? ''),
          viewId: String(body.viewId ?? ''),
          role: body.role === 'editor' ? 'editor' as const : 'viewer' as const,
          expiresAt: now + Math.max(1, Math.min(24 * 30, Number(body.expiresInHours ?? 24))) * 60 * 60 * 1000,
        }
        await account.mysql!.createGuestInvite({
          id: invite.id,
          tokenHash: controlPlaneTokenHash(token),
          actorId: me.id,
          workspaceId,
          collection: invite.collection,
          recordId: invite.recordId,
          viewId: invite.viewId,
          role: invite.role,
          expiresAt: invite.expiresAt,
          now,
        })
        route.send(201, { ...invite, path: `/?guestInvite=${encodeURIComponent(token)}` })
        return
      }
      const me = actor(route)
      const activeWorkspace = account.store.activeWorkspaceId()
      if (
        activeWorkspace &&
        (await relayCloudWorkspace(route, me.id, activeWorkspace, '/api/account/access/guest-invite'))
      ) return
      requireCollaborativeWorkspace(activeWorkspace ?? '')
      const body = (await route.json()) as {
        collection?: string
        recordId?: string
        viewId?: string
        role?: string
        expiresInHours?: number
      }
      const invite = account.store.createGuestInvite(
        me.id,
        String(body.collection ?? ''),
        String(body.recordId ?? ''),
        body.role === 'editor' ? 'editor' : 'viewer',
        Number(body.expiresInHours ?? 24),
        Date.now(),
        String(body.viewId ?? ''),
      )
      route.send(201, {
        ...invite,
        path: `/?guestInvite=${encodeURIComponent(invite.token)}`,
      })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/records/claim', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
        const workspaceId = String(body.workspaceId ?? '')
        const collection = String(body.collection ?? '')
        const recordId = String(body.recordId ?? '')
        await account.mysql!.claimRecord({ actorId: me.id, workspaceId, collection, recordId, now: Date.now() })
        route.send(200, { workspaceId, collection, recordId, ownerId: me.id, version: 0 })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
      route.send(
        200,
        account.store.claim(me.id, String(body.workspaceId ?? ''), String(body.collection ?? ''), String(body.recordId ?? '')),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/sync', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as {
          workspaceId?: string; collection?: string; recordId?: string; field?: string;
          value?: unknown; expectedVersion?: number
        }
        const op = await account.mysql!.sync({
          actorId: me.id,
          workspaceId: String(body.workspaceId ?? ''),
          collection: String(body.collection ?? ''),
          recordId: String(body.recordId ?? ''),
          field: String(body.field ?? ''),
          value: body.value,
          expectedVersion: Number(body.expectedVersion ?? 0),
          now: Date.now(),
        })
        route.send(200, op)
        return
      }
      const me = actor(route)
      const body = (await route.json()) as {
        workspaceId?: string
        collection?: string
        recordId?: string
        field?: string
        value?: unknown
        expectedVersion?: number
      }
      const op = account.store.sync({
        actorId: me.id,
        workspaceId: String(body.workspaceId ?? ''),
        collection: String(body.collection ?? ''),
        recordId: String(body.recordId ?? ''),
        field: String(body.field ?? ''),
        value: body.value,
        expectedVersion: Number(body.expectedVersion ?? 0),
      })
      route.send(200, op)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/private-backups', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      if (!isOnlineRuntime()) throw new CollabError('本机请使用显式 publish API', 405)
      const contentLength = Number(route.req.headers['content-length'] ?? 0)
      if (contentLength > MAX_PRIVATE_BACKUP_BYTES + 64 * 1024) {
        throw new CollabError('backup is too large', 413)
      }
      const body = (await route.json()) as {
        name?: string
        sourceDeviceId?: string
        workspaceId?: string
        snapshot?: MirrorSnapshot
      }
      const backup = await cloudStorage().createPrivateBackup(me.id, {
        name: String(body.name ?? ''),
        sourceDeviceId: String(body.sourceDeviceId ?? ''),
        workspaceId: String(body.workspaceId ?? ''),
        snapshot: body.snapshot as MirrorSnapshot,
      })
      route.send(201, backup)
    } catch (error) {
      failBackup(route, error)
    }
  })

  ctx.http.route('GET', '/api/private-backups', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      if (!isOnlineRuntime()) {
        route.send(200, await cloudBackupRequest(me.id, '/api/private-backups'))
        return
      }
      route.send(200, { backups: await cloudStorage().listPrivateBackups(me.id) })
    } catch (error) {
      failBackup(route, error)
    }
  })

  ctx.http.route('GET', '/api/private-backups/:id', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      const id = String(route.params.id ?? '')
      if (!isOnlineRuntime()) {
        route.send(200, await cloudBackupRequest(me.id, `/api/private-backups/${encodeURIComponent(id)}`))
        return
      }
      const backup = await cloudStorage().readPrivateBackup(me.id, id)
      if (!backup) throw new CollabError('备份不存在', 404)
      route.send(200, backup)
    } catch (error) {
      failBackup(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/private-backups/:id', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      const id = String(route.params.id ?? '')
      if (!isOnlineRuntime()) {
        await cloudBackupRequest(me.id, `/api/private-backups/${encodeURIComponent(id)}`, { method: 'DELETE' })
        route.send(200, { id, deleted: true })
        return
      }
      if (!(await cloudStorage().deletePrivateBackup(me.id, id))) {
        throw new CollabError('备份不存在', 404)
      }
      route.send(200, { id, deleted: true })
    } catch (error) {
      failBackup(route, error)
    }
  })

  ctx.http.route('POST', '/api/private-backups/publish', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('publish 仅用于本机 Workspace', 405)
      const me = actor(route)
      const body = (await route.json()) as { name?: string; sourceDeviceId?: string; workspaceId?: string }
      const workspaceId = checkedDeviceWorkspace(me.id, body.workspaceId)
      const name = String(body.name ?? '').trim()
      const sourceDeviceId = String(body.sourceDeviceId ?? '').trim()
      if (!name || name.length > 255) throw new CollabError('需要有效的备份名称', 400)
      if (!sourceDeviceId || sourceDeviceId.length > 64) throw new CollabError('需要有效的设备 ID', 400)
      const snapshot = await runWithRequestWorkspace(workspaceId, () => takeSnapshot(ctx, { includeAssets: true }))
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PRIVATE_BACKUP_BYTES) {
        throw new CollabError('backup is too large', 413)
      }
      const backup = await cloudBackupRequest(me.id, '/api/private-backups', {
        method: 'POST',
        body: { name, sourceDeviceId, workspaceId, snapshot },
      })
      route.send(201, backup)
    } catch (error) {
      failBackup(route, error)
    }
  })

  ctx.http.route('POST', '/api/private-backups/:id/restore', async (route) => {
    try {
      if (isOnlineRuntime()) throw new CollabError('restore 仅用于本机 Workspace', 405)
      const me = actor(route)
      const body = (await route.json().catch(() => ({}))) as { workspaceId?: string }
      const workspaceId = checkedDeviceWorkspace(me.id, body.workspaceId)
      const backup = await cloudBackupRequest(
        me.id,
        `/api/private-backups/${encodeURIComponent(String(route.params.id ?? ''))}`,
      )
      const snapshot = backup.snapshot as MirrorSnapshot | undefined
      if (!snapshot) throw new CollabError('云端备份内容无效', 502)
      const result = await runWithRequestWorkspace(workspaceId, () => restoreSnapshotSafely(ctx, snapshot))
      if (!result.restored) {
        route.send(409, { error: '备份预检失败，未恢复任何内容', ...result })
        return
      }
      route.send(200, { ...result, workspaceId })
    } catch (error) {
      failBackup(route, error)
    }
  })

  const snapshotInFlight = new Map<string, Promise<MirrorSnapshot>>()

  ctx.http.route('GET', '/api/replica/snapshot', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      const since = Math.max(0, Number(route.query.get('since') ?? 0) || 0)
      const workspaceId = account.usesMysqlAccounts()
        ? String(route.req.headers['x-biu-workspace-id'] ?? ('activeWorkspaceId' in me ? me.activeWorkspaceId : '') ?? '')
        : account.store.activeWorkspaceId() ?? ''
      if (account.usesMysqlAccounts()) {
        const allowed = (await account.mysql!.listWorkspaces(me.id)).some((item) => item.id === workspaceId)
        if (!allowed) throw new CollabError('不在这个空间', 403)
      }
      const flightKey = `${me.id}\t${workspaceId}\t${since}`
      let pending = snapshotInFlight.get(flightKey)
      if (!pending) {
        pending = runWithRequestWorkspace(
          workspaceId,
          () => takeSnapshot(ctx, since > 0 ? { since } : undefined),
        ).finally(() => {
          snapshotInFlight.delete(flightKey)
        })
        snapshotInFlight.set(flightKey, pending)
      }
      route.send(200, await pending)
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/replica/snapshot', async (route) => {
    try {
      const me = account.usesMysqlAccounts() ? await mysqlActor(route) : actor(route)
      const workspaceId = account.usesMysqlAccounts()
        ? String(route.req.headers['x-biu-workspace-id'] ?? ('activeWorkspaceId' in me ? me.activeWorkspaceId : '') ?? '')
        : ''
      if (account.usesMysqlAccounts()) {
        const allowed = (await account.mysql!.listWorkspaces(me.id)).some((item) => item.id === workspaceId)
        if (!allowed) throw new CollabError('不在这个空间', 403)
      }
      const body = (await route.json()) as MirrorSnapshot
      if (workspaceId) await runWithRequestWorkspace(workspaceId, () => applySnapshot(ctx, body, 'adopt'))
      else await applySnapshot(ctx, body, 'adopt')
      route.send(200, { ok: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('GET', '/api/account/sync', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const workspaceId = String(route.query.get('workspaceId') ?? '')
        const ops = await account.mysql!.opsSince(
          me.id,
          workspaceId,
          Number(route.query.get('after') ?? 0),
          route.query.get('visible') === '1',
        )
        route.send(200, { ops })
        return
      }
      const me = actor(route)
      const workspaceId = String(route.query.get('workspaceId') ?? '')
      const after = Number(route.query.get('after') ?? 0)
      const ops =
        route.query.get('visible') === '1'
          ? account.store.visibleOpsSince(me.id, workspaceId, after)
          : account.store.opsSince(me.id, workspaceId, after)
      route.send(200, { ops })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/locks', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as {
          workspaceId?: string; collection?: string; recordId?: string; ttlMs?: number
        }
        route.send(200, await account.mysql!.acquireLock({
          actorId: me.id,
          workspaceId: String(body.workspaceId ?? ''),
          collection: String(body.collection ?? ''),
          recordId: String(body.recordId ?? ''),
          ttlMs: Number(body.ttlMs ?? 60_000),
          now: Date.now(),
        }))
        return
      }
      const me = actor(route)
      const body = (await route.json()) as {
        workspaceId?: string
        collection?: string
        recordId?: string
        ttlMs?: number
      }
      route.send(
        200,
        account.store.acquireLock(
          me.id,
          String(body.workspaceId ?? ''),
          String(body.collection ?? ''),
          String(body.recordId ?? ''),
          body.ttlMs,
        ),
      )
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('DELETE', '/api/account/locks', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
        await account.mysql!.releaseLock(
          me.id,
          String(body.workspaceId ?? ''),
          String(body.collection ?? ''),
          String(body.recordId ?? ''),
        )
        route.send(200, { ok: true })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
      account.store.releaseLock(
        me.id,
        String(body.workspaceId ?? ''),
        String(body.collection ?? ''),
        String(body.recordId ?? ''),
      )
      route.send(200, { ok: true })
    } catch (error) {
      fail(route, error)
    }
  })

  ctx.http.route('POST', '/api/account/presence', async (route) => {
    try {
      if (account.usesMysqlAccounts()) {
        const me = await mysqlActor(route)
        const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
        const workspaceId = String(body.workspaceId ?? '')
        route.send(200, {
          presence: await account.mysql!.pulse(
            me.id,
            workspaceId,
            String(body.collection ?? ''),
            String(body.recordId ?? ''),
          ),
        })
        return
      }
      const me = actor(route)
      const body = (await route.json()) as { workspaceId?: string; collection?: string; recordId?: string }
      requireCollaborativeWorkspace(String(body.workspaceId ?? ''))
      account.store.pulse(
        me.id,
        String(body.workspaceId ?? ''),
        String(body.collection ?? ''),
        String(body.recordId ?? ''),
      )
      route.send(200, { presence: account.store.presence(me.id, String(body.workspaceId ?? '')) })
    } catch (error) {
      fail(route, error)
    }
  })
}
