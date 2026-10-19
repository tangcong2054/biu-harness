export type StorageBackend = 'sqlite' | 'dual' | 'mysql'

export type CloudStorageConfig =
  | { backend: 'sqlite'; enabled: false }
  | { backend: 'dual' | 'mysql'; enabled: false }
  | {
      backend: 'dual' | 'mysql'
      enabled: true
      url: string
      productDatabase: string
      operationsDatabase: string
    }

const DATABASE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function databaseName(value: string | undefined, fallback: string, label: string) {
  const name = String(value ?? fallback).trim()
  if (!DATABASE_NAME.test(name)) throw new Error(`${label} must match ${DATABASE_NAME}`)
  return name
}

/** SQLite remains the fail-closed default. */
export function loadCloudStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): CloudStorageConfig {
  const raw = String(env.BIU_STORAGE_BACKEND ?? 'sqlite').trim().toLowerCase()
  if (!['sqlite', 'dual', 'mysql'].includes(raw)) {
    throw new Error('BIU_STORAGE_BACKEND must be sqlite, dual, or mysql')
  }
  const backend = raw as StorageBackend
  if (backend === 'sqlite') return { backend, enabled: false }
  if (env.BIU_ONLINE !== '1') {
    // Offline 永远使用本机 SQLite；允许与 Online 共用同一套 dual/mysql 环境模板。
    return { backend, enabled: false }
  }

  const url = String(env.BIU_MYSQL_URL ?? '').trim()
  if (!url) throw new Error('BIU_MYSQL_URL is required for dual/mysql storage')
  const parsed = new URL(url)
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || !parsed.username) {
    throw new Error('BIU_MYSQL_URL must be mysql:// and include a host and user')
  }
  const productDatabase = databaseName(env.BIU_MYSQL_DATABASE, 'biu', 'BIU_MYSQL_DATABASE')
  const operationsDatabase = databaseName(
    env.BIU_OPS_MYSQL_DATABASE,
    'biu_ops',
    'BIU_OPS_MYSQL_DATABASE',
  )
  if (productDatabase === operationsDatabase) {
    throw new Error('BIU_MYSQL_DATABASE and BIU_OPS_MYSQL_DATABASE must differ')
  }
  return { backend, enabled: true, url, productDatabase, operationsDatabase }
}

export function redactMysqlUrl(value: string) {
  const parsed = new URL(value)
  if (parsed.password) parsed.password = '***'
  return parsed.toString()
}
