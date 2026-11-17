import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { Context } from 'cordis'
import * as sessionStore from '@biu/host-session-store'
import * as sessions from '@biu/host-sessions'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import { LlmService, nativeReplayRouteKey, ReplayHandoffRequiredError, type LlmConfig, type LlmClient } from '@biu/host-llm'
import { AgentLoop } from './index.ts'

let home: string
const contexts: Context[] = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'biu-handoff-'))
  vi.stubEnv('BIU_HOME', home)
  vi.stubEnv('BIU_ONLINE', '0')
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const a: LlmConfig = { provider: 'openai', model: 'model-a', apiKey: '', baseUrl: 'https://a.test/v1', replayMode: 'native-replay' }
const b: LlmConfig = { provider: 'anthropic', model: 'model-b', apiKey: '', baseUrl: 'https://b.test', replayMode: 'native-replay', thinking: 'enabled' }
const c: LlmConfig = { ...a, model: 'model-c', baseUrl: 'https://c.test/v1' }

type WireMessage = { role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown[] }
type WireRequest = { model: string; messages: WireMessage[] }
function sse(data: unknown[]): Response {
  return new Response(data.map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
function openAiReply(reasoning: string, callId?: string): Response {
  return sse([{ choices: [{ delta: {
    reasoning_content: reasoning,
    ...(callId ? { tool_calls: [{ index: 0, id: callId, function: { name: 'handoff_test', arguments: '{}' } }] } : { content: 'done' }),
  } }] }, '[DONE]'])
}
function anthropicReply(callId?: string): Response {
  const blocks = [
    { type: 'thinking', thinking: 'private-b', signature: 'signed-b' },
    ...(callId ? [{ type: 'tool_use', id: callId, name: 'handoff_test', input: {} }] : [{ type: 'text', text: 'done' }]),
  ]
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    ...blocks.flatMap((content_block, index) => [
      { type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index },
    ]),
    { type: 'message_stop' },
  ])
}
async function spine() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(sessionStore, { driver: 'memory', path: join(home, 'sessions.sqlite') })
  await ctx.plugin(sessions)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  const session = await ctx.sessions.create()
  let calls = 0
  ctx.tools.register({ name: 'handoff_test', description: 'test', parameters: { type: 'object' }, execute: () => {
    calls++
    return 'observed-tool-result'
  } })
  const llm = new LlmService(ctx)
  const run = (config: LlmConfig, text = 'continue', signal = new AbortController().signal) =>
    new AgentLoop(ctx, llm.forConfig(config), session.id, signal, config).run([{ kind: 'wake', text }])
  return { ctx, id: session.id, run, calls: () => calls }
}
async function seedHistory(ctx: Context, id: string, privateSize = 0, source = a) {
  await ctx.sessions.append(id, { type: 'turn/start', turn: 1, replayMode: 'native-replay' })
  await ctx.sessions.append(id, { type: 'user/message', kind: 'wake', text: 'old request' })
  const ref = await ctx.sessions.saveReplay(id, {
    version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(source),
    reasoningField: 'reasoning_content', reasoningContent: 'private-a' + 'z'.repeat(privateSize),
  })
  await ctx.sessions.append(id, { type: 'assistant/message', text: 'old decision', replayRef: ref,
    tool_calls: [{ id: 'old-tool', name: 'handoff_test', arguments: '{}' }],
  })
  await ctx.sessions.append(id, { type: 'tool/result', id: 'old-tool', name: 'handoff_test', ok: false, detail: 'original failure result' })
  await ctx.sessions.append(id, { type: 'turn/end', turn: 1, reason: 'complete' })
  return ref
}

test('A → B → A preserves same-route native state, hands off incompatible exchanges, and never reruns historical tools', async () => {
  const { ctx, id, run, calls } = await spine()
  const requests: WireRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as WireRequest
    requests.push(request)
    if (requests.length === 1) return openAiReply('private-a', 'call-a')
    if (requests.length === 2) return openAiReply('private-a-final')
    if (requests.length === 3) return anthropicReply('call-b')
    if (requests.length === 4) return anthropicReply()
    return openAiReply('a-resumed')
  }))
  assert.equal((await run(a, 'request a')).text, 'done')
  const before = structuredClone(ctx.sessions.peek(id)!.events)
  assert.equal((await run(b, 'request b')).text, 'done')
  assert.equal((await run(a, 'resume a')).text, 'done')
  assert.equal(requests.length, 5)
  assert.equal(calls(), 2)
  const toB = JSON.stringify(requests[2])
  assert.match(toB, /observed-tool-result|call-a/)
  assert.doesNotMatch(toB, /private-a|reasoning_content|signed-b/)
  assert.match(JSON.stringify(requests[3]), /signed-b/)
  assert.ok(requests[4]!.messages.some((message) => message.reasoning_content === 'private-a'))
  assert.ok(requests[4]!.messages.some((message) => message.tool_calls && JSON.stringify(message.tool_calls).includes('call-b')))
  assert.doesNotMatch(JSON.stringify(requests[4]), /private-b|signed-b/)
  const events = ctx.sessions.peek(id)!.events
  assert.deepEqual(events.slice(0, before.length), before)
  assert.equal(events.filter((event) => event.type === 'context/handoff' && event.turn === 2 && event.kind === 'handoff').length, 1)
  assert.doesNotMatch(JSON.stringify(events.filter((event) => event.type === 'context/handoff')), /private-|signed-|routeKey|targetRouteKey/)
  assert.doesNotMatch(JSON.stringify(requests), /replayHistory|targetRouteKey|replayRef/)
})

test('an explicit history rejection permits one budgeted handoff request and subsequent tools stay native', async () => {
  const { ctx, id, run, calls } = await spine()
  const ref = await seedHistory(ctx, id)
  const requests: WireRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    if (requests.length === 1) return new Response(JSON.stringify({ error: { message: 'Missing reasoning_content in assistant tool call history' } }), { status: 400 })
    if (requests.length === 2) return openAiReply('private-c', 'call-c')
    return openAiReply('c-finished')
  }))
  assert.equal((await run(c)).text, 'done')
  assert.equal(requests.length, 3)
  assert.equal(calls(), 1)
  assert.ok(requests[0]!.messages.some((message) => !!message.tool_calls?.length))
  assert.ok(!requests[1]!.messages.some((message) => !!message.tool_calls?.length || message.role === 'tool'))
  assert.match(JSON.stringify(requests[1]), /old-tool|original failure result/)
  assert.ok(requests[2]!.messages.some((message) => message.reasoning_content === 'private-c'))
  const notices = ctx.sessions.peek(id)!.events.filter((event) => event.type === 'context/handoff')
  assert.equal(notices.filter((event) => event.kind === 'handoff').length, 1)
  assert.equal((await ctx.sessions.loadReplay(id, ref)).reasoningContent, 'private-a')
})

test('foreign private bytes are removed before context budget and do not trigger unnecessary compression', async () => {
  const { ctx, id, run } = await spine()
  await seedHistory(ctx, id, 100_000)
  const fetch = vi.fn(async () => openAiReply('private-c'))
  vi.stubGlobal('fetch', fetch)
  assert.equal((await run({ ...c, contextWindowTokens: 5_000, outputReserveTokens: 500 })).text, 'done')
  assert.equal(fetch.mock.calls.length, 1)
  assert.equal(ctx.sessions.peek(id)!.events.some((event) => event.type === 'tool/call' && event.name === 'context_compact_submit'), false)
})

test('trimming an old image turn restores native text-model history before the final request', async () => {
  const { ctx, id, run } = await spine()
  vi.stubEnv('BIU_AUTO_COMPACT', 'off')
  const ds: LlmConfig = { ...a, provider: 'deepseek', model: 'deepseek-v4-flash', contextWindowTokens: 7_000, outputReserveTokens: 500 }
  await ctx.sessions.append(id, { type: 'turn/start', turn: 1 })
  await ctx.sessions.append(id, { type: 'user/message', text: 'old image '.repeat(4_000), kind: 'wake',
    images: [{ name: 'fixture.png', mime: 'image/png', url: 'data:image/png;base64,AA==' }],
  })
  await ctx.sessions.append(id, { type: 'assistant/message', text: 'old image answer' })
  await ctx.sessions.append(id, { type: 'turn/end', turn: 1, reason: 'complete' })
  await seedHistory(ctx, id, 0, ds)
  const requests: WireRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    return openAiReply('resumed')
  }))
  assert.equal((await run(ds, 'current text request')).text, 'done')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.model, 'deepseek-v4-flash')
  assert.ok(requests[0]!.messages.some((message) => message.reasoning_content === 'private-a'))
  assert.doesNotMatch(JSON.stringify(requests), /old image|image_url/)
})

test('strict handoff does not allow budget trimming to drop the active user request', async () => {
  const { ctx, id, run, calls } = await spine()
  await seedHistory(ctx, id)
  vi.stubEnv('BIU_AUTO_COMPACT', 'off')
  const fetch = vi.fn(async () => anthropicReply())
  vi.stubGlobal('fetch', fetch)
  const result = await run({ ...b, contextWindowTokens: 1_000, outputReserveTokens: 100 }, 'current user request '.repeat(2_000))
  assert.match(result.text, /预算/)
  assert.equal(fetch.mock.calls.length, 0)
  assert.equal(calls(), 0)
})

test('handoff expansion is budgeted again before the retry, preserving the active turn atomically', async () => {
  const { ctx, id, calls } = await spine()
  vi.stubEnv('BIU_AUTO_COMPACT', 'off')
  const chat = vi.fn<LlmClient['chat']>(async () => { throw new ReplayHandoffRequiredError() })
  const llm: LlmClient = {
    chat,
    prepareMessages(messages, _tools, options) {
      if (!options?.replayHandoff) return messages
      return [...messages, {
        role: 'user', content: 'expanded recorded history '.repeat(3_000),
        replayHistory: { kind: 'handoff', targetRouteKey: 'target' },
      }]
    },
  }
  const result = await new AgentLoop(ctx, llm, id, new AbortController().signal,
    { ...c, contextWindowTokens: 5_000, outputReserveTokens: 500 }).run([{ kind: 'wake', text: 'current request' }])
  assert.match(result.text, /交接超过模型硬预算/)
  assert.equal(chat.mock.calls.length, 1)
  assert.equal(calls(), 0)
})

for (const status of [401, 429, 500]) {
  test(`upstream ${status} is not retried as a history handoff`, async () => {
    const { ctx, id, run, calls } = await spine()
    await seedHistory(ctx, id)
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'reasoning_content unavailable' } }), { status }))
    vi.stubGlobal('fetch', fetch)
    assert.match((await run(c)).text, /模型调用失败/)
    assert.equal(fetch.mock.calls.length, 1)
    assert.equal(calls(), 0)
  })
}

test('a second history rejection cannot produce a retry loop', async () => {
  const { ctx, id, run, calls } = await spine()
  await seedHistory(ctx, id)
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Missing reasoning_content in assistant tool call history' } }), { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  assert.match((await run(c)).text, /模型调用失败/)
  assert.equal(fetch.mock.calls.length, 2)
  assert.equal(calls(), 0)
})

test('a private state lookup failure cannot become a public history fallback', async () => {
  const { ctx, id, run } = await spine()
  await seedHistory(ctx, id)
  vi.spyOn(ctx.sessions, 'loadReplay').mockRejectedValue(new Error('private state access denied'))
  const fetch = vi.fn(async () => openAiReply('unexpected'))
  vi.stubGlobal('fetch', fetch)
  assert.match((await run(c)).text, /private state access denied/)
  assert.equal(fetch.mock.calls.length, 0)
})

for (const reason of ['stream', 'abort'] as const) {
  test(`handoff retry is disabled after ${reason}`, async () => {
    const { ctx, id, calls } = await spine()
    const controller = new AbortController()
    const chat = vi.fn<LlmClient['chat']>(async (_messages, _tools, _signal, options) => {
      if (reason === 'stream') await options?.onDelta?.('partial')
      else controller.abort()
      throw new ReplayHandoffRequiredError()
    })
    const promise = new AgentLoop(ctx, { chat }, id, controller.signal, c).run([{ kind: 'wake', text: 'request' }])
    if (reason === 'abort') await assert.rejects(promise, /cancelled/)
    else assert.match((await promise).text, /模型调用失败/)
    assert.equal(chat.mock.calls.length, 1)
    assert.equal(calls(), 0)
  })
}
