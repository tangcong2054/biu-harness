import type { DatabaseSync } from 'node:sqlite'
import { dataHome, dataPath, openSqlite } from '@biu/host-plugin-loader/data-dir'

export type SnapshotWatermarkKey = {
  origin: string
  accountId: string
  workspaceId: string
}

const processCache = new Map<string, number>()

function cacheKey(path: string, key: SnapshotWatermarkKey) {
  return `${path}\t${key.origin}\t${key.accountId}\t${key.workspaceId}`
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_watermarks (
      origin TEXT NOT NULL,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      watermark INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (origin, account_id, workspace_id)
    )
  `)
}

export function cloudSyncSqlitePath() {
  return dataPath(dataHome(), 'cloud-sync.sqlite')
}

export class SnapshotWatermarkStore {
  constructor(
    readonly path = cloudSyncSqlitePath(),
    private cache: Map<string, number> = processCache,
  ) {}

  get(key: SnapshotWatermarkKey) {
    const id = cacheKey(this.path, key)
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached

    const db = openSqlite(this.path)
    try {
      ensureSchema(db)
      const row = db
        .prepare(
          `SELECT watermark
           FROM snapshot_watermarks
           WHERE origin = ? AND account_id = ? AND workspace_id = ?`,
        )
        .get(key.origin, key.accountId, key.workspaceId) as { watermark?: number } | undefined
      const watermark = Math.max(0, Number(row?.watermark) || 0)
      this.cache.set(id, watermark)
      return watermark
    } finally {
      db.close()
    }
  }

  set(key: SnapshotWatermarkKey, watermark: number, updatedAt = Date.now()) {
    const next = Math.max(0, Number(watermark) || 0)
    const db = openSqlite(this.path)
    try {
      ensureSchema(db)
      db.prepare(
        `INSERT INTO snapshot_watermarks
           (origin, account_id, workspace_id, watermark, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(origin, account_id, workspace_id) DO UPDATE SET
           watermark = excluded.watermark,
           updated_at = excluded.updated_at`,
      ).run(key.origin, key.accountId, key.workspaceId, next, updatedAt)
    } finally {
      db.close()
    }
    this.cache.set(cacheKey(this.path, key), next)
  }
}
