import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from 'cordis'
import * as tools from '@biu/host-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import { apply as applyFileSystem, type DatabaseService } from './index.ts'

type Handler = (route: Record<string, unknown>) => Promise<void> | void
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'biu-saved-view-api-'))
  const previousHome = process.env.BIU_HOME
  const previousOnline = process.env.BIU_ONLINE
  process.env.BIU_HOME = home
  process.env.BIU_ONLINE = '0'
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.BIU_HOME
    else process.env.BIU_HOME = previousHome
    if (previousOnline === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previousOnline
    rmSync(home, { recursive: true, force: true })
  })
  const routes = new Map<string, Handler>()
  const ctx = new Context()
  await ctx.plugin(tools)
  class HttpStub extends Service {
    constructor(c: Context) { super(c, 'http') }
    route(method: string, path: string, handler: Handler) { routes.set(`${method} ${path}`, handler) }
    broadcast() {}
  }
  new HttpStub(ctx)
  await ctx.plugin({ inject: ['tools', 'http'], apply: applyFileSystem })
  const db = (ctx as unknown as { database: DatabaseService }).database
  db.register({
    id: 'notes',
    path: '/notes',
    label: '笔记',
    schema: { fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string', writable: true } } },
    list: () => [],
    get: () => null,
  })
  const post = async (body: unknown) => {
    let status = 0
    let payload: Record<string, unknown> = {}
    await routes.get('POST /api/db/saved-views')!({
      json: async () => body,
      send: (code: number, value: Record<string, unknown>) => { status = code; payload = value },
      req: { headers: {} },
      query: new URLSearchParams(),
    })
    return { status, payload }
  }
  return { post }
}
const view = (id: string, name = id) => ({ id, name, mode: 'table', sortField: 'title', sortDir: 'asc', filters: {}, columns: [] })

describe('POST /api/db/saved-views incremental protocol', () => {
  it('creates, updates with the returned revision, and deletes with a tombstone', async () => {
    const api = await boot()
    const created = await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/notes', id: 'a', view: view('a') }] })
    expect(created).toMatchObject({ status: 200, payload: { ok: true, views: [{ id: 'a', revision: 1 }] } })
    const updated = await api.post({ path: '/notes', mutations: [{ type: 'update', collection: '/notes', id: 'a', expectedRevision: 1, view: view('a', 'renamed') }] })
    expect(updated.payload).toMatchObject({ views: [{ id: 'a', revision: 2 }] })
    const removed = await api.post({ path: '/notes', mutations: [{ type: 'delete', collection: '/notes', id: 'a', expectedRevision: 2 }] })
    expect(removed.payload).toMatchObject({ views: [{ id: 'a', revision: 3, deleted: true }] })
    const revived = await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/notes', id: 'a', view: view('a') }] })
    expect(revived).toMatchObject({ status: 409, payload: { code: 'SAVED_VIEW_CONFLICT' } })
  })

  it('returns 409 for a stale window instead of overwriting', async () => {
    const api = await boot()
    await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/notes', id: 'a', view: view('a') }] })
    await api.post({ path: '/notes', mutations: [{ type: 'update', collection: '/notes', id: 'a', expectedRevision: 1, view: view('a', 'window 1') }] })
    const stale = await api.post({ path: '/notes', mutations: [{ type: 'update', collection: '/notes', id: 'a', expectedRevision: 1, view: view('a', 'window 2') }] })
    expect(stale).toMatchObject({ status: 409, payload: { code: 'SAVED_VIEW_CONFLICT' } })
  })

  it('rejects the legacy full-list protocol without deleting anything', async () => {
    const api = await boot()
    await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/notes', id: 'keep', view: view('keep') }] })
    const legacy = await api.post({ path: '/notes', views: [] })
    expect(legacy).toMatchObject({ status: 409, payload: { code: 'SAVED_VIEW_PROTOCOL' } })
    const still = await api.post({ path: '/notes', mutations: [{ type: 'update', collection: '/notes', id: 'keep', expectedRevision: 1, view: view('keep', 'ok') }] })
    expect(still.status).toBe(200)
  })

  it('rejects mutations aimed at a different collection than the authorized path', async () => {
    const api = await boot()
    const crossed = await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/other', id: 'x', view: view('x') }] })
    expect(crossed).toMatchObject({ status: 400, payload: { code: 'SAVED_VIEW_INVALID' } })
  })

  it('ignores client-supplied ownership and revision fields', async () => {
    const api = await boot()
    const created = await api.post({ path: '/notes', mutations: [{ type: 'create', collection: '/notes', id: 'a', view: { ...view('a'), createdBy: 'mallory', revision: 99 } }] })
    expect(created.payload).toMatchObject({ views: [{ id: 'a', revision: 1 }] })
  })
})
