import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { afterEach, test, vi } from 'vitest'
import * as registry from './registry-plugin.ts'
import * as channel from './index.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('registry stays mounted when the agent channel is toggled; registrations survive', async () => {
  // 通道启动会去 bootstrap；这里让它失败，只验证挂载关系，不连真实 WS。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  const ctx = new Context()
  await ctx.plugin(registry)
  assert.ok(ctx.get('uiActions'), 'registry should provide uiActions')

  const dispose = ctx.uiActions.register({
    plugin: 'cdb-logs',
    instanceId: 'block-1',
    kind: 'cdb-logs',
    label: 'CDB 日志',
    actions: { query: { description: '查询', risk: 'read', run: () => 'ok' } },
  })

  const first = await ctx.plugin(channel)
  await first.dispose()
  assert.ok(ctx.get('uiActions'), 'disabling the channel must not unload the registry')

  await ctx.plugin(channel)
  const found = ctx.uiActions.inspect({ plugin: 'cdb-logs', includeDom: false }, 'client-1')
  assert.equal(found.targets.length, 1)
  assert.equal(found.targets[0]?.actions[0]?.id, 'query')
  dispose()
})

test('channel does not mount without the registry', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  const ctx = new Context()
  const fiber = ctx.plugin(channel)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ctx.get('uiActions'), undefined)
  await fiber.dispose()
})
