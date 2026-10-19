import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'

type SqliteColumn = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

type SqliteIndex = {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}

type TableShape = {
  name: string
  createSql: string
  columns: SqliteColumn[]
  primaryKey: string[]
  indexes: Array<{
    name: string
    unique: boolean
    columns: string[]
    partial: boolean
    origin: string
  }>
}

export type MysqlImportTableResult = {
  table: string
  sourceRows: number
  targetRows: number
  checksum: string
  skipped?: boolean
  skippedIndexes: string[]
}

export type MysqlImportResult = {
  source: string
  database: string
  tables: MysqlImportTableResult[]
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

function mysqlName(value: string) {
  if (!SAFE_NAME.test(value)) throw new Error(`unsafe SQL identifier: ${value}`)
  return `\`${value}\``
}

function sqliteName(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function indexName(table: string, index: SqliteIndex) {
  const raw = index.name.startsWith('sqlite_autoindex_')
    ? `${index.unique ? 'ux' : 'ix'}_${table}_${index.seq}`
    : index.name
  return raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64)
}

function inspectTables(db: DatabaseSync, include?: ReadonlySet<string>, exclude?: ReadonlySet<string>) {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql?: string }>
  return rows
    .filter(({ name }) => (!include || include.has(name)) && !exclude?.has(name))
    .map(({ name, sql }) => {
      if (!SAFE_NAME.test(name)) throw new Error(`unsupported SQLite table name: ${name}`)
      const columns = db.prepare(`PRAGMA table_info(${sqliteName(name)})`).all() as SqliteColumn[]
      const indexes = (db.prepare(`PRAGMA index_list(${sqliteName(name)})`).all() as SqliteIndex[]).map(
        (index) => ({
          name: indexName(name, index),
          unique: index.unique === 1,
          partial: index.partial === 1,
          origin: index.origin,
          columns: (
            db.prepare(`PRAGMA index_info(${sqliteName(index.name)})`).all() as Array<{
              seqno: number
              name: string
            }>
          )
            .sort((left, right) => left.seqno - right.seqno)
            .map((column) => column.name),
        }),
      )
      return {
        name,
        createSql: String(sql ?? ''),
        columns,
        primaryKey: columns
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        indexes,
      } satisfies TableShape
    })
}

function mysqlColumnType(column: SqliteColumn, indexed: boolean) {
  const type = column.type.toUpperCase()
  if (type.includes('INT')) return 'BIGINT'
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'DOUBLE'
  if (type.includes('BLOB')) return 'LONGBLOB'
  if (indexed) return 'VARCHAR(128) COLLATE utf8mb4_bin'
  return 'LONGTEXT'
}

async function createTargetTable(connection: PoolConnection, shape: TableShape) {
  const indexed = new Set([
    ...shape.primaryKey,
    ...shape.indexes.flatMap((index) => index.columns),
  ])
  const autoIncrement =
    shape.primaryKey.length === 1 && /\bAUTOINCREMENT\b/i.test(shape.createSql)
      ? shape.primaryKey[0]
      : ''
  const definitions = shape.columns.map((column) => {
    const parts = [
      mysqlName(column.name),
      mysqlColumnType(column, indexed.has(column.name)),
      column.notnull || shape.primaryKey.includes(column.name) ? 'NOT NULL' : 'NULL',
    ]
    if (column.name === autoIncrement) parts.push('AUTO_INCREMENT')
    return parts.join(' ')
  })
  if (shape.primaryKey.length) {
    definitions.push(`PRIMARY KEY (${shape.primaryKey.map(mysqlName).join(', ')})`)
  }
  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${mysqlName(shape.name)} (
      ${definitions.join(',\n')}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  )

  const skippedIndexes: string[] = []
  const [existingRows] = await connection.query<RowDataPacket[]>(
    `SELECT DISTINCT INDEX_NAME AS name
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [shape.name],
  )
  const existing = new Set(existingRows.map((row) => String(row.name)))
  for (const index of shape.indexes) {
    if (index.origin === 'pk') continue
    if (index.partial || !index.columns.length) {
      skippedIndexes.push(index.name)
      continue
    }
    if (existing.has(index.name) || (index.name === 'PRIMARY' && shape.primaryKey.length)) continue
    await connection.query(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${mysqlName(index.name)}
       ON ${mysqlName(shape.name)} (${index.columns.map(mysqlName).join(', ')})`,
    )
  }
  return skippedIndexes
}

function batches(rows: Array<Record<string, unknown>>, columns: SqliteColumn[]) {
  const result: Array<Array<Record<string, unknown>>> = []
  let batch: Array<Record<string, unknown>> = []
  let bytes = 0
  for (const row of rows) {
    const rowBytes = columns.reduce((sum, column) => {
      const value = row[column.name]
      return sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16)
    }, 0)
    if (batch.length && (batch.length >= 500 || bytes + rowBytes > 1024 * 1024)) {
      result.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(row)
    bytes += rowBytes
  }
  if (batch.length) result.push(batch)
  return result
}

function tableChecksum(rows: Array<Record<string, unknown>>, columns: SqliteColumn[]) {
  const hash = createHash('sha256')
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column.name]
      hash.update(value == null ? '\0' : `${typeof value}:${String(value)}`)
      hash.update('\x1f')
    }
    hash.update('\x1e')
  }
  return hash.digest('hex')
}

export async function importSqliteIntoMysql(
  pool: Pool,
  database: string,
  sqlitePath: string,
  options?: {
    includeTables?: readonly string[]
    excludeTables?: readonly string[]
    replace?: boolean
    previousChecksums?: Readonly<Record<string, string>>
  },
): Promise<MysqlImportResult> {
  if (!SAFE_NAME.test(database)) throw new Error(`unsafe MySQL database: ${database}`)
  const source = resolve(sqlitePath)
  const sqlite = new DatabaseSync(source, { readOnly: true })
  const connection = await pool.getConnection()
  try {
    await connection.query(`USE ${mysqlName(database)}`)
    const shapes = inspectTables(
      sqlite,
      options?.includeTables ? new Set(options.includeTables) : undefined,
      options?.excludeTables ? new Set(options.excludeTables) : undefined,
    )
    const results: MysqlImportTableResult[] = []
    for (const shape of shapes) {
      const skippedIndexes = await createTargetTable(connection, shape)
      const rows = sqlite.prepare(`SELECT * FROM ${sqliteName(shape.name)}`).all() as Array<
        Record<string, unknown>
      >
      const checksum = tableChecksum(rows, shape.columns)
      const [beforeCountRows] = await connection.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS count FROM ${mysqlName(shape.name)}`,
      )
      const beforeCount = Number(beforeCountRows[0]?.count) || 0
      const skipped = options?.previousChecksums?.[shape.name] === checksum
        && beforeCount === rows.length
      if (!skipped) {
        await connection.beginTransaction()
        try {
          if (options?.replace) await connection.query(`DELETE FROM ${mysqlName(shape.name)}`)
          if (rows.length) {
            const columnSql = shape.columns.map((column) => mysqlName(column.name)).join(', ')
            for (const batch of batches(rows, shape.columns)) {
              const values = batch.flatMap((row) =>
                shape.columns.map((column) => row[column.name] ?? null),
              )
              const oneRow = `(${shape.columns.map(() => '?').join(', ')})`
              const updateColumns = shape.columns.filter(
                (column) => !shape.primaryKey.includes(column.name),
              )
              const upsert = !options?.replace && shape.primaryKey.length && updateColumns.length
                ? ` ON DUPLICATE KEY UPDATE ${updateColumns
                    .map((column) => `${mysqlName(column.name)} = VALUES(${mysqlName(column.name)})`)
                    .join(', ')}`
                : ''
              await connection.query(
                `INSERT INTO ${mysqlName(shape.name)} (${columnSql})
                 VALUES ${batch.map(() => oneRow).join(', ')}${upsert}`,
                values,
              )
            }
          }
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          throw new Error(`failed to import ${shape.name}`, { cause: error })
        }
      }
      results.push({
        table: shape.name,
        sourceRows: rows.length,
        targetRows: skipped ? beforeCount : rows.length,
        checksum,
        ...(skipped ? { skipped: true } : {}),
        skippedIndexes,
      })
    }
    return { source, database, tables: results }
  } finally {
    connection.release()
    sqlite.close()
  }
}
