import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { PrivateBackupStore } from './private-backups.ts'

type BackupRow = Record<string, unknown>
type ItemRow = Record<string, unknown>

class MemoryPool {
  backups: BackupRow[] = []
  items: ItemRow[] = []

  getConnection() {
    return Promise.resolve({
      query: this.query.bind(this),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    })
  }

  async query(sql: string, values: unknown[] = []) {
    if (sql.includes('INSERT INTO') && sql.includes('cloud_backups')) {
      const [id, accountId, sourceDeviceId, name, workspaceId, createdAt, updatedAt] = values
      this.backups.push({
        id, account_id: accountId, source_device_id: sourceDeviceId, name,
        workspace_id: workspaceId, manifest_version: 1, status: 'uploading', created_at: createdAt, updated_at: updatedAt,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('INSERT INTO') && sql.includes('cloud_backup_items')) {
      const [backupId, collectionName, recordId, contentHash, metadataJson, updatedAt] = values
      this.items.push({
        backup_id: backupId, collection_name: collectionName, record_id: recordId,
        content_hash: contentHash, metadata_json: metadataJson, updated_at: updatedAt,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('UPDATE') && sql.includes('cloud_backups')) {
      const [updatedAt, id] = values
      const row = this.backups.find((item) => item.id === id)
      if (row) Object.assign(row, { status: 'ready', updated_at: updatedAt })
      return [{ affectedRows: row ? 1 : 0 }, []]
    }
    if (sql.includes('COUNT(i.record_id)')) {
      const [accountId] = values
      return [
        this.backups
          .filter((row) => row.account_id === accountId && row.status === 'ready')
          .map((row) => ({ ...row, item_count: this.items.filter((item) => item.backup_id === row.id).length })),
        [],
      ]
    }
    if (sql.includes('SELECT *') && sql.includes('cloud_backups')) {
      const [id, accountId] = values
      return [this.backups.filter((row) => row.id === id && row.account_id === accountId && row.status === 'ready'), []]
    }
    if (sql.includes('SELECT collection_name')) {
      const [backupId] = values
      return [this.items.filter((item) => item.backup_id === backupId), []]
    }
    if (sql.includes('DELETE FROM') && sql.includes('cloud_backups')) {
      const [id, accountId] = values
      const before = this.backups.length
      this.backups = this.backups.filter((row) => row.id !== id || row.account_id !== accountId)
      return [{ affectedRows: before - this.backups.length }, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}

test('private backups create, list and enforce account ownership', async () => {
  const pool = new MemoryPool()
  const store = new PrivateBackupStore(pool as never, 'biu_test')
  const assetBytes = Buffer.from('image bytes')
  const assetHash = createHash('sha256').update(assetBytes).digest('hex')
  const created = await store.create('account-a', {
    name: 'Laptop',
    sourceDeviceId: 'device-a',
    workspaceId: 'workspace-local',
    snapshot: {
      sessions: [{ id: 'session-1', title: 'Agent' }],
      collections: [{ path: '/pages', records: [{ id: 'page-1', notes: '正文' }] }],
      assets: [{
        name: `${assetHash}.png`,
        etag: `${assetHash}.png`,
        mime: 'image/png',
        storage: 'hash',
        size: assetBytes.length,
        contentHash: assetHash,
        bytesBase64: assetBytes.toString('base64'),
      }],
    },
  })

  expect(await store.list('account-a')).toMatchObject([{ id: created.id, itemCount: 3 }])
  expect(await store.list('account-b')).toEqual([])
  expect(await store.read('account-b', created.id)).toBeNull()
  expect(await store.delete('account-b', created.id)).toBe(false)
  expect(await store.read('account-a', created.id)).toMatchObject({
    snapshot: {
      sessions: [{ id: 'session-1', title: 'Agent' }],
      collections: [{ path: '/pages', records: [{ id: 'page-1', notes: '正文' }] }],
      assets: [{ name: `${assetHash}.png`, contentHash: assetHash }],
    },
  })

  const storedAsset = pool.items.find((item) => item.collection_name === '/assets')!
  const tampered = JSON.parse(String(storedAsset.metadata_json)) as { bytesBase64: string }
  tampered.bytesBase64 = Buffer.from('tampered').toString('base64')
  storedAsset.metadata_json = JSON.stringify(tampered)
  await expect(store.read('account-a', created.id)).rejects.toThrow(/invalid stored asset/)
})

test('base64 assets remain inside the total 10 MiB manifest limit', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 1)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const store = new PrivateBackupStore(new MemoryPool() as never, 'biu_test')
  await expect(store.create('account-a', {
    name: 'too large',
    sourceDeviceId: 'device-a',
    workspaceId: 'workspace-a',
    snapshot: {
      sessions: [],
      collections: [],
      assets: [{
        name: `${hash}.bin`,
        etag: `${hash}.bin`,
        mime: 'application/octet-stream',
        storage: 'hash',
        size: bytes.length,
        contentHash: hash,
        bytesBase64: bytes.toString('base64'),
      }],
    },
  })).rejects.toThrow(/backup is too large/)
})
