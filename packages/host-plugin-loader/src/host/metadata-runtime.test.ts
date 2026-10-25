import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { runWithRequestWorkspace } from './data-dir.ts'
import { SqliteMetadataRuntime, type MetadataRepository } from './metadata-runtime.ts'

class MemoryRepository implements MetadataRepository {
  rows = new Map<string, Array<Record<string, unknown>>>()

  async list(table: string) {
    return this.rows.get(table)?.map((row) => ({ ...row })) ?? []
  }

  async replaceTable(table: string, rows: Array<Record<string, unknown>>) {
    this.rows.set(table, rows.map((row) => ({ workspace_id: 'ws-a', ...row })))
  }
}

describe('SqliteMetadataRuntime', () => {
  test('mysql hydrates an in-memory overlay and persists selected tables', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE record_meta (
      collection TEXT NOT NULL, record_id TEXT NOT NULL, emoji TEXT,
      PRIMARY KEY(collection, record_id)
    )`)
    const repository = new MemoryRepository()
    repository.rows.set('record_meta', [{
      workspace_id: 'ws-a', collection: '/pages', record_id: 'p1', emoji: '🌱',
    }])
    const runtime = new SqliteMetadataRuntime('mysql', repository, () => db, ['record_meta'])

    await runWithRequestWorkspace('ws-a', async () => {
      await runtime.prepare()
      expect(db.prepare('SELECT emoji FROM record_meta WHERE record_id = ?').get('p1')).toEqual({ emoji: '🌱' })
      db.prepare('UPDATE record_meta SET emoji = ? WHERE record_id = ?').run('🌳', 'p1')
      runtime.changed('record_meta')
      await runtime.flush()
    })

    expect(repository.rows.get('record_meta')?.[0]).toMatchObject({
      workspace_id: 'ws-a',
      collection: '/pages',
      record_id: 'p1',
      emoji: '🌳',
    })
    db.close()
  })

  test('a delete flag is written from the snapshot taken when it changed', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE record_meta (
      collection TEXT NOT NULL, record_id TEXT NOT NULL, emoji TEXT, deleted_at INTEGER,
      PRIMARY KEY(collection, record_id)
    )`)
    const repository = new MemoryRepository()
    repository.rows.set('record_meta', [{
      workspace_id: 'ws-a', collection: '/pages', record_id: 'p1', emoji: '🌱', deleted_at: null,
    }])
    const runtime = new SqliteMetadataRuntime('mysql', repository, () => db, ['record_meta'])

    await runWithRequestWorkspace('ws-a', async () => {
      await runtime.prepare()
      db.prepare(
        `INSERT INTO record_meta (collection, record_id, deleted_at) VALUES ('/pages', 'p2', ?)
         ON CONFLICT(collection, record_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      ).run(50)
      runtime.changed('record_meta')
      db.prepare('DELETE FROM record_meta').run()
      await runtime.flush()
    })

    const saved = repository.rows.get('record_meta') ?? []
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: 'ws-a', record_id: 'p1', emoji: '🌱' }),
      expect.objectContaining({ workspace_id: 'ws-a', record_id: 'p2', deleted_at: 50 }),
    ]))
    db.close()
  })

  test('sqlite mode never calls the remote repository', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE shares (token TEXT PRIMARY KEY)')
    const repository = new MemoryRepository()
    const runtime = new SqliteMetadataRuntime('sqlite', repository, () => db, ['shares'])
    db.prepare('INSERT INTO shares(token) VALUES(?)').run('local')
    runtime.changed('shares')
    await runtime.flush()
    expect(repository.rows.has('shares')).toBe(false)
    db.close()
  })

  test('writes from another instance become visible after the reload window', async () => {
    const previous = process.env.BIU_METADATA_RELOAD_MS
    process.env.BIU_METADATA_RELOAD_MS = '50'
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE record_meta (
      collection TEXT NOT NULL, record_id TEXT NOT NULL, emoji TEXT,
      PRIMARY KEY(collection, record_id)
    )`)
    const repository = new MemoryRepository()
    repository.rows.set('record_meta', [{ workspace_id: 'ws-a', collection: '/pages', record_id: 'p1', emoji: '🌱' }])
    const runtime = new SqliteMetadataRuntime('mysql', repository, () => db, ['record_meta'])
    const emoji = () => (db.prepare('SELECT emoji FROM record_meta WHERE record_id = ?').get('p1') as { emoji?: string })?.emoji
    try {
      await runWithRequestWorkspace('ws-a', async () => {
        await runtime.prepare()
        expect(emoji()).toBe('🌱')
        // 另一台实例直接写了 MySQL。
        repository.rows.set('record_meta', [{ workspace_id: 'ws-a', collection: '/pages', record_id: 'p1', emoji: '🌳' }])
        await runtime.prepare()
        expect(emoji()).toBe('🌱')
        await new Promise((resolve) => setTimeout(resolve, 70))
        await runtime.prepare()
        expect(emoji()).toBe('🌳')
      })
    } finally {
      if (previous === undefined) delete process.env.BIU_METADATA_RELOAD_MS
      else process.env.BIU_METADATA_RELOAD_MS = previous
      db.close()
    }
  })
})
