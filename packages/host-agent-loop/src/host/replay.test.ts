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
import { LlmService, type LlmClient, type LlmConfig, type LlmMessage, type NativeReplay } from '@biu/host-llm'
import { AgentLoop } from './index.ts'
import { buildAutoCompactMessages } from './context-policy.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'biu-loop-replay-'))
  vi.stubEnv('BIU_HOME', home)
  vi.stubEnv('BIU_ONLINE', '0')
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const replay: NativeReplay = {
  version: 1,
  complete: true,
  protocol: 'openai-compat',
  routeKey: 'test-route',
  reasoningField: 'reasoning_content',
  reasoningContent: 'private-reasoning-fixture',
}
const config = (replayMode: LlmConfig['replayMode']): LlmConfig => ({
  provider: 'openai', model: 'test', apiKey: '', replayMode,
})

async function spine() {
  const ctx = new Context()
  await ctx.plugin(sessionStore, { driver: 'memory' })
  await ctx.plugin(sessions)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  const session = await ctx.sessions.create()
  let calls = 0
  ctx.tools.register({ name: 'replay_test', description: 'test', parameters: { type: 'object' }, execute: () => {
    calls++
    return 'tool-result'
  } })
  return { ctx, sessionId: session.id, calls: () => calls }
}

for (const mode of ['lean-replay', 'native-replay'] as const) {
  test(`${mode} keeps tool execution unchanged and selects only its request projection`, async () => {
    const { ctx, sessionId, calls } = await spine()
    const seen: LlmMessage[][] = []
    const llm: LlmClient = { async chat(messages, _tools, _signal, options) {
      assert.equal(options?.replayMode, mode)
      seen.push(structuredClone(messages))
      return seen.length === 1
        ? { content: null, toolCalls: [{ id: 'call-1', name: 'replay_test', arguments: '{}' }], replay }
        : { content: 'done', toolCalls: [], replay }
    } }
    const turn = await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, config(mode))
      .run([{ kind: 'wake', text: 'run a tool' }])
    assert.equal(turn.text, 'done')
    assert.equal(calls(), 1)
    const assistant = seen[1]!.find((message) => message.role === 'assistant')!
    assert.equal(assistant.replayRef, undefined)
    if (mode === 'native-replay') assert.deepEqual(assistant.replay, replay)
    else assert.equal(assistant.replay, undefined)
    const events = (await ctx.sessions.require(sessionId)).events
    const saved = events.filter((event) => event.type === 'assistant/message')
    assert.equal(saved.length, 2)
    for (const event of saved) assert.equal(typeof event.replayRef, 'string')
    assert.doesNotMatch(JSON.stringify(events), /private-reasoning-fixture|test-route/)
    assert.equal(events.find((event) => event.type === 'turn/start')?.replayMode, mode)
    assert.equal(events.at(-1)?.type, 'turn/end')
  })
}

test('captures in lean mode and restores in a later native turn without mutating a running turn', async () => {
  const { ctx, sessionId } = await spine()
  const settings = config('lean-replay')
  let count = 0
  const llm: LlmClient = { async chat(messages, _tools, _signal, options) {
    count++
    if (count === 1) {
      settings.replayMode = 'native-replay'
      return { content: '', toolCalls: [{ id: 'call-1', name: 'replay_test', arguments: '{}' }], replay }
    }
    assert.equal(options?.replayMode, count === 2 ? 'lean-replay' : 'native-replay')
    for (const message of messages.filter((item) => item.role === 'assistant')) {
      assert.equal(Boolean(message.replay), count === 3)
    }
    return { content: 'done', toolCalls: [], replay }
  } }
  await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, settings)
    .run([{ kind: 'wake', text: 'first' }])
  await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, settings)
    .run([{ kind: 'wake', text: 'second' }])
  assert.equal(count, 3)
})

test('one session can switch native to lean and back without deleting either turns replay state', async () => {
  const { ctx, sessionId } = await spine()
  const modes = ['native-replay', 'lean-replay', 'native-replay'] as const
  let turn = 0
  const llm: LlmClient = { async chat(messages, _tools, _signal, options) {
    assert.equal(options?.replayMode, modes[turn])
    const history = messages.filter((message) => message.role === 'assistant')
    assert.equal(history.length, turn)
    for (const [index, message] of history.entries()) {
      assert.equal(message.content, `answer-${index}`)
      if (modes[turn] === 'native-replay') {
        assert.equal(message.replay?.reasoningContent, `reasoning-${index}`)
      } else {
        assert.equal(message.replay, undefined)
      }
    }
    return { content: `answer-${turn}`, toolCalls: [], replay: { ...replay, reasoningContent: `reasoning-${turn}` } }
  } }
  for (const mode of modes) {
    const result = await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, config(mode))
      .run([{ kind: 'wake', text: `question-${turn}` }])
    assert.equal(result.text, `answer-${turn}`)
    turn++
  }
  const events = (await ctx.sessions.require(sessionId)).events
  assert.deepEqual(events.filter((event) => event.type === 'turn/start').map((event) => event.replayMode), modes)
  assert.equal(events.filter((event) => event.type === 'assistant/message' && event.replayRef).length, 3)
})

test('a missing private replay stops before requesting a model and closes the turn', async () => {
  const { ctx, sessionId, calls } = await spine()
  await ctx.sessions.append(sessionId, { type: 'user/message', text: 'previous', kind: 'wake' })
  await ctx.sessions.append(sessionId, {
    type: 'assistant/message', text: 'previous reply', replayRef: '11111111-1111-4111-8111-111111111111',
  })
  const chat = vi.fn(async () => ({ content: 'unexpected', toolCalls: [] }))
  const result = await new AgentLoop(ctx, { chat }, sessionId, new AbortController().signal, config('native-replay'))
    .run([{ kind: 'wake', text: 'continue' }])
  assert.match(result.text, /模型调用失败/)
  assert.equal(chat.mock.calls.length, 0)
  assert.equal(calls(), 0)
  const last = (await ctx.sessions.require(sessionId)).events.at(-1)
  assert.equal(last?.type, 'turn/end')
  assert.equal(last?.type === 'turn/end' && last.reason, 'llm-error')
})

test('a replay write failure cannot execute tools or retry with another strategy', async () => {
  const { ctx, sessionId, calls } = await spine()
  vi.spyOn(ctx.sessions, 'saveReplay').mockRejectedValue(new Error('replay storage failed'))
  const chat = vi.fn(async () => ({
    content: '', toolCalls: [{ id: 'call-1', name: 'replay_test', arguments: '{}' }], replay,
  }))
  const result = await new AgentLoop(ctx, { chat }, sessionId, new AbortController().signal, config('native-replay'))
    .run([{ kind: 'wake', text: 'run' }])
  assert.match(result.text, /replay storage failed/)
  assert.equal(chat.mock.calls.length, 1)
  assert.equal(calls(), 0)
})

test('preserves the exact assistant text paired with native blocks', async () => {
  const { ctx, sessionId } = await spine()
  const text = '\n  public answer  \n'
  const native: NativeReplay = { version: 1, complete: true, protocol: 'anthropic', routeKey: 'test-route', blocks: [
    { type: 'thinking', thinking: 'private', signature: 'signature-fixture' },
    { type: 'text', text },
  ] }
  const llm: LlmClient = { async chat() { return { content: text, toolCalls: [], replay: native } } }
  await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, config('native-replay'))
    .run([{ kind: 'wake', text: 'test' }])
  assert.equal(ctx.sessions.deriveMessages(sessionId).at(-1)?.content, text)
})

test('real LlmService and loop replay captured SSE state in the next outbound tool request', async () => {
  const { ctx, sessionId, calls } = await spine()
  const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const delta = bodies.length === 1
      ? { reasoning_content: 'choose read-only test tool', tool_calls: [
        { index: 0, id: 'native-call', function: { name: 'replay_test', arguments: '{}' } },
      ] }
      : { reasoning_content: 'result checked', content: 'done' }
    const data = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } })
  }))
  const settings = { ...config('native-replay'), baseUrl: 'https://replay-fixture.test/v1' }
  const llm = new LlmService(ctx).forConfig(settings)
  const result = await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, settings)
    .run([{ kind: 'wake', text: 'test request' }])
  assert.equal(result.text, 'done')
  assert.equal(calls(), 1)
  assert.equal(bodies.length, 2)
  const previous = bodies[1]!.messages.find((message) => message.role === 'assistant')!
  assert.equal(previous.reasoning_content, 'choose read-only test tool')
  assert.doesNotMatch(JSON.stringify(bodies), /replayRef|routeKey|replayMissing/)
})

for (const mode of ['lean-replay', 'native-replay'] as const) {
  test(`${mode} completes a DeepSeek-named gateway tool loop with mixed reasoning and non-reasoning replies`, async () => {
    const { ctx, sessionId, calls } = await spine()
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    const reasoning: Array<string | null | undefined> = ['first decision', undefined, null, '', 'next decision']
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      const index = bodies.length - 1
      const delta = index < reasoning.length
        ? {
          ...(reasoning[index] !== undefined ? { reasoning_content: reasoning[index] } : {}),
          tool_calls: [{ index: 0, id: `mixed-call-${index}`, function: { name: 'replay_test', arguments: '{}' } }],
        }
        : { content: 'done' }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    const settings: LlmConfig = {
      ...config(mode), model: 'deepseek-v4-flash', thinking: 'enabled',
      endpointId: 'custom-fixture', baseUrl: 'https://replay-fixture.test/v1',
    }
    const result = await new AgentLoop(ctx, new LlmService(ctx).forConfig(settings), sessionId,
      new AbortController().signal, settings).run([{ kind: 'wake', text: 'test mixed replies' }])
    assert.equal(result.text, 'done')
    assert.equal(calls(), reasoning.length)
    assert.equal(bodies.length, reasoning.length + 1)
    const assistants = bodies.at(-1)!.messages.filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, reasoning.length)
    for (const [index, message] of assistants.entries()) {
      if (mode === 'native-replay' && typeof reasoning[index] === 'string') {
        assert.equal(message.reasoning_content, reasoning[index])
      } else {
        assert.equal('reasoning_content' in message, false)
      }
    }
    assert.doesNotMatch(JSON.stringify(bodies), /replayRef|routeKey|replayMissing/)
  })
}

test('model-generated invalid tool JSON is reported back instead of ending the native turn', async () => {
  const { ctx, sessionId } = await spine()
  const received: unknown[] = []
  ctx.tools.register({ name: 'job_collect', description: 'test', parameters: { type: 'object' }, execute: (args) => {
    received.push(args)
    return 'collected'
  } })
  const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const delta = bodies.length === 1
      ? { reasoning_content: 'collect', tool_calls: [{ index: 0, id: 'bad', function: { name: 'job_collect', arguments: '{"id": 31830dc7}' } }] }
      : bodies.length === 2
        ? { reasoning_content: 'fix quotes', tool_calls: [{ index: 0, id: 'good', function: { name: 'job_collect', arguments: '{"id": "31830dc7"}' } }] }
        : { content: 'done' }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }))
  const settings: LlmConfig = { ...config('native-replay'), model: 'deepseek-v4-flash', baseUrl: 'https://replay-fixture.test/v1' }
  const result = await new AgentLoop(ctx, new LlmService(ctx).forConfig(settings), sessionId,
    new AbortController().signal, settings).run([{ kind: 'wake', text: 'collect job' }])
  assert.equal(result.text, 'done')
  assert.deepEqual(received, [{ id: '31830dc7' }])
  const events = (await ctx.sessions.require(sessionId)).events
  const bad = events.find((event) => event.type === 'tool/result' && event.id === 'bad')
  assert.equal(bad?.type === 'tool/result' && bad.ok, false)
  assert.match(bad?.type === 'tool/result' ? bad.detail : '', /不是合法的 JSON[\s\S]*未执行[\s\S]*31830dc7/)
  const secondRequestTool = bodies[1]!.messages.find((message) => message.role === 'tool')
  assert.match(String(secondRequestTool?.content), /未执行/)
  const firstAssistant = bodies[1]!.messages.find((message) => message.role === 'assistant')
  assert.equal(firstAssistant?.reasoning_content, 'collect')
  assert.equal(events.at(-1)?.type === 'turn/end' && events.at(-1)?.reason, 'complete')
})

test('invalid tool arguments never reach tool execution or approval for non-object JSON', async () => {
  const { ctx, sessionId, calls } = await spine()
  const replies = ['[1]', 'null', '"x"', '{"a":'].map((args, index) => ({
    content: null, toolCalls: [{ id: `c${index}`, name: 'replay_test', arguments: args }],
  }))
  const llm: LlmClient = { async chat() { return replies.shift() ?? { content: 'done', toolCalls: [] } } }
  const result = await new AgentLoop(ctx, llm, sessionId, new AbortController().signal, config('lean-replay'))
    .run([{ kind: 'wake', text: 'go' }])
  assert.equal(result.text, 'done')
  assert.equal(calls(), 0)
  const failed = (await ctx.sessions.require(sessionId)).events
    .filter((event) => event.type === 'tool/result' && !event.ok)
  assert.equal(failed.length, 4)
})

test('compaction never sends native blocks, signatures or private references to the summary model', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'request' },
    { role: 'assistant', content: 'public answer', replay, replayRef: 'private-ref' },
  ]
  const compact = buildAutoCompactMessages(messages, 10_000)
  assert.match(JSON.stringify(compact.messages), /public answer/)
  assert.doesNotMatch(JSON.stringify(compact.messages), /private-ref|private-reasoning-fixture|test-route/)
  assert.deepEqual(messages[2]!.replay, replay)
})
