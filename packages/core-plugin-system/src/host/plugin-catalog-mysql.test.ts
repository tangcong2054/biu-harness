import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { Context, Service } from 'cordis'
import type { RouteContext, RouteHandler } from '@biu/type-http'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { openStore } from './store.ts'

/**
 * `/api/plugins/catalog` 以前只读 `ctx.get('account').store`（同步的 CollabStore）。
 * MySQL 控制面下插件安装关系与成员关系只在云端，本机库是空的，于是 `assigned` 与
 * `canManagePackages` 恒为 false。现在路由优先走账号服务的异步方法。
 */

const dirs: string[] = []
const contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    const disposable = ctx as unknown as { dispose?: () => unknown }
    void disposable.dispose?.()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type CatalogBody = {
  plugins: Array<{ id: string; assigned?: boolean }>
  canManagePackages: boolean
}

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'biu-plugin-catalog-'))
  dirs.push(dir)
  // 只改这三个：defaultPluginDir/State/Sandbox 只读它们，且不涉及进程级的
  // BIU_ONLINE / BIU_HOME，避免和并行跑的其它测试互相污染。
  process.env.BIU_PLUGIN_DIR = join(dir, '.plugin')
  process.env.BIU_PLUGIN_DEV_DIR = join(dir, '.plugin-dev')
  process.env.BIU_PLUGIN_STATE = join(dir, '.plugin', 'store.json')

  const handlers = new Map<string, RouteHandler>()

  class FakeHttp extends Service {
    constructor(inner: Context) {
      super(inner, 'http')
    }
    route(_method: string, path: string, handler: RouteHandler) {
      handlers.set(path, handler)
      return { dispose() {} }
    }
  }

  /** 云端视角：acc_ada 在 ws_a 装了 demo。 */
  class FakeAccount extends Service {
    constructor(inner: Context) {
      super(inner, 'account')
    }
    usesMysqlAccounts() {
      return true
    }
    mysql = null
    async canAccessPlugin(accountId: string, workspaceId: string, pluginId: string) {
      return accountId === 'acc_ada' && workspaceId === 'ws_a' && pluginId === 'demo'
    }
    async isMemberAsync(accountId: string, workspaceId: string) {
      return accountId === 'acc_ada' && workspaceId === 'ws_a'
    }
    async pluginLoadsFor(_accountId: string, _workspaceId: string) {
      return ['demo']
    }
    async loadedPluginIds() {
      return ['demo']
    }
  }

  class FakeHub extends Service {
    constructor(inner: Context) {
      super(inner, 'hub')
    }
    [key: string]: unknown
    snapshot() {
      return { plugins: [] }
    }
  }

  const ctx = new Context()
  contexts.push(ctx)
  new FakeHttp(ctx)
  new FakeAccount(ctx)
  new FakeHub(ctx)
  return { ctx, handlers, dir }
}

async function callCatalog(handlers: Map<string, RouteHandler>) {
  const handler = handlers.get('/api/plugins/catalog')
  assert.ok(handler, 'catalog route was not registered')
  const captured: { body: CatalogBody | null } = { body: null }
  let status = 0
  const route = {
    req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res: { writeHead() {}, end() {} },
    params: {},
    query: new URLSearchParams(),
    json: () => Promise.resolve({}),
    bytes: () => Promise.resolve(Buffer.alloc(0)),
    send(code: number, body: unknown) {
      status = code
      captured.body = body as CatalogBody
    },
  } as unknown as RouteContext
  await handler(route)
  return { status, body: captured.body }
}

test('catalog reports the viewer install state from the cloud control plane', async () => {
  const previousPluginDir = process.env.BIU_PLUGIN_DIR
  const previousDevDir = process.env.BIU_PLUGIN_DEV_DIR
  const previousState = process.env.BIU_PLUGIN_STATE
  try {
    const { ctx, handlers, dir } = boot()
    const pluginDir = join(dir, '.plugin', 'demo')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({ id: 'demo', name: 'demo', blurb: '', tags: [], author: '', authorUrl: '' }),
    )
    await openStore(ctx)
    const result = await runWithAccount('acc_ada', () =>
      runWithRequestWorkspace('ws_a', () => callCatalog(handlers)),
    )
    assert.equal(result.status, 200)
    const row = result.body?.plugins.find((item: { id: string; assigned?: boolean }) => item.id === 'demo')
    assert.ok(row, 'demo plugin should be listed')
    // 云端控制面说这个账号在当前空间装了 demo，catalog 就必须报 assigned。
    assert.equal(row.assigned, true)
    assert.equal(result.body?.canManagePackages, true)

    // 不在这个空间：assigned 为 false。
    const outsider = await runWithAccount('acc_bob', () =>
      runWithRequestWorkspace('ws_a', () => callCatalog(handlers)),
    )
    const outsiderRow = outsider.body?.plugins.find((item: { id: string; assigned?: boolean }) => item.id === 'demo')
    assert.equal(outsiderRow?.assigned, false)
  } finally {
    if (previousPluginDir === undefined) delete process.env.BIU_PLUGIN_DIR
    else process.env.BIU_PLUGIN_DIR = previousPluginDir
    if (previousDevDir === undefined) delete process.env.BIU_PLUGIN_DEV_DIR
    else process.env.BIU_PLUGIN_DEV_DIR = previousDevDir
    if (previousState === undefined) delete process.env.BIU_PLUGIN_STATE
    else process.env.BIU_PLUGIN_STATE = previousState
  }
})
