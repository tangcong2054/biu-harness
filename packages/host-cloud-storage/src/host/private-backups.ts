import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export const MAX_PRIVATE_BACKUP_BYTES = 10 * 1024 * 1024
export const MAX_PRIVATE_BACKUP_ITEMS = 20_000

export type PrivateBackupAsset = {
  name: string
  etag: string
  mime: string
  storage: 'hash' | 'name'
  size: number
  contentHash: string
  bytesBase64: string
}

export type PrivateBackupSnapshot = {
  sessions: Array<Record<string, unknown> & { id: string }>
  collections: Array<{
    path: string
    records: Array<Record<string, unknown> & { id: string }>
  }>
  assets?: PrivateBackupAsset[]
}

export type CreatePrivateBackupInput = {
  name: string
  sourceDeviceId: string
  workspaceId: string
  snapshot: unknown
}

export type PrivateBackupSummary = {
  id: string
  name: string
  sourceDeviceId: string
  workspaceId: string
  scope: 'private_backup'
  status: 'ready'
  manifestVersion: number
  itemCount: number
  createdAt: number
  updatedAt: number
}

export type PrivateBackup = PrivateBackupSummary & {
  snapshot: PrivateBackupSnapshot
}

type Queryable = Pick<Pool, 'query' | 'getConnection'>
type Transaction = Pick<PoolConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback' | 'release'>
const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function text(value: unknown, label: string, max: number, required = true) {
  const result = String(value ?? '').trim()
  if ((required && !result) || result.length > max) throw new Error(`invalid ${label}`)
  return result
}

function snapshotItems(value: unknown) {
  const snapshot = value as PrivateBackupSnapshot | null
  if (!snapshot || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.collections)) {
    throw new Error('invalid snapshot')
  }
  const items: Array<{ collection: string; id: string; metadata: string; hash: string }> = []
  const keys = new Set<string>()
  const add = (collection: string, record: { id: string }) => {
    const id = text(record?.id, 'record id', 128)
    const key = `${collection}\t${id}`
    if (keys.has(key)) throw new Error('invalid duplicate backup item')
    keys.add(key)
    const metadata = JSON.stringify(record)
    items.push({
      collection: text(collection, 'collection', 128),
      id,
      metadata,
      hash: createHash('sha256').update(metadata).digest('hex'),
    })
  }
  for (const record of snapshot.sessions) add('/sessions', record)
  for (const collection of snapshot.collections) {
    const path = text(collection?.path, 'collection path', 128)
    if (path === '/sessions' || !Array.isArray(collection.records)) throw new Error('invalid collection')
    for (const record of collection.records) add(path, record)
  }
  for (const asset of snapshot.assets ?? []) {
    const name = text(asset?.name, 'asset name', 128)
    const key = `/assets\t${name}`
    if (keys.has(key)) throw new Error('invalid duplicate backup item')
    keys.add(key)
    const bytes = Buffer.from(String(asset?.bytesBase64 ?? ''), 'base64')
    if (bytes.toString('base64') !== asset.bytesBase64 || bytes.length !== Number(asset.size)) {
      throw new Error('invalid asset bytes')
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (contentHash !== asset.contentHash) throw new Error('invalid asset hash')
    const hashName = /^([a-f0-9]{64})(?:\.[A-Za-z0-9]{1,12})?$/.exec(name)
    if (
      !['hash', 'name'].includes(asset.storage) ||
      (asset.storage === 'hash' && (hashName?.[1] !== contentHash || asset.etag !== name)) ||
      (asset.storage === 'name' && asset.etag !== contentHash)
    ) {
      throw new Error('invalid asset etag')
    }
    text(asset.mime, 'asset mime', 255)
    // Inline base64 is the small-backup fallback. An object-store adapter can
    // move bytesBase64 behind object_key while keeping this manifest metadata.
    const metadata = JSON.stringify(asset)
    items.push({
      collection: '/assets',
      id: name,
      metadata,
      hash: contentHash,
    })
  }
  if (items.length > MAX_PRIVATE_BACKUP_ITEMS) throw new Error('backup has too many items')
  const bytes = Buffer.byteLength(JSON.stringify(snapshot))
  if (bytes > MAX_PRIVATE_BACKUP_BYTES) throw new Error('backup is too large')
  return items
}

function summary(row: RowDataPacket): PrivateBackupSummary {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    sourceDeviceId: String(row.source_device_id ?? ''),
    workspaceId: String(row.workspace_id ?? ''),
    scope: 'private_backup',
    status: 'ready',
    manifestVersion: Number(row.manifest_version ?? 1),
    itemCount: Number(row.item_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export class PrivateBackupStore {
  private readonly database: string

  constructor(private readonly pool: Queryable, database = 'biu') {
    if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database name: ${database}`)
    this.database = `\`${database}\``
  }

  private table(name: string) {
    return `${this.database}.\`${name}\``
  }

  async create(accountId: string, input: CreatePrivateBackupInput): Promise<PrivateBackupSummary> {
    const owner = text(accountId, 'account id', 64)
    const name = text(input.name, 'backup name', 255)
    const sourceDeviceId = text(input.sourceDeviceId, 'source device id', 64)
    const workspaceId = text(input.workspaceId, 'workspace id', 64)
    const items = snapshotItems(input.snapshot)
    const id = `backup_${randomUUID().replaceAll('-', '')}`
    const now = Date.now()
    const connection = (await this.pool.getConnection()) as Transaction
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.table('cloud_backups')}
          (id, account_id, source_device_id, name, scope, workspace_id, manifest_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'private_backup', ?, 1, 'uploading', ?, ?)`,
        [id, owner, sourceDeviceId, name, workspaceId, now, now],
      )
      for (const item of items) {
        await connection.query(
          `INSERT INTO ${this.table('cloud_backup_items')}
            (backup_id, collection_name, record_id, record_version, content_hash, metadata_json, object_key, updated_at)
           VALUES (?, ?, ?, 1, ?, CAST(? AS JSON), NULL, ?)`,
          [id, item.collection, item.id, item.hash, item.metadata, now],
        )
      }
      await connection.query(
        `UPDATE ${this.table('cloud_backups')} SET status = 'ready', updated_at = ? WHERE id = ?`,
        [now, id],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return {
      id,
      name,
      sourceDeviceId,
      workspaceId,
      scope: 'private_backup',
      status: 'ready',
      manifestVersion: 1,
      itemCount: items.length,
      createdAt: now,
      updatedAt: now,
    }
  }

  async list(accountId: string): Promise<PrivateBackupSummary[]> {
    const owner = text(accountId, 'account id', 64)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT b.*, COUNT(i.record_id) AS item_count
       FROM ${this.table('cloud_backups')} b
       LEFT JOIN ${this.table('cloud_backup_items')} i ON i.backup_id = b.id
       WHERE b.account_id = ? AND b.scope = 'private_backup' AND b.status = 'ready'
       GROUP BY b.id ORDER BY b.updated_at DESC LIMIT 100`,
      [owner],
    )
    return rows.map(summary)
  }

  async read(accountId: string, backupId: string): Promise<PrivateBackup | null> {
    const owner = text(accountId, 'account id', 64)
    const id = text(backupId, 'backup id', 64)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.table('cloud_backups')}
       WHERE id = ? AND account_id = ? AND scope = 'private_backup' AND status = 'ready'`,
      [id, owner],
    )
    if (!rows[0]) return null
    const [itemRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT collection_name, metadata_json, content_hash FROM ${this.table('cloud_backup_items')}
       WHERE backup_id = ? ORDER BY collection_name, record_id`,
      [id],
    )
    const sessions: PrivateBackupSnapshot['sessions'] = []
    const assets: PrivateBackupAsset[] = []
    const collections = new Map<string, PrivateBackupSnapshot['collections'][number]>()
    for (const item of itemRows) {
      const record = (typeof item.metadata_json === 'string'
        ? JSON.parse(item.metadata_json)
        : item.metadata_json) as Record<string, unknown> & { id: string }
      const collection = String(item.collection_name)
      if (collection === '/sessions') sessions.push(record)
      else if (collection === '/assets') {
        const asset = record as unknown as PrivateBackupAsset
        const bytes = Buffer.from(String(asset.bytesBase64 ?? ''), 'base64')
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (
          bytes.toString('base64') !== asset.bytesBase64 ||
          bytes.length !== Number(asset.size) ||
          actual !== String(item.content_hash) ||
          actual !== asset.contentHash
        ) {
          throw new Error(`invalid stored asset: ${asset.name}`)
        }
        assets.push(asset)
      }
      else {
        const target = collections.get(collection) ?? { path: collection, records: [] }
        target.records.push(record)
        collections.set(collection, target)
      }
    }
    return {
      ...summary({ ...rows[0], item_count: itemRows.length } as RowDataPacket),
      snapshot: { sessions, collections: [...collections.values()], assets },
    }
  }

  async delete(accountId: string, backupId: string) {
    const owner = text(accountId, 'account id', 64)
    const id = text(backupId, 'backup id', 64)
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM ${this.table('cloud_backups')}
       WHERE id = ? AND account_id = ? AND scope = 'private_backup'`,
      [id, owner],
    )
    return result.affectedRows > 0
  }
}
