import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export type SqliteSnapshot = {
  source: string
  destination: string
  bytes: number
}

/**
 * Uses SQLite's online backup API instead of copying db/wal/shm files. The
 * source is opened read-only and is never migrated or checkpointed.
 */
export async function createSqliteSnapshot(
  source: string,
  destination: string,
): Promise<SqliteSnapshot> {
  const from = resolve(source)
  const to = resolve(destination)
  if (!existsSync(from) || !statSync(from).isFile()) {
    throw new Error(`SQLite source is not a file: ${from}`)
  }
  mkdirSync(dirname(to), { recursive: true })
  const temp = `${to}.partial-${process.pid}`
  rmSync(temp, { force: true })
  const db = new DatabaseSync(from, { readOnly: true })
  try {
    await backup(db, temp)
  } finally {
    db.close()
  }
  const check = new DatabaseSync(temp, { readOnly: true })
  try {
    const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    if (row.integrity_check !== 'ok') throw new Error(`snapshot integrity check failed: ${from}`)
  } finally {
    check.close()
  }
  rmSync(to, { force: true })
  renameSync(temp, to)
  return { source: from, destination: to, bytes: statSync(to).size }
}
