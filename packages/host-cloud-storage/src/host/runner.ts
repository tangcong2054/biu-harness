import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { MysqlMigration } from './migrations.ts'

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function identifier(value: string) {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`unsafe MySQL identifier: ${value}`)
  return `\`${value}\``
}

function checksum(migration: MysqlMigration) {
  return createHash('sha256')
    .update(JSON.stringify([migration.version, migration.name, migration.statements]))
    .digest('hex')
}

async function acquireLock(connection: PoolConnection, database: string) {
  const name = `biu:migrate:${database}`
  const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [name])
  if (Number(rows[0]?.acquired) !== 1) throw new Error(`could not acquire migration lock for ${database}`)
  return () => connection.query('SELECT RELEASE_LOCK(?)', [name])
}

export async function runMysqlMigrations(
  pool: Pool,
  database: string,
  migrations: readonly MysqlMigration[],
) {
  const db = identifier(database)
  const connection = await pool.getConnection()
  let releaseLock: (() => Promise<unknown>) | undefined
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    )
    await connection.query(`USE ${db}`)
    releaseLock = await acquireLock(connection, database)
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT NOT NULL, name VARCHAR(255) NOT NULL, checksum CHAR(64) NOT NULL,
      applied_at BIGINT NOT NULL, PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)

    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    const applied = new Map(
      rows.map((row) => [Number(row.version), { name: String(row.name), checksum: String(row.checksum) }]),
    )
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      const digest = checksum(migration)
      const current = applied.get(migration.version)
      if (current) {
        if (current.name !== migration.name || current.checksum !== digest) {
          throw new Error(`migration ${migration.version} changed after it was applied`)
        }
        continue
      }
      for (const statement of migration.statements) await connection.query(statement)
      await connection.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, digest, Date.now()],
      )
    }
  } finally {
    try {
      await releaseLock?.()
    } finally {
      connection.release()
    }
  }
}
