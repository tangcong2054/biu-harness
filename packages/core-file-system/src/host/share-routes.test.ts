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

async function boot(get: (id: string) => unknown) {
  const home = mkdtempSync(join(tmpdir(), 'biu-share-routes-'))
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
    get: get as never,
  })
  const call = async (key: string, params: Record<string, string>) => {
    let status = 0
    let payload: Record<string, unknown> = {}
    await routes.get(key)!({
      params,
      json: async () => ({}),
      send: (code: number, value: Record<string, unknown>) => { status = code; payload = value },
      req: { headers: {} },
      res: { writeHead: () => {}, end: () => {} },
      query: new URLSearchParams(),
    })
    return { status, payload }
  }
  return { db, call }
}

const note = { id: 'n1', title: 'hello', createdAt: 1, updatedAt: 1 }

describe('public share resource routes', () => {
  it('plugin web.js respects the sharePlugins switch like the source download route', async () => {
    const { db, call } = await boot((id) => (id === 'n1' ? note : null))
    const share = db.shares.upsert({ kind: 'record', collection: '/notes', recordId: 'n1', sharePlugins: false })
    const res = await call('GET /api/share/:token/plugin/:id/web.js', { token: share.token, id: 'page-html-blocks' })
    expect(res.status).toBe(403)
  })

  it('snapshot infrastructure failures are 503 instead of an indistinguishable 404', async () => {
    const { db, call } = await boot(() => { throw new Error('ECONNREFUSED mysql') })
    const share = db.shares.upsert({ kind: 'record', collection: '/notes', recordId: 'n1', sharePlugins: true })
    const file = await call('GET /api/share/:token/file/:name', { token: share.token, name: 'a.png' })
    expect(file.status).toBe(503)
    const web = await call('GET /api/share/:token/plugin/:id/web.js', { token: share.token, id: 'x' })
    expect(web.status).toBe(503)
    const zip = await call('GET /api/share/:token/plugin/:id', { token: share.token, id: 'x' })
    expect(zip.status).toBe(503)
  })

  it('a missing shared target is still a plain 404', async () => {
    const { db, call } = await boot(() => null)
    const share = db.shares.upsert({ kind: 'record', collection: '/notes', recordId: 'gone', sharePlugins: true })
    const file = await call('GET /api/share/:token/file/:name', { token: share.token, name: 'a.png' })
    expect(file.status).toBe(404)
  })
})
