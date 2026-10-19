import type { Pool } from 'mysql2/promise'
import type { OwnerlessRecord } from './tenancy-audit.ts'

const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const COMMON_COLLECTION_TABLES = [
  'editor_content',
  'record_meta',
  'facet_record_values',
  'record_banners',
  'content_refs',
  'block_refs',
] as const

/**
 * Removes explicitly discarded legacy records from the MySQL import only.
 * The SQLite source remains untouched and can still be used for rollback.
 */
export async function discardOwnerlessMysql(
  pool: Pool,
  database: string,
  records: readonly OwnerlessRecord[],
) {
  if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database: ${database}`)
  const connection = await pool.getConnection()
  const db = `\`${database}\``
  const counts: Record<string, number> = {}
  try {
    await connection.beginTransaction()
    for (const { collection, recordId } of records) {
      const table = collection === '/pages'
        ? 'pages'
        : collection === '/tasks'
          ? 'tasks'
          : collection === '/sessions'
            ? 'sessions'
            : collection === '/facets'
              ? 'facets'
              : ''
      if (table) {
        const [result] = await connection.query(
          `DELETE FROM ${db}.\`${table}\` WHERE id = ?`,
          [recordId],
        )
        const affectedRows = Number((result as { affectedRows?: number }).affectedRows) || 0
        counts[table] = (counts[table] ?? 0) + affectedRows
      }
      for (const dependent of COMMON_COLLECTION_TABLES) {
        await connection.query(
          `DELETE FROM ${db}.\`${dependent}\` WHERE collection = ? AND record_id = ?`,
          [collection, recordId],
        )
      }
      await connection.query(
        `DELETE FROM ${db}.facet_stamps WHERE collection = ? AND record_id = ?`,
        [collection, recordId],
      )
      await connection.query(
        `DELETE FROM ${db}.shares WHERE collection = ? AND record_id = ?`,
        [collection, recordId],
      )
      if (collection === '/pages') {
        await connection.query(`DELETE FROM ${db}.page_block_index WHERE page_id = ?`, [recordId])
        await connection.query(`DELETE FROM ${db}.page_block_cover WHERE page_id = ?`, [recordId])
      }
      if (collection === '/sessions') {
        await connection.query(`DELETE FROM ${db}.events WHERE session_id = ?`, [recordId])
      }
      if (collection === '/facets') {
        await connection.query(`DELETE FROM ${db}.facet_stamps WHERE facet_id = ?`, [recordId])
      }
      await connection.query(
        `UPDATE ${db}.migration_tenancy_exceptions
         SET resolution = 'discarded', resolved_at = ?
         WHERE collection_name = ? AND record_id = ?`,
        [Date.now(), collection, recordId],
      )
    }
    await connection.commit()
    return counts
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
