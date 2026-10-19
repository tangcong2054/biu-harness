import type { Pool } from 'mysql2/promise'
import { mergeOperationsSources, type OpsSource, type OpsTable } from './ops-import-plan.ts'

const COLUMNS: Record<OpsTable, readonly string[]> = {
  ops_accounts: [
    'id', 'email', 'name', 'status', 'workspace_count', 'plan',
    'last_seen_at', 'created_at', 'updated_at',
  ],
  ops_workspaces: [
    'id', 'name', 'owner_id', 'location', 'member_count', 'status', 'created_at', 'updated_at',
  ],
  ops_usage_daily: [
    'id', 'day', 'account_id', 'workspace_id', 'tokens', 'requests', 'storage_bytes', 'updated_at',
  ],
  ops_devices: [
    'id', 'installation_id', 'account_id', 'version', 'os', 'status', 'last_seen_at', 'updated_at',
  ],
  ops_sync_health: [
    'id', 'installation_id', 'status', 'pending_ops', 'last_error', 'last_sync_at', 'updated_at',
  ],
  ops_security_events: ['id', 'kind', 'account_id', 'summary', 'created_at'],
  ops_audit_logs: ['id', 'actor_id', 'action', 'target', 'summary', 'created_at'],
}

const APPEND_ONLY = new Set<OpsTable>(['ops_security_events', 'ops_audit_logs'])
const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function quoted(value: string) {
  return `\`${value}\``
}

export async function importOperationsSources(
  pool: Pool,
  database: string,
  sources: readonly OpsSource[],
) {
  if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database: ${database}`)
  const merged = mergeOperationsSources(sources)
  const connection = await pool.getConnection()
  const inserted: Record<string, number> = {}
  try {
    await connection.query(`USE ${quoted(database)}`)
    for (const { table } of merged.plan.tables) {
      const columns = COLUMNS[table]
      const columnSql = columns.map(quoted).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      const updateSql = columns
        .filter((column) => column !== 'id')
        .map((column) => `${quoted(column)} = VALUES(${quoted(column)})`)
        .join(', ')
      const sql = APPEND_ONLY.has(table)
        ? `INSERT IGNORE INTO ${quoted(table)} (${columnSql}) VALUES (${placeholders})`
        : `INSERT INTO ${quoted(table)} (${columnSql}) VALUES (${placeholders})
           ON DUPLICATE KEY UPDATE ${updateSql}`
      await connection.beginTransaction()
      try {
        for (const row of merged.rows[table]) {
          await connection.query(sql, columns.map((column) => row[column] ?? null))
        }
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      }
      inserted[table] = merged.rows[table].length
    }
    return { plan: merged.plan, imported: inserted }
  } finally {
    connection.release()
  }
}
