import '@biu/type-host-context'
import {
  biuSqlitePath,
  currentRequestWorkspaceId,
  eventsSqlitePath,
  isOnlineRuntime,
} from '@biu/host-plugin-loader/data-dir'
import { Service, type Context } from 'cordis'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { loadCloudStorageConfig, redactMysqlUrl, type CloudStorageConfig } from './config.ts'
import { PRODUCT_MIGRATIONS } from './migrations.ts'
import { PrivateBackupStore, type CreatePrivateBackupInput } from './private-backups.ts'
import { runMysqlMigrations } from './runner.ts'
import { ShadowSyncBridge, syncSqliteShadow, type ShadowSyncStatus } from './shadow-sync.ts'
import {
  MysqlAccountRepository,
  MysqlAuthorizationRepository,
  resolveAccountControlMode,
} from './mysql-account-repositories.ts'
import {
  FILE_SYSTEM_METADATA_TABLES,
  MysqlEditorContentRepository,
  MysqlFileSystemMetadataRepository,
  MysqlPageRepository,
  MysqlTaskRepository,
  resolveRuntimeRepositoryMode,
  type RuntimeRepositoryMode,
} from './mysql-runtime-repositories.ts'

export const name = 'cloud-storage'

export class CloudStorageService extends Service {
  readonly config: CloudStorageConfig
  readonly pool: Pool | null
  readonly privateBackups: PrivateBackupStore | null
  readonly pageRepository: MysqlPageRepository | null
  readonly editorContentRepository: MysqlEditorContentRepository | null
  readonly fileSystemMetadataRepository: MysqlFileSystemMetadataRepository | null
  readonly taskRepository: MysqlTaskRepository | null
  readonly accountRepository: MysqlAccountRepository | null
  readonly authorizationRepository: MysqlAuthorizationRepository | null
  readonly accountMode: RuntimeRepositoryMode
  readonly pageMode: RuntimeRepositoryMode
  readonly taskMode: RuntimeRepositoryMode
  readonly editorContentMode: RuntimeRepositoryMode
  readonly fileSystemMetadataMode: RuntimeRepositoryMode
  readonly metadataMode: RuntimeRepositoryMode
  private readonly shadow: ShadowSyncBridge
  private migrationsReady: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'cloudStorage')
    this.config = loadCloudStorageConfig()
    const config = this.config
    const online = isOnlineRuntime()
    this.accountMode = resolveAccountControlMode(config.backend, online)
    this.pageMode = resolveRuntimeRepositoryMode(
      config.backend, online, process.env.BIU_PAGE_MYSQL_MODE, 'BIU_PAGE_MYSQL_MODE',
    )
    this.editorContentMode = resolveRuntimeRepositoryMode(
      config.backend, online, process.env.BIU_EDITOR_CONTENT_MYSQL_MODE, 'BIU_EDITOR_CONTENT_MYSQL_MODE',
    )
    this.taskMode = resolveRuntimeRepositoryMode(
      config.backend, online, process.env.BIU_TASK_MYSQL_MODE, 'BIU_TASK_MYSQL_MODE',
    )
    this.fileSystemMetadataMode = resolveRuntimeRepositoryMode(
      config.backend,
      online,
      process.env.BIU_METADATA_MYSQL_MODE,
      'BIU_METADATA_MYSQL_MODE',
    )
    this.metadataMode = this.fileSystemMetadataMode
    this.pool = config.enabled
      ? createPool({
          uri: config.url,
          connectionLimit: Math.max(1, Number(process.env.BIU_MYSQL_POOL_SIZE) || 10),
          enableKeepAlive: true,
        })
      : null
    this.privateBackups = this.pool && config.enabled
      ? new PrivateBackupStore(this.pool, config.productDatabase)
      : null
    const workspaceId = () => {
      const requested = currentRequestWorkspaceId()
      if (requested) return requested
      try {
        const account = ctx.get('account') as { store?: { activeWorkspaceId?(): string | null } } | undefined
        return account?.store?.activeWorkspaceId?.() ?? ''
      } catch {
        return ''
      }
    }
    this.pageRepository = this.pool && config.enabled
      ? new MysqlPageRepository(this.pool, config.productDatabase, workspaceId)
      : null
    this.editorContentRepository = this.pool && config.enabled
      ? new MysqlEditorContentRepository(this.pool, config.productDatabase, workspaceId)
      : null
    this.fileSystemMetadataRepository = this.pool && config.enabled
      ? new MysqlFileSystemMetadataRepository(this.pool, config.productDatabase, workspaceId)
      : null
    this.taskRepository = this.pool && config.enabled
      ? new MysqlTaskRepository(this.pool, config.productDatabase, workspaceId)
      : null
    this.accountRepository = this.pool && config.enabled
      ? new MysqlAccountRepository(this.pool, config.productDatabase, config.operationsDatabase)
      : null
    this.authorizationRepository = this.pool && config.enabled
      ? new MysqlAuthorizationRepository(this.pool, config.productDatabase)
      : null

    const logger = ctx.logger('cloud-storage')
    const shadowEnabled = Boolean(
      this.pool && config.enabled && config.backend === 'dual' && process.env.BIU_ONLINE === '1',
    )
    this.shadow = new ShadowSyncBridge(
      async () => {
        if (!this.pool || !config.enabled) return
        await this.ensureProductMigrations()
        await syncSqliteShadow({
          pool: this.pool,
          database: config.productDatabase,
          mainPath: biuSqlitePath(),
          eventsPath: eventsSqlitePath(),
          // mysql/shadow modes are already handled transactionally by
          // MysqlSessionStore; generic SQLite shadowing must not overwrite them.
          syncSessions: String(process.env.BIU_SESSION_MYSQL_MODE ?? 'mysql').trim() === 'sqlite',
          excludeMainTables: [
            ...(this.accountMode === 'mysql' ? [
              'accounts',
              'auth_sessions',
              'guest_sessions',
              'workspaces',
              'workspace_members',
              'workspace_invites',
              'workspace_groups',
              'workspace_group_members',
              'record_owners',
              'resource_policies',
              'record_grants',
              'view_grants',
              'authz_revisions',
              'mcp_credentials',
              'mcp_audit_log',
              'plugin_audit_log',
              'sync_ops',
              'edit_locks',
              'presence',
              'plugin_packages',
              'plugin_assignments',
              'plugin_workspace_config',
              'plugin_account_config',
              'plugin_loads',
            ] : []),
            ...(this.pageMode === 'sqlite' ? [] : ['pages']),
            ...(this.taskMode === 'sqlite' ? [] : ['tasks']),
            ...(this.editorContentMode === 'sqlite' ? [] : ['editor_content']),
            ...(this.fileSystemMetadataMode === 'sqlite' ? [] : FILE_SYSTEM_METADATA_TABLES),
          ],
        })
      },
      logger,
      Math.max(10, Number(process.env.BIU_MYSQL_SHADOW_DEBOUNCE_MS) || 750),
      shadowEnabled,
    )
    ctx.on('database/change', () => this.shadow.notifyChange())
    ctx.effect(() => async () => {
      await this.shadow.flush()
      await this.pool?.end()
    })
  }

  get backend() {
    return this.config.backend
  }

  async start() {
    const result = await this.health()
    if (this.config.enabled) {
      this.ctx.logger('cloud-storage').info(
        `backend=${this.config.backend} mysql=${redactMysqlUrl(this.config.url)}`,
      )
    }
    this.shadow.start()
    return result
  }

  shadowStatus(): ShadowSyncStatus {
    return this.shadow.status()
  }

  flushShadow() {
    return this.shadow.flush()
  }

  async health() {
    if (!this.pool || !this.config.enabled) return { backend: 'sqlite' as const, mysql: false }
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT 1 AS ok')
    if (Number(rows[0]?.ok) !== 1) throw new Error('MySQL health check failed')
    return {
      backend: this.config.backend,
      mysql: true,
      productDatabase: this.config.productDatabase,
      operationsDatabase: this.config.operationsDatabase,
    }
  }

  async ensureProductMigrations() {
    if (!this.pool || !this.config.enabled) return
    this.migrationsReady ??= runMysqlMigrations(
      this.pool,
      this.config.productDatabase,
      PRODUCT_MIGRATIONS,
    ).catch((error) => {
      this.migrationsReady = undefined
      throw error
    })
    await this.migrationsReady
  }

  private backups() {
    if (!this.privateBackups) throw new Error('private cloud backups require MySQL storage')
    return this.privateBackups
  }

  createPrivateBackup(accountId: string, input: CreatePrivateBackupInput) {
    return this.backups().create(accountId, input)
  }

  listPrivateBackups(accountId: string) {
    return this.backups().list(accountId)
  }

  readPrivateBackup(accountId: string, backupId: string) {
    return this.backups().read(accountId, backupId)
  }

  deletePrivateBackup(accountId: string, backupId: string) {
    return this.backups().delete(accountId, backupId)
  }
}

export async function apply(ctx: Context) {
  const service = new CloudStorageService(ctx)
  await service.start()
}
