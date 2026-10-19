import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context, Service } from 'cordis'
import { afterEach, expect, test, vi } from 'vitest'
import { AccountService, apply } from './index.ts'

class HttpStub extends Service {
  routes = new Map<string, (route: TestRoute) => Promise<void>>()
  constructor(ctx: Context) {
    super(ctx, 'http')
  }
  route(method: string, path: string, handler: (route: TestRoute) => Promise<void>) {
    this.routes.set(`${method} ${path}`, handler)
  }
}

class TestRoute {
  req = { headers: {} as Record<string, string>, method: 'POST' }
  res = { setHeader: () => undefined }
  query = new URLSearchParams()
  params: Record<string, string> = {}
  status = 0
  payload: unknown
  constructor(private readonly body: unknown = {}) {}
  json() {
    return Promise.resolve(this.body)
  }
  send(status: number, payload: unknown) {
    this.status = status
    this.payload = payload
  }
}

const previousOnline = process.env.BIU_ONLINE
afterEach(() => {
  vi.restoreAllMocks()
  if (previousOnline === undefined) delete process.env.BIU_ONLINE
  else process.env.BIU_ONLINE = previousOnline
})

function localAccount(service: AccountService) {
  const created = service.store.register('Ada', Date.now(), 'password', `ada-${Date.now()}@test.local`)
  const workspaceId = service.store.enter(created.id)
  const session = service.store.openSession(created.id, 'test')
  return { id: created.id, token: session.token, workspaceId }
}

test('private backup API requires authentication', async () => {
  process.env.BIU_ONLINE = '1'
  const ctx = new Context()
  const http = new HttpStub(ctx)
  class Cloud extends Service {
    privateBackups = {}
    creates = 0
    constructor(ctx: Context) {
      super(ctx, 'cloudStorage')
    }
    createPrivateBackup() {
      this.creates += 1
      return Promise.resolve({ id: 'backup-1' })
    }
  }
  const cloud = new Cloud(ctx)
  apply(ctx, { sqlitePath: join(mkdtempSync(join(tmpdir(), 'biu-backup-auth-')), 'biu.sqlite') })
  const route = new TestRoute({
    name: 'backup',
    sourceDeviceId: 'device',
    workspaceId: 'workspace',
    snapshot: { sessions: [], collections: [] },
  })
  await http.routes.get('POST /api/private-backups')!(route)
  expect(route.status).toBe(401)
  expect(cloud.creates).toBe(0)
  await ctx.fiber.dispose()
})

test('desktop uploads a device workspace only after explicit publish', async () => {
  process.env.BIU_ONLINE = '0'
  const ctx = new Context()
  const http = new HttpStub(ctx)
  const assetBytes = Buffer.from('page image')
  const assetHash = createHash('sha256').update(assetBytes).digest('hex')
  class Sessions extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sessionStore')
    }
    listSummaries() {
      return Promise.resolve([{ id: 'session-one', updatedAt: 1 }])
    }
    load() {
      return Promise.resolve({ id: 'session-one', version: 1, events: [], config: { title: 'Agent' } })
    }
  }
  class Database extends Service {
    constructor(ctx: Context) {
      super(ctx, 'database')
    }
    syncedRecords() {
      return Promise.resolve([
        { path: '/pages', records: [{ id: 'page-one', notes: '正文' }] },
        { path: '/tasks', records: [{ id: 'task-one', title: '恢复任务', status: 'todo' }] },
      ])
    }
    exportSnapshotAssets() {
      return Promise.resolve([{
        name: `${assetHash}.png`,
        etag: `${assetHash}.png`,
        mime: 'image/png',
        storage: 'hash' as const,
        size: assetBytes.length,
        contentHash: assetHash,
        bytesBase64: assetBytes.toString('base64'),
      }])
    }
  }
  new Sessions(ctx)
  new Database(ctx)
  apply(ctx, { sqlitePath: join(mkdtempSync(join(tmpdir(), 'biu-backup-publish-')), 'biu.sqlite') })
  const account = ctx.get('account') as AccountService
  const local = localAccount(account)
  account.saveCloudConnection({
    localAccountId: local.id,
    origin: 'https://cloud.test',
    remoteAccountId: 'remote-account',
    remoteName: 'Ada',
    remoteEmail: 'ada@test.local',
    token: 'cloud-token',
  })
  const sent: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')))
    return Response.json({ id: 'backup-1', status: 'ready' }, { status: 201 })
  }))
  expect(sent).toHaveLength(0)

  const route = new TestRoute({
    name: 'My laptop',
    sourceDeviceId: 'device-one',
    workspaceId: local.workspaceId,
  })
  route.req.headers.authorization = `Bearer ${local.token}`
  await http.routes.get('POST /api/private-backups/publish')!(route)

  expect(route.status).toBe(201)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    name: 'My laptop',
    workspaceId: local.workspaceId,
    snapshot: {
      sessions: [{ id: 'session-one' }],
      collections: [
        { path: '/pages', records: [{ id: 'page-one', notes: '正文' }] },
        { path: '/tasks', records: [{ id: 'task-one', title: '恢复任务', status: 'todo' }] },
      ],
      assets: [{ name: `${assetHash}.png`, contentHash: assetHash, bytesBase64: assetBytes.toString('base64') }],
    },
  })
  await ctx.fiber.dispose()
})
