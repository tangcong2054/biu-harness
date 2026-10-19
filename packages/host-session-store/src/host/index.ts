import { biuSqlitePath, eventsSqlitePath, isOnlineRuntime } from '@biu/host-plugin-loader/data-dir'
import { Service, type Context } from 'cordis'
import type { Pool } from 'mysql2/promise'
import {
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
  lastSpokenAt,
  sessionDisplayTitle,
} from '@biu/type-session'

function toSummary(record: SessionRecord, updatedAt?: number): SessionSummary {
  const touched = updatedAt ?? record.events.at(-1)?.ts ?? 0
  const spoken = lastSpokenAt(record.events)
  const createdAt = Number(record.config?.createdAt)
  const stamp = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : (record.events[0]?.ts ?? touched)
  return {
    id: record.id,
    version: record.version,
    eventCount: record.events.length,
    title: sessionDisplayTitle(record),
    updatedAt: touched,
    ...(spoken > 0 ? { lastMessageAt: spoken } : {}),
    ...(record.project ? { project: record.project } : {}),
    ...(record.mascot ? { mascot: record.mascot } : {}),
    ...(record.config || stamp
      ? { config: { ...(record.config ?? {}), ...(stamp ? { createdAt: stamp } : {}) } }
      : {}),
  }
}

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>()
  private touched = new Map<string, number>()

  async load(id: string) {
    return this.records.get(id)
  }

  async save(record: SessionRecord) {
    this.records.set(record.id, { ...record, events: [...record.events] })
    this.touched.set(record.id, Date.now())
  }

  async list() {
    return [...this.records.keys()]
  }

  async listSummaries() {
    return [...this.records.values()]
      .map((record) => toSummary(record, this.touched.get(record.id)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async delete(id: string) {
    this.touched.delete(id)
    return this.records.delete(id)
  }
}

export class SessionStoreService extends Service implements SessionStore {
  constructor(
    ctx: Context,
    private inner: SessionStore,
  ) {
    super(ctx, 'sessionStore')
  }

  load(id: string) {
    return this.inner.load(id)
  }

  save(record: SessionRecord) {
    return this.inner.save(record)
  }

  list() {
    return this.inner.list()
  }

  listSummaries() {
    return this.inner.listSummaries()
  }

  delete(id: string) {
    return this.inner.delete(id)
  }
}

export const name = 'session-store'
// Cloud storage 在默认插件清单中排在本插件之前；保持可选依赖，避免 memory/SQLite
// 独立测试和嵌入式宿主被迫安装 CloudStorageService。
export const inject = [] as const

export type SessionStoreDriver = 'memory' | 'sqlite'
export type DualSessionMode = 'mysql' | 'shadow' | 'sqlite'

type CloudStorageLike = {
  backend: 'sqlite' | 'dual' | 'mysql'
  pool: Pool | null
  config: { productDatabase?: string }
}

class ShadowSessionStore implements SessionStore {
  constructor(
    private readonly primary: SessionStore,
    private readonly shadow: SessionStore,
    private readonly warn: (error: unknown) => void,
  ) {}

  load(id: string) {
    return this.primary.load(id)
  }

  async save(record: SessionRecord) {
    await this.primary.save(record)
    try {
      await this.shadow.save(record)
    } catch (error) {
      this.warn(error)
    }
  }

  list() {
    return this.primary.list()
  }

  listSummaries() {
    return this.primary.listSummaries()
  }

  async delete(id: string) {
    const deleted = await this.primary.delete(id)
    try {
      await this.shadow.delete(id)
    } catch (error) {
      this.warn(error)
    }
    return deleted
  }
}

export function resolveSessionBackend(
  backend: CloudStorageLike['backend'],
  online: boolean,
  dualMode = process.env.BIU_SESSION_MYSQL_MODE,
): 'sqlite' | 'mysql' | 'shadow' {
  if (!online || backend === 'sqlite') return 'sqlite'
  if (backend === 'mysql') return 'mysql'
  const mode = String(dualMode ?? 'mysql').trim().toLowerCase()
  if (mode === 'shadow' || mode === 'sqlite') return mode
  if (mode !== 'mysql') {
    throw new Error('BIU_SESSION_MYSQL_MODE must be mysql, shadow, or sqlite')
  }
  return 'mysql'
}

export async function apply(
  ctx: Context,
  config: { driver?: SessionStoreDriver; path?: string; eventsPath?: string } = {},
) {
  const envDriver = process.env.CORDIS_SESSION_STORE as SessionStoreDriver | undefined
  const driver = config.driver ?? (envDriver === 'memory' || envDriver === 'sqlite' ? envDriver : 'sqlite')
  const sqlitePath = config.path ?? biuSqlitePath()
  const eventsPath = config.eventsPath ?? (config.path ? undefined : eventsSqlitePath())

  let inner: SessionStore
  if (driver === 'memory') {
    inner = new MemorySessionStore()
  } else {
    const { ensureSqliteSessionStore } = await import('./sqlite-session-store.ts')
    const backend = ctx.get('cloudStorage') as CloudStorageLike | undefined
    const selected = resolveSessionBackend(backend?.backend ?? 'sqlite', isOnlineRuntime())
    if (selected === 'sqlite') {
      inner = await ensureSqliteSessionStore(sqlitePath, eventsPath)
    } else {
      if (!backend?.pool || !backend.config.productDatabase) {
        throw new Error('MySQL Session Store requires an enabled CloudStorageService pool')
      }
      const { MysqlSessionStore } = await import('./mysql-session-store.ts')
      const mysql = new MysqlSessionStore(backend.pool, backend.config.productDatabase)
      if (selected === 'shadow') {
        const sqlite = await ensureSqliteSessionStore(sqlitePath, eventsPath)
        inner = new ShadowSessionStore(sqlite, mysql, (error) => {
          ctx.logger('session-store').warn(`MySQL shadow write failed: ${String(error)}`)
        })
      } else {
        inner = mysql
      }
    }
  }
  new SessionStoreService(ctx, inner)
}
