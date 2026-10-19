import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type SqliteInventory = {
  path: string
  bytes: number
  userVersion: number
  tables: Array<{ name: string; rows: number }>
}

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

/** Opens only the explicit caller path and never consults BIU_HOME. */
export function inspectSqliteReadOnly(path: string): SqliteInventory {
  const absolute = resolve(path)
  const stat = statSync(absolute)
  if (!stat.isFile()) throw new Error(`SQLite source is not a file: ${absolute}`)
  const db = new DatabaseSync(absolute, { readOnly: true })
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number }
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
    return {
      path: absolute,
      bytes: stat.size,
      userVersion: Number(version.user_version) || 0,
      tables: rows.map(({ name }) => ({
        name,
        rows: Number(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${identifier(name)}`).get() as { count?: number }).count,
        ) || 0,
      })),
    }
  } finally {
    db.close()
  }
}
