import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vitest'
import { Context } from 'cordis'
import { Service } from 'cordis'
import type { SessionRecord } from '@biu/type-session'
import { applySnapshot, exchangeSnapshot, forwardCloud, restoreSnapshotSafely, takeSnapshot } from './mirror.ts'

test('cache keeps local sessions and replaces cloud sessions', async () => {
  const ctx = new Context()
  const saved: SessionRecord[] = []
  const rows = new Map<string, { id: string; updatedAt: number; title: string }>([
    ['local', { id: 'local', updatedAt: 50, title: 'keep' }],
    ['cloud', { id: 'cloud', updatedAt: 10, title: 'old-cloud' }],
    ['gone', { id: 'gone', updatedAt: 10, title: 'deleted-on-cloud' }],
  ])
  const remote = new Set(['/sessions\tcloud', '/sessions\tgone'])
  class Places extends Service {
    constructor(ctx: Context) {
      super(ctx, 'account')
    }
    isRemote(collection: string, id: string) {
      return remote.has(`${collection}\t${id}`)
    }
    markRemote(collection: string, id: string) {
      remote.add(`${collection}\t${id}`)
    }
    clearPlace(collection: string, id: string) {
      remote.delete(`${collection}\t${id}`)
    }
    remoteIds(collection: string) {
      return [...remote].filter((key) => key.startsWith(`${collection}\t`)).map((key) => key.split('\t')[1]!)
    }
  }
  class Store extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sessionStore')
    }
    listSummaries() {
      return Promise.resolve([...rows.values()])
    }
    load(id: string) {
      const row = rows.get(id)
      if (!row) return Promise.resolve(null)
      return Promise.resolve({
        id,
        version: 1,
        events: [{ type: 'session/open', version: 1, seq: 0, ts: row.updatedAt }],
        config: { title: row.title },
      } as SessionRecord)
    }
    save(record: SessionRecord & { updatedAt?: number }) {
      saved.push(record)
      rows.set(record.id, {
        id: record.id,
        updatedAt: Number(record.updatedAt) || 0,
        title: record.config?.title || record.id,
      })
      return Promise.resolve()
    }
    delete(id: string) {
      rows.delete(id)
      return Promise.resolve()
    }
  }
  await ctx.plugin(Places)
  await ctx.plugin(Store)
  await applySnapshot(ctx, {
    sessions: [
      { id: 'local', version: 1, updatedAt: 80, events: [], config: { title: 'should-not-win' } },
      { id: 'cloud', version: 1, updatedAt: 30, events: [], config: { title: 'from-cloud' } },
      { id: 'fresh', version: 1, updatedAt: 20, events: [], config: { title: 'new-cloud' } },
    ],
    collections: [],
  }, 'cache')
  assert.deepEqual(saved.map((item) => item.id), ['cloud', 'fresh'])
  assert.equal(rows.get('local')?.title, 'keep')
  assert.equal(rows.get('cloud')?.title, 'from-cloud')
  assert.equal(rows.has('gone'), false)
  const snapshot = await takeSnapshot(ctx)
  assert.equal(snapshot.sessions.find((item) => item.id === 'fresh')?.config?.title, 'new-cloud')

  const incremental = await takeSnapshot(ctx, { since: 25 })
  assert.deepEqual(incremental.sessions.map((item) => item.id), ['local', 'cloud'])
  assert.deepEqual(incremental.sessionIds, ['local', 'cloud', 'fresh'])

  saved.length = 0
  rows.delete('gone')
  await applySnapshot(ctx, {
    sessions: [
      { id: 'cloud', version: 1, updatedAt: 30, events: [], config: { title: 'unchanged-cloud' } },
    ],
    sessionIds: ['cloud', 'fresh'],
    collections: [],
  }, 'cache')
  assert.deepEqual(saved.map((item) => item.id), [])
  assert.equal(rows.has('fresh'), true)
})

test('desktop caches cloud rows but does not copy local records onto the cloud', () => {
  const mirror = readFileSync(resolve(import.meta.dirname, './mirror.ts'), 'utf8')
  const account = readFileSync(resolve(import.meta.dirname, './index.ts'), 'utf8')
  assert.match(mirror, /markRemote/)
  assert.match(mirror, /isRemote/)
  assert.doesNotMatch(mirror, /publishToCloud/)
  assert.doesNotMatch(mirror, /cloudCopyId/)
  assert.doesNotMatch(account, /record_cloud_copy/)
  assert.match(mirror, /workspaceLocation/)
})

test('snapshot application uses one database change batch', async () => {
  const ctx = new Context()
  let batches = 0
  class Database extends Service {
    constructor(ctx: Context) {
      super(ctx, 'database')
    }
    syncedRecords() {
      return Promise.resolve([])
    }
    applySynced() {
      return Promise.resolve()
    }
    async batchChanges<T>(run: () => Promise<T> | T) {
      batches += 1
      return run()
    }
  }
  await ctx.plugin(Database)

  await applySnapshot(ctx, { sessions: [], collections: [] }, 'cache')
  assert.equal(batches, 1)
})

test('safe restore keeps existing records and writes only the missing ones', async () => {
  const ctx = new Context()
  let sessionWrites = 0
  let recordWrites = 0
  class Store extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sessionStore')
    }
    listSummaries() {
      return Promise.resolve([{ id: 'session-existing' }])
    }
    load() {
      return Promise.resolve(null)
    }
    save() {
      sessionWrites += 1
      return Promise.resolve()
    }
  }
  class Database extends Service {
    constructor(ctx: Context) {
      super(ctx, 'database')
    }
    read(path: string) {
      return Promise.resolve(path === '/pages/page-existing' ? { value: { id: 'page-existing' } } : {})
    }
    applySynced() {
      recordWrites += 1
      return Promise.resolve()
    }
    syncedRecords() {
      return Promise.resolve([])
    }
  }
  await ctx.plugin(Store)
  await ctx.plugin(Database)

  const result = await restoreSnapshotSafely(ctx, {
    sessions: [{ id: 'session-existing', version: 1, events: [], config: {} }],
    collections: [{ path: '/pages', records: [{ id: 'page-existing' }, { id: 'page-new' }] }],
  })
  assert.equal(result.restored, true)
  assert.equal(result.restoredRecords, 1)
  assert.equal(sessionWrites, 0)
  assert.equal(recordWrites, 1)
})

test('safe restore revives a trashed record without touching a live one', async () => {
  const ctx = new Context()
  const revived: string[] = []
  let recordWrites = 0
  class Database extends Service {
    constructor(ctx: Context) {
      super(ctx, 'database')
    }
    read(path: string) {
      return path === '/pages/page-live'
        ? Promise.resolve({ value: { id: 'page-live' } })
        : Promise.reject(new Error('unknown record'))
    }
    isRecordDeleted(_path: string, id: string) {
      return id === 'page-trashed'
    }
    reviveDeleted(_path: string, ids: string[]) {
      revived.push(...ids)
      return Promise.resolve(ids)
    }
    applySynced() {
      recordWrites += 1
      return Promise.resolve()
    }
    syncedRecords() {
      return Promise.resolve([])
    }
  }
  await ctx.plugin(Database)

  const result = await restoreSnapshotSafely(ctx, {
    sessions: [],
    collections: [{ path: '/pages', records: [{ id: 'page-live' }, { id: 'page-trashed' }, { id: 'page-new' }] }],
  })
  assert.equal(result.restored, true)
  assert.equal(result.restoredRecords, 2)
  assert.deepEqual(revived, ['page-trashed'])
  assert.equal(recordWrites, 1)
})

test('safe restore validates and restores a referenced CAS asset before records', async () => {
  const ctx = new Context()
  const bytes = Buffer.from('asset bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const restoredAssets: Uint8Array[] = []
  let recordWrites = 0
  class Database extends Service {
    constructor(ctx: Context) {
      super(ctx, 'database')
    }
    read() {
      return Promise.resolve({})
    }
    preflightSnapshotAssets() {
      return Promise.resolve([])
    }
    restoreSnapshotAssets(assets: Array<{ bytes: Uint8Array }>) {
      restoredAssets.push(...assets.map((asset) => asset.bytes))
      return Promise.resolve()
    }
    applySynced() {
      recordWrites += 1
      return Promise.resolve()
    }
    syncedRecords() {
      return Promise.resolve([])
    }
  }
  await ctx.plugin(Database)

  const result = await restoreSnapshotSafely(ctx, {
    sessions: [],
    collections: [{ path: '/pages', records: [{ id: 'page-new', notes: `![x](/api/db/file/${hash}.png)` }] }],
    assets: [{
      name: `${hash}.png`,
      etag: `${hash}.png`,
      mime: 'image/png',
      storage: 'hash',
      size: bytes.length,
      contentHash: hash,
      bytesBase64: bytes.toString('base64'),
    }],
  })
  assert.equal(result.restored, true)
  assert.equal(Buffer.from(restoredAssets[0]!).toString(), 'asset bytes')
  assert.equal(recordWrites, 1)
})

test('tampered asset hash and document conflicts produce zero writes', async () => {
  const bytes = Buffer.from('document')
  const hash = createHash('sha256').update(bytes).digest('hex')
  for (const scenario of ['tampered', 'conflict'] as const) {
    const ctx = new Context()
    let assetWrites = 0
    let recordWrites = 0
    let preflights = 0
    class Database extends Service {
      constructor(ctx: Context) {
        super(ctx, 'database')
      }
      read() {
        return Promise.resolve({})
      }
      preflightSnapshotAssets() {
        preflights += 1
        return Promise.resolve(
          scenario === 'conflict'
            ? [{ collection: '/assets' as const, id: 'board.json', reason: 'content-conflict' }]
            : [],
        )
      }
      restoreSnapshotAssets() {
        assetWrites += 1
        return Promise.resolve()
      }
      applySynced() {
        recordWrites += 1
        return Promise.resolve()
      }
      syncedRecords() {
        return Promise.resolve([])
      }
    }
    await ctx.plugin(Database)
    const result = await restoreSnapshotSafely(ctx, {
      sessions: [],
      collections: [{ path: '/pages', records: [{ id: 'page-new', notes: 'assets/board.json' }] }],
      assets: [{
        name: 'board.json',
        etag: hash,
        mime: 'application/json',
        storage: 'name',
        size: bytes.length,
        contentHash: scenario === 'tampered' ? '0'.repeat(64) : hash,
        bytesBase64: bytes.toString('base64'),
      }],
    })
    assert.equal(result.restored, false)
    assert.equal(assetWrites, 0)
    assert.equal(recordWrites, 0)
    assert.equal(preflights, scenario === 'tampered' ? 0 : 1)
  }
})

test('forwardCloud sends the workspace header to the cloud', async () => {
  const previous = process.env.BIU_REMOTE_ORIGIN
  const realFetch = globalThis.fetch
  const seen: Array<Record<string, string>> = []
  process.env.BIU_REMOTE_ORIGIN = 'http://cloud.test'
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers ?? {})
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const ctx = new Context()
    class Account extends Service {
      store = { activeWorkspaceId: () => 'ws_cloud' }
      constructor(ctx: Context) {
        super(ctx, 'account')
      }
      workspaceLocation() {
        return 'cloud' as const
      }
      isRemote() {
        return true
      }
      linkedCloud() {
        return { origin: 'http://cloud.test', token: 'tok' }
      }
    }
    await ctx.plugin(Account)
    const res = await forwardCloud(ctx, '/pages', 'p079', '/api/db/content', { body: { path: '/pages/p079' } })
    assert.equal(res?.status, 200)
    assert.equal(seen[0]?.['x-biu-workspace-id'], 'ws_cloud')
    assert.equal(seen[0]?.authorization, 'Bearer tok')
  } finally {
    globalThis.fetch = realFetch
    if (previous === undefined) delete process.env.BIU_REMOTE_ORIGIN
    else process.env.BIU_REMOTE_ORIGIN = previous
  }
})

test('replica snapshot exchange does not run without a cloud workspace', async () => {
  const previous = globalThis.fetch
  let called = 0
  globalThis.fetch = (async () => {
    called += 1
    return new Response('{}')
  }) as typeof fetch
  try {
    await exchangeSnapshot(new Context(), 'http://127.0.0.1:9', 'token', 'ada', '')
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = previous
  }
})

test('snapshot watermark survives a new process cache', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'biu-snapshot-watermark-')), 'cloud-sync.sqlite')
  const previous = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    if (urls.length > 1) return new Response('{}', { status: 503 })
    return Response.json({
      sessions: [{ id: 'remote', version: 1, updatedAt: 123, events: [], config: {} }],
      collections: [],
    })
  }) as typeof fetch
  try {
    const options = { watermarkPath: path, watermarkCache: new Map<string, number>() }
    await exchangeSnapshot(new Context(), 'http://cloud.test/', 'token', 'ada', 'ws-one', options)
    await exchangeSnapshot(new Context(), 'http://cloud.test', 'token', 'ada', 'ws-one', {
      watermarkPath: path,
      watermarkCache: new Map<string, number>(),
    })

    assert.equal(urls[0], 'http://cloud.test/api/replica/snapshot')
    assert.equal(urls[1], 'http://cloud.test/api/replica/snapshot?since=123')
    const db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare('SELECT watermark, updated_at FROM snapshot_watermarks').get() as {
      watermark: number
      updated_at: number
    }
    db.close()
    assert.equal(row.watermark, 123)
    assert.ok(row.updated_at > 0)
  } finally {
    globalThis.fetch = previous
  }
})

test('snapshot watermarks are isolated by workspace', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'biu-snapshot-workspaces-')), 'cloud-sync.sqlite')
  const previous = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    if (urls.length > 1) return new Response('{}', { status: 503 })
    return Response.json({
      sessions: [],
      collections: [{ path: '/pages', records: [{ id: 'p1', updatedAt: 200 }] }],
    })
  }) as typeof fetch
  try {
    await exchangeSnapshot(new Context(), 'http://cloud.test', 'token', 'ada', 'ws-a', {
      watermarkPath: path,
      watermarkCache: new Map<string, number>(),
    })
    await exchangeSnapshot(new Context(), 'http://cloud.test', 'token', 'ada', 'ws-b', {
      watermarkPath: path,
      watermarkCache: new Map<string, number>(),
    })
    await exchangeSnapshot(new Context(), 'http://cloud.test', 'token', 'ada', 'ws-a', {
      watermarkPath: path,
      watermarkCache: new Map<string, number>(),
    })

    assert.equal(urls[1], 'http://cloud.test/api/replica/snapshot')
    assert.equal(urls[2], 'http://cloud.test/api/replica/snapshot?since=200')
  } finally {
    globalThis.fetch = previous
  }
})

test('failed snapshot apply does not advance the persisted watermark', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'biu-snapshot-failure-')), 'cloud-sync.sqlite')
  const previous = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    if (urls.length > 1) return new Response('{}', { status: 503 })
    return Response.json({
      sessions: [],
      collections: [{ path: '/pages', records: [{ id: 'p1', updatedAt: 300 }] }],
    })
  }) as typeof fetch
  try {
    const ctx = new Context()
    class FailingDatabase extends Service {
      constructor(ctx: Context) {
        super(ctx, 'database')
      }
      syncedRecords() {
        return Promise.resolve([])
      }
      applySynced() {
        return Promise.reject(new Error('apply failed'))
      }
    }
    await ctx.plugin(FailingDatabase)

    await assert.rejects(
      exchangeSnapshot(ctx, 'http://cloud.test', 'token', 'ada', 'ws-fail', {
        watermarkPath: path,
        watermarkCache: new Map<string, number>(),
      }),
      /apply failed/,
    )
    await exchangeSnapshot(new Context(), 'http://cloud.test', 'token', 'ada', 'ws-fail', {
      watermarkPath: path,
      watermarkCache: new Map<string, number>(),
    })
    assert.equal(urls[1], 'http://cloud.test/api/replica/snapshot')
  } finally {
    globalThis.fetch = previous
  }
})
