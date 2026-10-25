import { createPool } from 'mysql2/promise'
import { basename } from 'node:path'
import { loadCloudStorageConfig, redactMysqlUrl } from './config.ts'
import { PRODUCT_MIGRATIONS } from './migrations.ts'
import { runMysqlMigrations } from './runner.ts'
import { importSqliteIntoMysql } from './sqlite-mysql-importer.ts'
import { collectOwnerlessRecords } from './tenancy-audit.ts'
import { discardOwnerlessMysql } from './ownerless-pruner.ts'

const DEVICE_OR_EPHEMERAL_TABLES = [
  'cloud_connections',
  'workspace_place',
  'record_place',
  'record_cloud_copy',
  'replica_devices',
  'replica_records',
  'replica_outbox',
  'replica_cursors',
  'edit_locks',
  'presence',
  'session_execution_leases',
  'gc_candidates',
  'collab_state',
  'plugin_loads',
] as const

/**
 * 这些表由版本化 migration 建在 MySQL 里、运行时直接读写（不是从 SQLite 搬过去的）。
 * 导入时跳过它们的数据，但绝不能 DROP，否则重跑导入会把正在使用的锁表删掉。
 */
const RUNTIME_OWNED_TABLES = new Set<string>(['session_execution_leases', 'plugin_loads'])

async function main() {
  if (process.env.BIU_MYSQL_IMPORT_MAIN !== '1') {
    throw new Error('refusing to import: set BIU_MYSQL_IMPORT_MAIN=1 explicitly')
  }
  const mainSnapshot = process.argv[2]
  const eventsSnapshot = process.argv[3]
  if (!mainSnapshot || !eventsSnapshot) {
    throw new Error('provide explicit online-biu.sqlite and online-events.sqlite snapshot paths')
  }
  const config = loadCloudStorageConfig()
  if (!config.enabled) throw new Error('refusing to import while BIU_STORAGE_BACKEND=sqlite')

  const serverUrl = new URL(config.url)
  serverUrl.pathname = '/'
  const pool = createPool({
    uri: serverUrl.toString(),
    connectionLimit: 2,
    enableKeepAlive: true,
    maxIdle: 2,
  })
  try {
    console.log(`MySQL: ${redactMysqlUrl(serverUrl.toString())}`)
    await runMysqlMigrations(pool, config.productDatabase, PRODUCT_MIGRATIONS)
    for (const table of DEVICE_OR_EPHEMERAL_TABLES) {
      if (RUNTIME_OWNED_TABLES.has(table)) continue
      await pool.query(`DROP TABLE IF EXISTS \`${config.productDatabase}\`.\`${table}\``)
    }
    const mainResult = await importSqliteIntoMysql(pool, config.productDatabase, mainSnapshot, {
      excludeTables: DEVICE_OR_EPHEMERAL_TABLES,
      replace: true,
    })
    const eventsResult = await importSqliteIntoMysql(pool, config.productDatabase, eventsSnapshot, {
      includeTables: ['events'],
      replace: true,
    })
    const ownerless = collectOwnerlessRecords(mainSnapshot)
    await pool.query(
      `DELETE FROM \`${config.productDatabase}\`.migration_tenancy_exceptions
       WHERE resolved_at IS NULL`,
    )
    if (ownerless.length) {
      const placeholders = ownerless.map(() => '(?, ?, ?, ?)').join(', ')
      await pool.query(
        `INSERT INTO \`${config.productDatabase}\`.migration_tenancy_exceptions
         (collection_name, record_id, reason, created_at) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
        ownerless.flatMap((row) => [
          row.collection,
          row.recordId,
          'missing_record_owner',
          Date.now(),
        ]),
      )
    }
    const ownerlessPolicy = String(process.env.BIU_MYSQL_OWNERLESS ?? 'report').trim()
    if (!['report', 'discard'].includes(ownerlessPolicy)) {
      throw new Error('BIU_MYSQL_OWNERLESS must be report or discard')
    }
    const discarded = ownerlessPolicy === 'discard'
      ? await discardOwnerlessMysql(pool, config.productDatabase, ownerless)
      : {}
    for (const [kind, sourceName, result] of [
      ['main', basename(mainSnapshot), mainResult],
      ['events', basename(eventsSnapshot), eventsResult],
    ] as const) {
      await pool.query(
        `INSERT INTO \`${config.productDatabase}\`.sqlite_import_runs
         (source_kind, source_name, table_count, source_rows, target_rows, report_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          kind,
          sourceName,
          result.tables.length,
          result.tables.reduce((sum, table) => sum + table.sourceRows, 0),
          result.tables.reduce((sum, table) => sum + table.targetRows, 0),
          JSON.stringify(result.tables),
          Date.now(),
        ],
      )
    }
    console.log(
      JSON.stringify(
        {
          database: config.productDatabase,
          main: mainResult.tables,
          events: eventsResult.tables,
          excluded: DEVICE_OR_EPHEMERAL_TABLES,
          tenancyExceptions: ownerless.length,
          ownerlessPolicy,
          discarded,
        },
        null,
        2,
      ),
    )
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  if (error instanceof Error && error.cause) console.error(error.cause)
  process.exitCode = 1
})
