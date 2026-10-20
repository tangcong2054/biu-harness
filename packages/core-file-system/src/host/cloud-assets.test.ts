import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { Context, Service } from 'cordis'
import { hashedAssetName } from '@biu/host-plugin-loader/data-dir'
import { DatabaseService } from './index.ts'
import { FileSystemAssets } from './assets-store.ts'
import { REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('snapshot asset export includes referenced files once and excludes orphans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-assets-'))
  dirs.push(dir)
  const ctx = new Context()
  const db = new DatabaseService(ctx)
  db.assets = new FileSystemAssets(dir)
  const referenced = await db.assets.write('photo.png', Buffer.from('referenced'))
  await db.assets.write('orphan.png', Buffer.from('not referenced'))
  await db.assets.writeDoc('board.json', Buffer.from('{"ok":true}'))

  const assets = await db.exportSnapshotAssets([
    {
      id: 'page-one',
      notes: `![a](/api/db/file/${referenced.name})\n![again](/api/db/file/${referenced.name})`,
      board: { file: 'assets/board.json' },
    },
  ])

  assert.deepEqual(assets.map((asset) => asset.name), [referenced.name, 'board.json'].sort())
  assert.equal(assets[0]?.bytesBase64.length > 0, true)
  const withMissing = await db.exportSnapshotAssets([
    { id: 'page-two', notes: `![gone](/api/db/file/missing-file.png)\n![ok](/api/db/file/${referenced.name})` },
  ])
  assert.deepEqual(withMissing.map((asset) => asset.name), [referenced.name])

  const restoredDir = await mkdtemp(join(tmpdir(), 'restored-assets-'))
  dirs.push(restoredDir)
  const restoredDb = new DatabaseService(new Context())
  restoredDb.assets = new FileSystemAssets(restoredDir)
  assert.deepEqual(await restoredDb.preflightSnapshotAssets(assets), [])
  await restoredDb.restoreSnapshotAssets(
    assets.map(({ bytesBase64, size: _size, ...asset }) => ({
      ...asset,
      bytes: Buffer.from(bytesBase64, 'base64'),
    })),
  )
  assert.equal((await restoredDb.assets.read(referenced.name)).bytes.toString(), 'referenced')
  assert.equal((await restoredDb.assets.readDoc('board.json')).bytes.toString(), '{"ok":true}')

  const conflictDir = await mkdtemp(join(tmpdir(), 'conflicting-assets-'))
  dirs.push(conflictDir)
  const conflictDb = new DatabaseService(new Context())
  conflictDb.assets = new FileSystemAssets(conflictDir)
  await conflictDb.assets.writeDoc('board.json', Buffer.from('different'))
  assert.deepEqual(await conflictDb.preflightSnapshotAssets(assets), [
    { collection: '/assets', id: 'board.json', reason: 'content-conflict' },
  ])
})

test('cloud workspace syncs CAS writes and misses while device and failures stay local-safe', async () => {
  const previousOnline = process.env.BIU_ONLINE
  const previousOrigin = process.env.BIU_REMOTE_ORIGIN
  const realFetch = globalThis.fetch
  process.env.BIU_ONLINE = '0'
  process.env.BIU_REMOTE_ORIGIN = 'http://cloud.test'
  const calls: Array<{ url: string; method: string; headers: Headers; bytes: Buffer }> = []
  let location: 'device' | 'cloud' = 'device'
  let failure = false
  const remoteAssets = new Map<string, Buffer>()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const bytes = init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0)
    calls.push({ url, method: init?.method ?? 'GET', headers, bytes })
    if (failure) return Response.json({ error: 'cloud unavailable' }, { status: 503 })
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    if ((init?.method ?? 'GET') === 'GET') {
      const body = remoteAssets.get(name)
      return body
        ? new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { status: 200 })
        : Response.json({ error: 'not found' }, { status: 404 })
    }
    const written = hashedAssetName(bytes, name)
    remoteAssets.set(written, bytes)
    return Response.json({ ok: true, name: written })
  }) as typeof fetch

  const dir = await mkdtemp(join(tmpdir(), 'cloud-assets-'))
  dirs.push(dir)
  const ctx = new Context()
  class Account extends Service {
    store = {
      activeWorkspaceId: () => (location === 'cloud' ? 'ws-cloud' : 'ws-device'),
      membership: () => null,
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
    workspaceLocation() {
      return location
    }
    linkedCloud() {
      return { origin: 'http://cloud.test', token: 'cloud-token' }
    }
  }
  await ctx.plugin(Account)
  const db = new DatabaseService(ctx)
  db.assets = new FileSystemAssets(dir)
  const record: Record<string, unknown> = { id: 'p1', title: 'Page', notes: '' }
  db.register({
    id: 'pages',
    path: '/pages',
    schema: {
      contentField: 'notes',
      fields: { ...REQUIRED_RECORD_FIELDS, notes: { type: 'file', label: '正文', writable: true } },
    },
    records: { update: true },
    list: async () => [record as { id: string }],
    get: async (id) => (id === 'p1' ? record as { id: string } : null),
    update: async (_id, patch) => Object.assign(record, patch) as { id: string },
  })

  try {
    const device = await db.editAsset('/pages/p1', { command: 'write', name: 'device.png', value: 'device' })
    assert.equal(calls.length, 0)
    assert.equal((await db.assets.read(String(device.name))).bytes.toString(), 'device')

    location = 'cloud'
    const cloud = await db.editAsset('/pages/p1', { command: 'write', name: 'cloud.png', value: 'cloud' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'PUT')
    assert.equal(calls[0]?.headers.get('x-biu-workspace-id'), 'ws-cloud')
    assert.equal(calls[0]?.headers.get('x-biu-resource-path'), '/pages/p1')
    assert.equal(calls[0]?.bytes.toString(), 'cloud')
    assert.equal((await db.assets.read(String(cloud.name))).bytes.toString(), 'cloud')

    const missedBytes = Buffer.from('from-online')
    const missedName = hashedAssetName(missedBytes, 'missed.png')
    remoteAssets.set(missedName, missedBytes)
    record.notes = `![remote](/api/db/file/${missedName})`
    const viewed = await db.editAsset('/pages/p1', { command: 'view', name: missedName })
    assert.equal((viewed as { text?: string }).text, undefined)
    assert.equal((await db.assets.read(missedName)).bytes.toString(), 'from-online')
    assert.equal(calls.at(-1)?.headers.get('x-biu-workspace-id'), 'ws-cloud')

    failure = true
    await assert.rejects(
      () => db.editAsset('/pages/p1', { command: 'write', name: 'failed.png', value: 'failed' }),
      /cloud unavailable/,
    )
    const failedName = hashedAssetName(Buffer.from('failed'), 'failed.png')
    await assert.rejects(() => db.assets.read(failedName))
    assert.equal((await db.assets.read(String(cloud.name))).bytes.toString(), 'cloud')
  } finally {
    globalThis.fetch = realFetch
    if (previousOnline === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previousOnline
    if (previousOrigin === undefined) delete process.env.BIU_REMOTE_ORIGIN
    else process.env.BIU_REMOTE_ORIGIN = previousOrigin
  }
})
