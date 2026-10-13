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
import * as approvals from '@biu/host-approvals'
import { runWithSession } from '@biu/host-sessions/scope'
import * as uiActions from './index.ts'
import { UI_ACTIONS_PROTOCOL_VERSION } from '../protocol.ts'

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
  const previousLogDir = process.env.BIU_UI_ACTION_LOG_DIR
  process.env.BIU_UI_ACTION_LOG_DIR = join(publicDir, 'logs')
  const ctx = new Context()
  const httpFiber = await ctx.plugin(http, { port, host: '127.0.0.1', publicDir, sharePort: 0 })
  const toolsFiber = await ctx.plugin(tools)
  const promptFiber = await ctx.plugin(systemPrompt)
  const approvalsFiber = await ctx.plugin(approvals)
  const uiFiber = await ctx.plugin(uiActions)
  const bootstrap = await fetch(`http://127.0.0.1:${port}/api/ui-actions/bootstrap`).then((res) => res.json()) as {
    token: string
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ui-actions?uiToken=${bootstrap.token}`)
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
      sessionId: 's1',
      focused: true,
      registryVersion: 3,
      protocolVersion: UI_ACTIONS_PROTOCOL_VERSION,
      targetCount: 1,
    }))
    const commands: string[] = []
    const cancelled: string[] = []
    socket.on('message', (raw) => {
      const command = JSON.parse(String(raw)) as {
        type: string
        requestId: string
        command?: string
        args: Record<string, unknown>
      }
      if (command.type === 'cancel') {
        cancelled.push(command.requestId)
        return
      }
      if (command.type !== 'command') return
      commands.push(command.command!)
      if (command.command === 'wait' && command.args.value === 'never') return
      const danger = command.args.ref === 'ui:demo:danger'
      const target = {
        ref: danger ? 'ui:demo:danger' : 'ui:websql:main',
        plugin: danger ? 'demo' : 'websql',
        instanceId: 'main',
        kind: 'query',
        label: danger ? 'Danger' : 'WebSQL',
        surface: 'main',
        visible: true,
        actions: [danger
          ? { id: 'delete', description: '删除', risk: 'destructive' }
          : { id: 'execute', description: '执行', risk: 'submit' }],
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
    await ctx.tools.invoke('ui_inspect', { plugin: 'websql' })
    assert.equal(commands.filter((command) => command === 'inspect').length, 1)
    socket.send(JSON.stringify({
      type: 'registry-changed',
      clientId: 'browser-test',
      registryVersion: 4,
      targetCount: 1,
    }))
    await eventually(() => ctx.uiActionsHost.listClients()[0]?.registryVersion === 4)
    await ctx.tools.invoke('ui_inspect', { plugin: 'websql' })
    assert.equal(commands.filter((command) => command === 'inspect').length, 2)
    const acted = await ctx.tools.invoke('ui_action', {
      ref: 'ui:websql:main',
      action: 'execute',
    }) as { ok: boolean }
    assert.equal(acted.ok, true)
    ctx.approvals.mode = 'hold'
    const held = ctx.tools.invoke('ui_action', {
      ref: 'ui:websql:main',
      action: 'execute',
    })
    await eventually(() => ctx.approvals.list().length === 1)
    ctx.approvals.decide(ctx.approvals.list()[0]!.id, true)
    assert.equal((await held as { ok: boolean }).ok, true)
    ctx.approvals.mode = 'auto'
    const waited = await ctx.tools.invoke('ui_wait', {
      ref: 'ui:websql:main',
      condition: 'visible',
    }) as { matched: boolean }
    assert.equal(waited.matched, true)
    const abort = new AbortController()
    const waiting = ctx.tools.invoke('ui_wait', {
      ref: 'ui:websql:main',
      condition: 'text-includes',
      value: 'never',
    }, abort.signal)
    await eventually(() => commands.filter((command) => command === 'wait').length >= 2)
    abort.abort()
    await assert.rejects(() => waiting, /cancelled/)
    await eventually(() => cancelled.length === 1)
    await assert.rejects(
      () => runWithSession('other-session', () => ctx.tools.invoke('ui_inspect', { plugin: 'websql' })),
      /没有绑定的 UI 客户端/,
    )

    const destructive = ctx.tools.invoke('ui_action', {
      ref: 'ui:demo:danger',
      action: 'delete',
    })
    await eventually(() => ctx.approvals.list().length === 1)
    const [approval] = ctx.approvals.list()
    assert.equal(approval?.name, 'ui_action')
    ctx.approvals.decide(approval!.id, true)
    assert.equal((await destructive as { ok: boolean }).ok, true)

    const denied = await fetch(`http://127.0.0.1:${port}/api/ui-actions/bootstrap`, {
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(denied.status, 403)
    await ctx.uiActionsHost.observability.flush()
    const metrics = await fetch(`http://127.0.0.1:${port}/api/ui-actions/metrics`).then((res) => res.json()) as {
      byCommand: Record<string, number>
      byEvent: Record<string, number>
    }
    assert.ok(metrics.byCommand.inspect >= 1)
    assert.ok(metrics.byEvent.succeeded >= 1)
  } finally {
    socket.close()
    await uiFiber.dispose()
    await approvalsFiber.dispose()
    await promptFiber.dispose()
    await toolsFiber.dispose()
    await httpFiber.dispose()
    if (previousLogDir === undefined) delete process.env.BIU_UI_ACTION_LOG_DIR
    else process.env.BIU_UI_ACTION_LOG_DIR = previousLogDir
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
