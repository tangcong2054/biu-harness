import { createPool } from 'mysql2/promise'
import { loadCloudStorageConfig, redactMysqlUrl } from './config.ts'
import { OPERATIONS_MIGRATIONS, PRODUCT_MIGRATIONS } from './migrations.ts'
import { runMysqlMigrations } from './runner.ts'

async function main() {
  if (process.env.BIU_MYSQL_RUN_MIGRATIONS !== '1') {
    throw new Error('refusing to migrate: set BIU_MYSQL_RUN_MIGRATIONS=1 explicitly')
  }
  const config = loadCloudStorageConfig()
  if (!config.enabled) throw new Error('refusing to migrate while BIU_STORAGE_BACKEND=sqlite')

  const serverUrl = new URL(config.url)
  serverUrl.pathname = '/'
  serverUrl.searchParams.delete('database')
  const pool = createPool({ uri: serverUrl.toString(), connectionLimit: 2, enableKeepAlive: true })
  try {
    console.log(`MySQL: ${redactMysqlUrl(serverUrl.toString())}`)
    await runMysqlMigrations(pool, config.productDatabase, PRODUCT_MIGRATIONS)
    await runMysqlMigrations(pool, config.operationsDatabase, OPERATIONS_MIGRATIONS)
    console.log(`MySQL migrations complete: ${config.productDatabase}, ${config.operationsDatabase}`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
