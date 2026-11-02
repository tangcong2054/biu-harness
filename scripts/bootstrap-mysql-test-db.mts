/**
 * 初始化本地 MySQL 集成测试库：清空后按生产顺序建出完整表结构。
 *   1. 控制面迁移（第 1–5 版，不依赖业务表）
 *   2. 导入空的 SQLite 主库与事件库结构（建出 pages、saved_views 等业务表，不含数据）
 *   3. 其余迁移（给业务表补工作区列、主键等）
 *
 * 只允许库名以 biu_test 开头，防止误清空生产库。连接串取自 BIU_MYSQL_TEST_URL，不在代码里保存密码。
 *
 *   set -a && . ~/.config/biu/test-mysql.env && set +a
 *   npx tsx scripts/bootstrap-mysql-test-db.mts biu_test1 biu_test2
 *
 * 第 14 版迁移会建触发器（线上会话列表依赖它们）；开启 binlog 时需要 SUPER 权限或
 * log_bin_trust_function_creators=1。两者都没有时可加 --skip=14 临时跳过，但结构就与线上不一致了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPool, type RowDataPacket } from 'mysql2/promise'
import { openAndMigrateBiu, openAndMigrateEvents } from '../packages/host-plugin-loader/src/host/data-dir.ts'
import { PRODUCT_MIGRATIONS } from '../packages/host-cloud-storage/src/host/migrations.ts'
import { runMysqlMigrations } from '../packages/host-cloud-storage/src/host/runner.ts'
import { importSqliteIntoMysql } from '../packages/host-cloud-storage/src/host/sqlite-mysql-importer.ts'

const CONTROL_PLANE_LAST_VERSION = 5
const DEVICE_OR_EPHEMERAL_TABLES = [
  'cloud_connections', 'workspace_place', 'record_place', 'record_cloud_copy', 'replica_devices',
  'replica_records', 'replica_outbox', 'replica_cursors', 'edit_locks', 'presence',
  'session_execution_leases', 'gc_candidates', 'collab_state', 'plugin_loads',
]

const args = process.argv.slice(2)
const skipArg = args.find((arg) => arg.startsWith('--skip='))
const skip = new Set((skipArg?.slice('--skip='.length) ?? '').split(',').filter(Boolean).map(Number))
for (const version of skip) {
  if (!Number.isSafeInteger(version) || version <= CONTROL_PLANE_LAST_VERSION) {
    throw new Error(`--skip only accepts migration versions > ${CONTROL_PLANE_LAST_VERSION}`)
  }
}
const databases = args.filter((arg) => !arg.startsWith('--'))
const baseUrl = process.env.BIU_MYSQL_TEST_URL
if (!baseUrl) throw new Error('BIU_MYSQL_TEST_URL is required')
if (!databases.length) throw new Error('usage: bootstrap-mysql-test-db.mts <biu_test_db>...')
for (const name of databases) {
  if (!/^biu_test[A-Za-z0-9_]{0,55}$/.test(name)) throw new Error(`refusing non-test database: ${name}`)
}

const dir = mkdtempSync(join(tmpdir(), 'biu-mysql-bootstrap-'))
try {
  const mainPath = join(dir, 'biu.sqlite')
  const eventsPath = join(dir, 'events.sqlite')
  openAndMigrateBiu(mainPath).close()
  openAndMigrateEvents(eventsPath).close()
  for (const database of databases) {
    const url = new URL(baseUrl)
    url.pathname = `/${database}`
    const pool = createPool({ uri: url.toString(), connectionLimit: 1 })
    try {
      const connection = await pool.getConnection()
      try {
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
          [database],
        )
        await connection.query('SET FOREIGN_KEY_CHECKS = 0')
        for (const row of rows) {
          await connection.query(`DROP TABLE IF EXISTS \`${database}\`.\`${String(row.name).replaceAll('`', '``')}\``)
        }
        await connection.query('SET FOREIGN_KEY_CHECKS = 1')
      } finally {
        connection.release()
      }
      await runMysqlMigrations(pool, database, PRODUCT_MIGRATIONS.filter((m) => m.version <= CONTROL_PLANE_LAST_VERSION))
      await importSqliteIntoMysql(pool, database, mainPath, { excludeTables: DEVICE_OR_EPHEMERAL_TABLES, replace: true })
      await importSqliteIntoMysql(pool, database, eventsPath, { includeTables: ['events'], replace: true })
      await runMysqlMigrations(pool, database, PRODUCT_MIGRATIONS.filter((m) => !skip.has(m.version)))
      const [[count]] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = ?',
        [database],
      )
      const [[latest]] = await pool.query<RowDataPacket[]>(`SELECT MAX(version) AS version FROM \`${database}\`.schema_migrations`)
      console.log(`${database}: ${count?.tables} tables, schema version ${latest?.version}`)
    } finally {
      await pool.end()
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
