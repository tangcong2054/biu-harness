import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

type DatabaseSync = import('node:sqlite').DatabaseSync

export const SQLITE_BUSY_TIMEOUT_MS = 5000
export const SQLITE_WAL_AUTOCHECKPOINT = 256

export function quoteSqlitePath(path: string) {
  return `'${path.replaceAll("'", "''")}'`
}

export function configureSqlite(db: DatabaseSync, opts?: { foreignKeys?: boolean; schema?: string }) {
  const prefix = opts?.schema ? `${opts.schema}.` : ''
  db.exec(`PRAGMA ${prefix}journal_mode = WAL`)
  db.exec(`PRAGMA ${prefix}synchronous = NORMAL`)
  if (opts?.schema) return
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
  db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT}`)
  if (opts?.foreignKeys !== false) db.exec('PRAGMA foreign_keys = ON')
}

function ensureSqliteDir(path: string) {
  if (!path || path === ':memory:' || path.includes('mode=memory')) return
  mkdirSync(dirname(path), { recursive: true })
}

/** 动态拼接的 SQL（IN 列表长度不同等）会产生很多不同语句；超过上限按最久未用淘汰。 */
export const SQLITE_STATEMENT_CACHE_LIMIT = 256
const STATEMENT_CACHE = Symbol.for('biu.sqlite.statementCache')

type StatementSync = ReturnType<DatabaseSync['prepare']>

/**
 * 同一条 SQL 只编译一次，之后复用同一个语句对象。
 * 列表装饰会对每条记录查元数据、分享、成员身份，每次重新 prepare 时编译开销占了一半 CPU。
 * 复用是安全的：get/all/run 每次执行前都会重置语句；本仓库不使用 iterate 或修改语句设置；
 * 表结构变化时 SQLite 会自动重新编译。带额外参数的 prepare 不缓存。
 */
export function cacheSqliteStatements(db: DatabaseSync) {
  const target = db as DatabaseSync & { [STATEMENT_CACHE]?: Map<string, StatementSync> }
  if (target[STATEMENT_CACHE]) return db
  const prepare = db.prepare.bind(db) as (sql: string, ...rest: unknown[]) => StatementSync
  const cache = new Map<string, StatementSync>()
  Object.defineProperty(target, STATEMENT_CACHE, { value: cache })
  Object.defineProperty(target, 'prepare', {
    configurable: true,
    writable: true,
    value: (sql: string, ...rest: unknown[]) => {
      if (rest.length || typeof sql !== 'string') return prepare(sql, ...rest)
      const hit = cache.get(sql)
      if (hit) {
        cache.delete(sql)
        cache.set(sql, hit)
        return hit
      }
      const statement = prepare(sql)
      cache.set(sql, statement)
      if (cache.size > SQLITE_STATEMENT_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      return statement
    },
  })
  return db
}

function isCorruptSqlite(error: unknown) {
  const err = error as { errcode?: number; code?: string; message?: string }
  return err?.errcode === 11 || err?.errcode === 26 || err?.code === 'SQLITE_CORRUPT' || err?.code === 'SQLITE_NOTADB' || /malformed|corrupt|not a database/i.test(String(err?.message ?? ''))
}

function sqliteSidecars(path: string) {
  return [path, `${path}-wal`, `${path}-shm`]
}

function dropSidecars(path: string) {
  for (const file of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) rmSync(file, { force: true })
  }
}

function quarantineSqlite(path: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const file of sqliteSidecars(path)) {
    if (!existsSync(file)) continue
    renameSync(file, `${file}.corrupt-${stamp}`)
  }
  console.warn(`[sqlite] 数据库已损坏，已移到旁边并重新创建: ${path}`)
}

export function openSqlite(path: string, opts?: { foreignKeys?: boolean; checkpointOnOpen?: boolean }) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  ensureSqliteDir(path)
  const recoverable = Boolean(path) && path !== ':memory:' && !path.includes('mode=memory')
  const openFresh = () => {
    const db = new DatabaseSync(path)
    configureSqlite(db, opts)
    return cacheSqliteStatements(db)
  }
  let db: DatabaseSync | undefined
  try {
    db = openFresh()
  } catch (error) {
    try {
      db?.close()
    } catch {
      /* the handle may not exist */
    }
    if (!recoverable || !isCorruptSqlite(error)) {
      if (error instanceof Error && path && !error.message.includes(path)) error.message = `${error.message}: ${path}`
      throw error
    }
    dropSidecars(path)
    try {
      db = openFresh()
    } catch (retry) {
      try {
        db?.close()
      } catch {
        /* the handle may not exist */
      }
      if (!isCorruptSqlite(retry)) throw retry
      quarantineSqlite(path)
      db = openFresh()
    }
  }
  if (opts?.checkpointOnOpen) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* concurrent writers */
    }
  }
  return db
}

export function getSchemaVersion(db: DatabaseSync, schema?: string) {
  const sql = schema ? `PRAGMA ${schema}.user_version` : 'PRAGMA user_version'
  const row = db.prepare(sql).get() as { user_version?: number } | undefined
  return Number(row?.user_version) || 0
}

export function setSchemaVersion(db: DatabaseSync, version: number, schema?: string) {
  const prefix = schema ? `${schema}.` : ''
  db.exec(`PRAGMA ${prefix}user_version = ${Number(version) || 0}`)
}

export function sqliteVersion(db: DatabaseSync) {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v?: string } | undefined
  return String(row?.v ?? '')
}

export function assertSqliteVersion(db: DatabaseSync, min = '3.35.0') {
  const have = sqliteVersion(db).split('.').map((part) => Number(part) || 0)
  const want = min.split('.').map((part) => Number(part) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] ?? 0) > (want[i] ?? 0)) return
    if ((have[i] ?? 0) < (want[i] ?? 0)) {
      throw new Error(`需要 SQLite ${min}+，当前 ${sqliteVersion(db)}`)
    }
  }
}

export function isEmptyDatabase(db: DatabaseSync) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .get() as { n?: number }
  return Number(row?.n) === 0
}
