import { createPool } from 'mysql2/promise'
import { loadCloudStorageConfig, redactMysqlUrl } from './config.ts'
import { OPERATIONS_MIGRATIONS } from './migrations.ts'
import { importOperationsSources } from './ops-importer.ts'
import { runMysqlMigrations } from './runner.ts'

async function main() {
  if (process.env.BIU_MYSQL_IMPORT_OPS !== '1') {
    throw new Error('refusing to import: set BIU_MYSQL_IMPORT_OPS=1 explicitly')
  }
  const online = process.argv[2]
  const operations = process.argv[3]
  if (!online || !operations) {
    throw new Error('provide explicit online-ops.sqlite and operations-ops.sqlite snapshot paths')
  }
  const config = loadCloudStorageConfig()
  if (!config.enabled) throw new Error('refusing to import while BIU_STORAGE_BACKEND=sqlite')

  const serverUrl = new URL(config.url)
  serverUrl.pathname = '/'
  const pool = createPool({ uri: serverUrl.toString(), connectionLimit: 2 })
  try {
    console.log(`MySQL: ${redactMysqlUrl(serverUrl.toString())}`)
    await runMysqlMigrations(pool, config.operationsDatabase, OPERATIONS_MIGRATIONS)
    const result = await importOperationsSources(pool, config.operationsDatabase, [
      { name: 'online', path: online },
      { name: 'operations', path: operations },
    ])
    console.log(JSON.stringify({ database: config.operationsDatabase, imported: result.imported }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
