import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { test } from 'vitest'
import { WebSocket } from 'ws'
import * as http from '@biu/host-http'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import * as uiActions from './index.ts'

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function eventually(testFn: () => boolean, timeoutMs = 1000) {
  const started = Date.now()
  while (!testFn()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('host tools discover and execute actions through the active browser RPC', async () => {
  const port = await freePort()
  const publicDir = await mkdtemp(join(tmpdir(), 'biu-ui-actions-'))
  const ctx = new Context()
  const httpFiber = await ctx.plugin(http, { port, host: '127.0.0.1', publicDir, sharePort: 0 })
  const toolsFiber = await ctx.plugin(tools)
  const promptFiber = await ctx.plugin(systemPrompt)
  const uiFiber = await ctx.plugin(uiActions)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ui-actions`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({
      type: 'hello',
      clientId: 'browser-test',
      route: '/database/pages/record/p1',
      title: 'Test',
      focused: true,
      registryVersion: 3,
    }))
    socket.on('message', (raw) => {
      const command = JSON.parse(String(raw)) as {
        type: string
        requestId: string
        command: string
        args: Record<string, unknown>
      }
      if (command.type !== 'command') return
      const target = {
        ref: 'ui:websql:main',
        plugin: 'websql',
        instanceId: 'main',
        kind: 'query',
        label: 'WebSQL',
        surface: 'main',
        visible: true,
        actions: [{ id: 'execute', description: '执行', risk: 'submit' }],
      }
      const result =
        command.command === 'inspect'
          ? { clientId: 'browser-test', route: '/', registryVersion: 3, targets: [target] }
          : command.command === 'action'
            ? { ref: target.ref, action: 'execute', risk: 'submit', ok: true, registryVersion: 3 }
            : { ref: target.ref, condition: 'visible', matched: true, elapsedMs: 0, target }
      socket.send(JSON.stringify({ type: 'result', requestId: command.requestId, ok: true, result }))
    })
    await eventually(() => ctx.uiActionsHost.listClients().length === 1)

    const inspected = await ctx.tools.invoke('ui_inspect', { plugin: 'websql' }) as {
      targets: Array<{ ref: string }>
    }
    assert.equal(inspected.targets[0]?.ref, 'ui:websql:main')
    const acted = await ctx.tools.invoke('ui_action', {
      ref: 'ui:websql:main',
      action: 'execute',
    }) as { ok: boolean }
    assert.equal(acted.ok, true)
    const waited = await ctx.tools.invoke('ui_wait', {
      ref: 'ui:websql:main',
      condition: 'visible',
    }) as { matched: boolean }
    assert.equal(waited.matched, true)
  } finally {
    socket.close()
    await uiFiber.dispose()
    await promptFiber.dispose()
    await toolsFiber.dispose()
    await httpFiber.dispose()
  }
})

test('ui tools fail clearly without a connected browser', async () => {
  const ctx = new Context()
  const registered: Array<{ name: string; execute: Function }> = []
  const prompts: string[] = []
  const handler = { current: undefined as undefined | ((socket: WebSocket) => void) }
  Object.assign(ctx, {
    http: {
      ws: (_path: string, next: (socket: WebSocket) => void) => { handler.current = next; return () => {} },
      route: () => () => {},
    },
    tools: { register: (spec: { name: string; execute: Function }) => { registered.push(spec); return () => {} } },
    systemPrompt: { register: (_id: string, text: string) => { prompts.push(text); return () => {} } },
  })
  uiActions.apply(ctx)
  const inspect = registered.find((item) => item.name === 'ui_inspect')
  assert.ok(inspect)
  assert.throws(
    () => inspect!.execute({}, new AbortController().signal),
    /没有已连接的 Biu UI 客户端/,
  )
  assert.match(prompts.join('\n'), /ui_inspect/)
})
