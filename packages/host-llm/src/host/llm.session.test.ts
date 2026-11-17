import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { afterEach, test } from 'vitest'
import {
  AnthropicLlm,
  LlmService,
  OpenAiCompatLlm,
  ReplayHandoffRequiredError,
  nativeReplayRouteKey,
  restoreReplayMessages,
  type LlmConfig,
  type LlmMessage,
  type NativeReplay,
  hasImageContent,
  DEEPSEEK_VISION_MODEL,
  flattenToolImagesForChatCompletions,
  toAnthropicContent,
} from '@biu/host-llm'

const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

const config: LlmConfig = {
  provider: 'openai', apiKey: 'synthetic-test-key', model: 'test-model',
  endpointId: 'test-endpoint', baseUrl: 'https://llm.example.test/v1', replayMode: 'native-replay',
}

const toolCall = { id: 'call-1', type: 'function', function: { name: 'clock_now', arguments: '{}' } }
const toolSchema = [{ type: 'function', function: { name: 'clock_now', parameters: { type: 'object', properties: {} } } }]

function mockWire(protocol: 'openai' | 'anthropic' = 'openai', firstResponse?: string) {
  const requests: Array<{ messages: Array<Record<string, unknown>>; [key: string]: unknown }> = []
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const response = firstResponse && requests.length === 1 ? firstResponse
      : protocol === 'openai' ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        : [
          { type: 'message_start', message: {} },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(response, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return requests
}

function toolHistory(replay?: NativeReplay): LlmMessage[] {
  return [
    { role: 'user', content: 'time?' },
    { role: 'assistant', content: 'checking', tool_calls: [toolCall], replay, replayRef: 'private-ref' },
    { role: 'tool', tool_call_id: toolCall.id, content: '{"time":1}' },
  ]
}

test('hasImageContent detects image_url block in array content', () => {
  assert.equal(
    hasImageContent([
      { type: 'text' as const, text: 'hi' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,xxx' } },
    ]),
    true,
  )
})

test('hasImageContent returns false for plain string / null / text-only', () => {
  assert.equal(hasImageContent('hello'), false)
  assert.equal(hasImageContent(null), false)
  assert.equal(hasImageContent(undefined), false)
  assert.equal(hasImageContent([{ type: 'text' as const, text: 'only text' }]), false)
})

test('DEEPSEEK_VISION_MODEL constant matches vision-exp model', () => {
  assert.equal(DEEPSEEK_VISION_MODEL, 'deepseek-v4-flash-vision-exp')
})

test('flattenToolImagesForChatCompletions keeps tool text and appends user images', () => {
  const out = flattenToolImagesForChatCompletions([
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    {
      role: 'tool',
      tool_call_id: '1',
      content: [
        { type: 'text', text: '{"ok":true}' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
      ],
    },
  ])
  assert.equal(out[1]?.role, 'tool')
  assert.equal(out[1]?.content, '{"ok":true}')
  assert.equal(out[2]?.role, 'user')
  assert.equal(hasImageContent(out[2]?.content), true)
})

test('flattenToolImagesForChatCompletions does not insert user between sibling tool results', () => {
  const out = flattenToolImagesForChatCompletions([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'db_list', arguments: '{}' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'a',
      content: [
        { type: 'text', text: '{"ok":true}' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: '{"kind":"root"}' },
    { role: 'user', content: '????' },
  ])
  assert.equal(out[1]?.role, 'tool')
  assert.equal(out[1]?.tool_call_id, 'a')
  assert.equal(out[2]?.role, 'tool')
  assert.equal(out[2]?.tool_call_id, 'b')
  assert.equal(out[3]?.role, 'user')
  assert.equal(hasImageContent(out[3]?.content), true)
  assert.equal(out[4]?.content, '????')
})

test('toAnthropicContent wraps tool images as tool_result image source', () => {
  const content = toAnthropicContent(
    [
      { type: 'text', text: 'shot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ],
    'call-1',
  )
  assert.deepEqual(content, [
    {
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
    },
  ])
})

test('native replay route keys bind actual provider, model, URL and endpoint id but not API secrets', () => {
  const route = nativeReplayRouteKey(config)
  assert.equal(route, nativeReplayRouteKey({ ...config, apiKey: 'different-test-key' }))
  assert.equal(route, nativeReplayRouteKey({ ...config, baseUrl: `${config.baseUrl}/chat/completions` }))
  assert.equal(route.includes(config.apiKey), false)
  for (const change of [
    { provider: 'deepseek' as const }, { model: 'different-model' },
    { baseUrl: 'https://other.example.test/v1' }, { endpointId: 'different-endpoint' },
  ]) assert.notEqual(route, nativeReplayRouteKey({ ...config, ...change }))
})

for (const field of ['reasoning_content', 'reasoning'] as const) {
  test(`lean capture can resume native with original ${field} after private state restoration`, async () => {
    const stream = [
      { choices: [{ delta: { [field]: 'private-thinking' } }] },
      { choices: [{ delta: { content: 'checking', tool_calls: [{ index: 0, ...toolCall }] } }] },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    const requests = mockWire('openai', stream)
    const reply = await new OpenAiCompatLlm({ ...config, replayMode: 'lean-replay' }).chat([{ role: 'user', content: 'time?' }])
    assert.equal(reply.replay?.reasoningContent, 'private-thinking')
    const restored = JSON.parse(JSON.stringify(reply.replay)) as NativeReplay
    const history = toolHistory(restored)
    Object.assign(history[1]!, { reasoning_content: 'untrusted-old-value', reasoning: 'untrusted-old-value' })
    await new OpenAiCompatLlm(config).chat(history)
    assert.equal(requests[1]?.messages[1]?.[field], 'private-thinking')
    const other = field === 'reasoning' ? 'reasoning_content' : 'reasoning'
    assert.equal(other in requests[1]!.messages[1]!, false)
    assert.equal(JSON.stringify(requests).includes('private-ref'), false)
    assert.equal(JSON.stringify(requests).includes('routeKey'), false)
    assert.equal(JSON.stringify(requests).includes('replay'), false)
    assert.deepEqual(requests[1]?.messages[1]?.tool_calls, [toolCall])
  })
}

test('lean/default OpenAI request strips every private field and both reasoning aliases', async () => {
  const replay: NativeReplay = {
    version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(config),
    reasoningContent: 'private-thinking', reasoningField: 'reasoning_content',
  }
  const requests = mockWire()
  const history = toolHistory(replay)
  Object.assign(history[1]!, { reasoning_content: 'private-direct-thinking', reasoning: 'private-direct-thinking', blocks: ['private-block'] })
  await new OpenAiCompatLlm({ ...config, replayMode: undefined }).chat(history)
  assert.deepEqual(requests[0]?.messages[1], { role: 'assistant', content: 'checking', tool_calls: [toolCall] })
  assert.equal(JSON.stringify(requests).includes('private'), false)
})

test('ordinary native OpenAI tools do not require or invent empty reasoning_content', async () => {
  const requests = mockWire()
  await new OpenAiCompatLlm(config).chat(toolHistory({
    version: 1, complete: true, routeKey: nativeReplayRouteKey(config), protocol: 'openai-compat',
  }))
  assert.equal('reasoning_content' in requests[0]!.messages[1]!, false)
  assert.equal('reasoning' in requests[0]!.messages[1]!, false)
})

test('native OpenAI rejects missing private references but sends complete foreign tools as public history', async () => {
  const requests = mockWire()
  const replay: NativeReplay = {
    version: 1, complete: true, routeKey: nativeReplayRouteKey(config), protocol: 'openai-compat',
    reasoningField: 'reasoning_content', reasoningContent: 'private-thinking',
  }
  await assert.rejects(() => new OpenAiCompatLlm(config).chat(toolHistory()), /新建会话或清除上下文/)
  for (const change of [
    { provider: 'deepseek' as const }, { model: 'different-model' },
    { baseUrl: 'https://other.example.test/v1' }, { endpointId: 'different-endpoint' },
  ]) await new OpenAiCompatLlm({ ...config, ...change }).chat(toolHistory(replay))
  assert.equal(requests.length, 4)
  for (const request of requests) {
    assert.deepEqual(request.messages[1], { role: 'assistant', content: 'checking', tool_calls: [toolCall] })
    assert.deepEqual(request.messages[2], { role: 'tool', tool_call_id: toolCall.id, content: '{"time":1}' })
  }
  assert.doesNotMatch(JSON.stringify(requests), /private|replay|reasoning/)
})

for (const provider of ['openai', 'deepseek'] as const) {
  test(`${provider} DeepSeek-named native tools accept complete responses without inventing reasoning`, async () => {
    const cfg: LlmConfig = { ...config, provider, model: 'deepseek-v4-flash', thinking: 'enabled' }
    const requests = mockWire()
    await new OpenAiCompatLlm(cfg).chat(toolHistory({
      version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(cfg),
    }), toolSchema)
    assert.equal(requests.length, 1)
    assert.equal('reasoning_content' in requests[0]!.messages[1]!, false)
    assert.equal('reasoning' in requests[0]!.messages[1]!, false)
    assert.deepEqual(requests[0]?.messages[1]?.tool_calls, [toolCall])
  })

  test(`${provider} DeepSeek-named lean mode keeps thinking and tools enabled without local policy rejection`, async () => {
    const cfg: LlmConfig = { ...config, provider, model: 'deepseek-v4-flash', thinking: 'enabled', replayMode: 'lean-replay' }
    const requests = mockWire()
    await new OpenAiCompatLlm(cfg).chat([{ role: 'user', content: 'hi' }], toolSchema)
    await new OpenAiCompatLlm(cfg).chat(toolHistory(), toolSchema)
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1]?.tools, toolSchema)
    assert.deepEqual(requests[1]?.thinking, { type: 'enabled' })
    assert.equal(requests[1]?.tool_choice, 'auto')
    assert.equal('reasoning_content' in requests[1]!.messages[1]!, false)
  })
}

test('Anthropic lean mode leaves protocol acceptance to the endpoint without changing thinking or tools', async () => {
  const cfg: LlmConfig = { ...config, provider: 'anthropic', thinking: 'enabled', replayMode: 'lean-replay' }
  const requests = mockWire('anthropic')
  await new AnthropicLlm(cfg).chat(toolHistory(anthropicReplay(cfg)), toolSchema)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.thinking, { type: 'enabled', budget_tokens: 10_000 })
  assert.deepEqual(requests[0]?.messages[1], { role: 'assistant', content: [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} },
  ] })
  assert.doesNotMatch(JSON.stringify(requests), /private-thinking|private-signature|private-redaction/)
})

function anthropicReplay(anthropic: LlmConfig): NativeReplay {
  return {
    version: 1, complete: true, protocol: 'anthropic', routeKey: nativeReplayRouteKey(anthropic),
    blocks: [
      { type: 'thinking', thinking: 'private-thinking', signature: 'private-signature' },
      { type: 'redacted_thinking', data: 'private-redaction' },
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} },
    ],
  }
}

test('Anthropic native request restores ordered signed blocks without private reference fields', async () => {
  const anthropic: LlmConfig = { ...config, provider: 'anthropic' }
  const replay = anthropicReplay(anthropic)
  const requests = mockWire('anthropic')
  const reply = await new AnthropicLlm(anthropic).chat(toolHistory(JSON.parse(JSON.stringify(replay))))
  assert.deepEqual(requests[0]?.messages[1], { role: 'assistant', content: replay.blocks })
  assert.equal(JSON.stringify(requests).includes('private-ref'), false)
  assert.equal(JSON.stringify(requests).includes('routeKey'), false)
  assert.equal(reply.replay?.complete, true)
})

test('Anthropic lean fallback preserves assistant prose and tools, not thinking or signatures', async () => {
  const anthropic: LlmConfig = { ...config, provider: 'anthropic', replayMode: 'lean-replay' }
  const requests = mockWire('anthropic')
  await new AnthropicLlm(anthropic).chat(toolHistory(anthropicReplay(anthropic)))
  assert.deepEqual(requests[0]?.messages[1]?.content, [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} },
  ])
  assert.equal(JSON.stringify(requests).includes('private'), false)
})

test('Anthropic native without captured tools still preserves ordinary assistant text', async () => {
  const requests = mockWire('anthropic')
  await new AnthropicLlm({ ...config, provider: 'anthropic' }).chat([
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ordinary previous answer' },
    { role: 'user', content: 'continue' },
  ])
  assert.equal(requests[0]?.messages[1]?.content, 'ordinary previous answer')
})

test('Anthropic refuses missing signatures or changed tool state before fetching', async () => {
  const anthropic: LlmConfig = { ...config, provider: 'anthropic' }
  const requests = mockWire('anthropic')
  await assert.rejects(() => new AnthropicLlm(anthropic).chat(toolHistory()), /缺少完整/)
  const missingSignature = anthropicReplay(anthropic)
  Object.assign(missingSignature.blocks![0]!, { signature: '' })
  await assert.rejects(() => new AnthropicLlm(anthropic).chat(toolHistory(missingSignature)), /签名不完整/)
  const changedTools = anthropicReplay(anthropic)
  Object.assign(changedTools.blocks![3]!, { input: { changed: true } })
  await assert.rejects(() => new AnthropicLlm(anthropic).chat(toolHistory(changedTools)), /工具调用.*不一致/)
  assert.equal(requests.length, 0)
})

for (const provider of ['openai', 'anthropic'] as const) {
  test(`${provider} service forwards a lean compact override and still captures successful replies`, async () => {
    const requests = mockWire(provider)
    const cfg: LlmConfig = { ...config, provider, thinking: 'enabled' }
    const client = new LlmService(new Context()).forConfig(cfg)
    const history = toolHistory(provider === 'anthropic' ? anthropicReplay(cfg) : {
      version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(cfg),
      reasoningContent: 'private-thinking', reasoningField: 'reasoning_content',
    })
    history[1]!.replayMissing = true
    await assert.rejects(() => client.chat(history), /原始响应状态不可用/)
    const reply = await client.chat(history, [], undefined, { replayMode: 'lean-replay', thinking: 'disabled' })
    assert.equal(reply.replay?.complete, true)
    assert.equal(JSON.stringify(requests).includes('private'), false)
    assert.equal(JSON.stringify(requests).includes('replay'), false)
    assert.deepEqual(requests[0]?.thinking, { type: 'disabled' })
    assert.equal(requests[0]?.tools, undefined)
    assert.equal(requests.length, 1)
  })

  test(`${provider} accepts native per-call override above configured lean mode`, async () => {
    const cfg: LlmConfig = { ...config, provider, replayMode: 'lean-replay' }
    const requests = mockWire(provider)
    const replay: NativeReplay = provider === 'anthropic' ? anthropicReplay(cfg) : {
      version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(cfg),
      reasoningContent: 'private-thinking', reasoningField: 'reasoning',
    }
    await new LlmService(new Context()).forConfig(cfg).chat(toolHistory(replay), [], undefined, { replayMode: 'native-replay' })
    if (provider === 'anthropic') assert.deepEqual(requests[0]?.messages[1]?.content, replay.blocks)
    else assert.equal(requests[0]?.messages[1]?.reasoning, 'private-thinking')
    assert.equal(JSON.stringify(requests).includes('private-ref'), false)
    assert.equal(JSON.stringify(requests).includes('replay'), false)
  })

  test(`${provider} complete foreign text remains public prose with an internal route marker`, async () => {
    const cfg: LlmConfig = { ...config, provider }
    const requests = mockWire(provider)
    const replay: NativeReplay = provider === 'anthropic' ? {
      version: 1, complete: true, protocol: 'anthropic', routeKey: nativeReplayRouteKey(cfg),
      blocks: [{ type: 'text', text: 'answer' }],
    } : { version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(cfg) }
    const target = { ...cfg, model: 'different-model' }
    const changed = new LlmService(new Context()).forConfig(target)
    const prepared = changed.prepareMessages!([{ role: 'assistant', content: 'answer', replay }])
    assert.deepEqual(prepared[0]?.replayHistory, { kind: 'foreign', targetRouteKey: nativeReplayRouteKey(target) })
    assert.equal(prepared[0]?.replay, undefined)
    await changed.chat(prepared)
    assert.deepEqual(requests[0]?.messages[0], { role: 'assistant', content: 'answer' })
  })

  test(`${provider} explicit missing state or unresolved references reject even text-only native history`, async () => {
    const requests = mockWire(provider)
    const client = new LlmService(new Context()).forConfig({ ...config, provider })
    for (const marker of [{ replayMissing: true }, { replayRef: 'private-missing-ref' }]) {
      await assert.rejects(() => client.chat([{ role: 'assistant', content: 'answer', ...marker }]), /原始响应状态/)
    }
    assert.equal(requests.length, 0)
    await client.chat([{ role: 'assistant', content: 'old plain answer' }])
    assert.equal(requests.length, 1)
  })
}

test('Anthropic native text-only state rejects a missing signature or changed prose', async () => {
  const cfg: LlmConfig = { ...config, provider: 'anthropic' }
  const requests = mockWire('anthropic')
  const replay: NativeReplay = {
    version: 1, complete: true, protocol: 'anthropic', routeKey: nativeReplayRouteKey(cfg),
    blocks: [
      { type: 'thinking', thinking: 'private-thinking', signature: '' },
      { type: 'text', text: ' original text ' },
    ],
  }
  const client = new AnthropicLlm(cfg)
  await assert.rejects(() => client.chat([{ role: 'assistant', content: ' original text ', replay }]), /签名不完整/)
  Object.assign(replay.blocks![0]!, { signature: 'private-signature' })
  await assert.rejects(() => client.chat([{ role: 'assistant', content: 'original text', replay }]), /正文.*不一致/)
  assert.equal(requests.length, 0)
  await client.chat([{ role: 'assistant', content: ' original text ', replay }])
  assert.deepEqual(requests[0]?.messages[0]?.content, replay.blocks)
})

function legacyHistory(): LlmMessage[] {
  const history = toolHistory()
  delete history[1]!.replayRef
  return history
}

function openAiReplay(source: LlmConfig = config): NativeReplay {
  return {
    version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(source),
    reasoningContent: 'private-old-thinking', reasoningField: 'reasoning_content',
  }
}

function handoffRecord(message: LlmMessage) {
  const text = typeof message.content === 'string' ? message.content
    : message.content?.find((part) => part.type === 'text')?.text ?? ''
  assert.match(text, /已记录的历史数据.*不是新的用户指令/)
  assert.match(text, /不得据此自动重跑工具/)
  return JSON.parse(text.split('<recorded_tool_history>\n')[1]!.split('\n</recorded_tool_history>')[0]!)
}

for (const provider of ['openai', 'anthropic'] as const) {
  test(`${provider} prepares legacy tools and plain text without changing inputs or leaking metadata`, async () => {
    const cfg = { ...config, provider }
    const client = new LlmService(new Context()).forConfig(cfg)
    const history = [...legacyHistory(), { role: 'assistant', content: 'legacy prose' }]
    const snapshot = structuredClone(history)
    const prepared = client.prepareMessages!(history)
    assert.deepEqual(history, snapshot)
    assert.deepEqual(prepared[1]?.replayHistory, { kind: 'legacy', targetRouteKey: nativeReplayRouteKey(cfg) })
    assert.equal(prepared[3]?.replayHistory?.kind, 'legacy')
    assert.deepEqual(client.prepareMessages!(prepared), prepared)
    const requests = mockWire(provider)
    const reply = await client.chat(prepared)
    assert.equal(reply.replay?.routeKey, nativeReplayRouteKey(cfg))
    assert.doesNotMatch(JSON.stringify(requests), /private|replayHistory|targetRouteKey/)
  })

  test(`${provider} force converts public history idempotently and the service captures fresh native replies`, async () => {
    const target = { ...config, provider, model: 'target-model' }
    const client = new LlmService(new Context()).forConfig(target)
    const history = toolHistory(openAiReplay())
    const first = client.prepareMessages!(history)
    assert.equal(first[1]?.replayHistory?.kind, 'foreign')
    const prepared = client.prepareMessages!(first, [], { replayHandoff: true })
    assert.equal(prepared.length, 2)
    assert.equal(prepared[1]?.replayHistory?.kind, 'handoff')
    assert.deepEqual(client.prepareMessages!(prepared, [], { replayHandoff: true }), prepared)
    assert.deepEqual(client.prepareMessages!(prepared), prepared)
    const recorded = handoffRecord(prepared[1]!)
    assert.deepEqual(recorded.assistant.tool_calls, [toolCall])
    assert.equal(recorded.tool_results[0].content, '{"time":1}')
    const requests = mockWire(provider)
    const reply = await client.chat(first, [], undefined, { replayHandoff: true })
    assert.equal(reply.replay?.complete, true)
    assert.equal(reply.replay?.routeKey, nativeReplayRouteKey(target))
    assert.equal(requests[0]?.messages[1]?.role, 'user')
    assert.doesNotMatch(JSON.stringify(requests), /private|signature|reasoning_content|replayHistory|targetRouteKey/)
  })

  test(`${provider} corrupted replay cannot be relabelled as foreign or forced into a handoff`, async () => {
    const requests = mockWire(provider)
    const target = { ...config, provider, model: 'target-model' }
    const client = new LlmService(new Context()).forConfig(target)
    const damages = [
      { version: 2 }, { complete: false }, { routeKey: '' }, { routeKey: undefined },
      { protocol: 'unknown' }, { reasoningContent: 1 }, { reasoningField: 'signature' },
    ]
    for (const damage of damages) {
      const replay = Object.assign(openAiReplay(), damage) as NativeReplay
      for (const replayHandoff of [false, true]) {
        await assert.rejects(() => client.chat(toolHistory(replay), [], undefined, { replayHandoff }), /原始/)
      }
    }
    for (const marker of [{ replayMissing: true }, { replayRef: 'lost' }]) {
      const history = legacyHistory()
      Object.assign(history[1]!, marker, { replayHistory: { kind: 'foreign', targetRouteKey: nativeReplayRouteKey(target) } })
      await assert.rejects(() => client.chat(history, [], undefined, { replayHandoff: true }), /原始响应状态/)
    }
    assert.equal(requests.length, 0)
  })

  test(`${provider} never invents absent, duplicate or mismatched historical tool results`, async () => {
    const client = new LlmService(new Context()).forConfig({ ...config, provider })
    const requests = mockWire(provider)
    for (const history of [
      legacyHistory().slice(0, 2),
      [...legacyHistory().slice(0, 2), { role: 'tool', tool_call_id: 'unmatched', content: 'failure' }],
      [...legacyHistory(), legacyHistory()[2]!],
      [...legacyHistory().slice(0, 2), { role: 'user', content: 'interrupted' }, legacyHistory()[2]!],
    ]) {
      await assert.rejects(() => client.chat(history, [], undefined, { replayHandoff: true }), /结果/)
    }
    assert.equal(requests.length, 0)
  })
}

test('foreign Anthropic signed content becomes only public OpenAI prose and tools', async () => {
  const source = { ...config, provider: 'anthropic' as const }
  const history = toolHistory(anthropicReplay(source))
  Object.assign(history[1]!, { signature: 'private-direct-signature', reasoning_content: 'private-direct-reasoning' })
  const before = structuredClone(history)
  const client = new OpenAiCompatLlm(config)
  const prepared = client.prepareMessages(history)
  assert.deepEqual(history, before)
  assert.equal(prepared[1]?.replayRef, undefined)
  assert.equal(prepared[1]?.replay, undefined)
  const requests = mockWire()
  await client.chat(prepared)
  assert.deepEqual(requests[0]?.messages[1], { role: 'assistant', content: 'checking', tool_calls: [toolCall] })
  assert.doesNotMatch(JSON.stringify(requests), /private|thinking|signature|redact|replay/)
})

for (const legacy of [false, true]) {
  test(`Anthropic enabled thinking pre-handoffs ${legacy ? 'legacy' : 'foreign'} parallel tools, failures and images`, async () => {
    const cfg: LlmConfig = { ...config, provider: 'anthropic', thinking: 'enabled' }
    const client = new AnthropicLlm(cfg)
    const history = legacy ? legacyHistory() : toolHistory(openAiReplay())
    const raw = '{ "path": "a\\\\b", "token": 1 }'
    history[1]!.tool_calls = [toolCall, { id: 'call-2', type: 'function', function: { name: 'read_image', arguments: raw } }]
    history[2]!.content = 'FAILED: permission denied\n  original spacing  '
    const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,YWJj' } }
    history.push({ role: 'tool', tool_call_id: 'call-2', content: [{ type: 'text', text: 'image result' }, image] })
    history.push({ role: 'user', content: 'continue without retrying failed commands' })
    const snapshot = structuredClone(history)
    const prepared = client.prepareMessages(history, toolSchema)
    assert.deepEqual(history, snapshot)
    assert.equal(prepared.length, 3)
    assert.deepEqual(prepared[2], history[4])
    assert.deepEqual(client.prepareMessages(prepared, toolSchema), prepared)
    const record = handoffRecord(prepared[1]!)
    assert.equal(record.assistant.tool_calls[1].function.arguments, raw)
    assert.equal(record.tool_results[0].content, history[2]!.content)
    assert.deepEqual(record.tool_results[1].content[1], { type: 'image_reference', imageIndex: 0 })
    assert.ok(Array.isArray(prepared[1]!.content))
    assert.deepEqual(prepared[1]!.content.at(-1), image)
    const requests = mockWire('anthropic')
    const reply = await client.chat(prepared, toolSchema)
    assert.equal(reply.replay?.complete, true)
    const wireContent = requests[0]?.messages[1]?.content as Array<Record<string, unknown>>
    assert.deepEqual(wireContent.at(-1), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } })
    assert.doesNotMatch(JSON.stringify(requests), /private|signature|replayHistory|targetRouteKey/)
  })
}

test('Anthropic hands off malformed foreign arguments verbatim instead of inventing _raw tool input', async () => {
  const history = toolHistory(openAiReplay())
  const raw = '{"id": 31830dc7}'
  history[1]!.tool_calls = [{ ...toolCall, function: { name: 'lookup', arguments: raw } }]
  history[2]!.content = 'invalid JSON; tool was not executed'
  const client = new AnthropicLlm({ ...config, provider: 'anthropic', thinking: 'disabled' })
  const prepared = client.prepareMessages(history)
  assert.equal(handoffRecord(prepared[1]!).assistant.tool_calls[0].function.arguments, raw)
  const requests = mockWire('anthropic')
  await client.chat(prepared)
  assert.equal(requests[0]?.messages[1]?.role, 'user')
  assert.doesNotMatch(JSON.stringify(requests), /_raw|tool_use|private/)
})

test('mixed native Anthropic history retains exact signed blocks and current user input during foreign handoff', async () => {
  const cfg: LlmConfig = { ...config, provider: 'anthropic', thinking: 'enabled' }
  const native = anthropicReplay(cfg)
  const current: LlmMessage = { role: 'user', content: 'latest request' }
  const history = [...toolHistory(openAiReplay()), ...toolHistory(native), current]
  const client = new AnthropicLlm(cfg)
  const prepared = client.prepareMessages(history, [], { replayHandoff: true })
  assert.equal(prepared[1]?.replayHistory?.kind, 'handoff')
  assert.deepEqual(prepared[3], history[4])
  assert.deepEqual(prepared.at(-1), current)
  const requests = mockWire('anthropic')
  await client.chat(prepared, [], undefined, { replayHandoff: true })
  assert.deepEqual(requests[0]?.messages[3]?.content, native.blocks)
  const broken = structuredClone(history)
  Object.assign(broken[4]!.replay!.blocks![0]!, { signature: '' })
  broken[4]!.replayHistory = { kind: 'foreign', targetRouteKey: nativeReplayRouteKey(cfg) }
  assert.throws(() => client.prepareMessages(broken, [], { replayHandoff: true }), /签名不完整/)
  assert.equal(requests.length, 1)
})

test('foreign broken Anthropic signatures and public/native tool mismatches remain fail closed', () => {
  const source: LlmConfig = { ...config, provider: 'anthropic' }
  const client = new OpenAiCompatLlm(config)
  for (const change of [{ signature: '' }, { signature: undefined }]) {
    const replay = anthropicReplay(source)
    Object.assign(replay.blocks![0]!, change)
    assert.throws(() => client.prepareMessages(toolHistory(replay), [], { replayHandoff: true }), /签名不完整/)
  }
  const replay = anthropicReplay(source)
  Object.assign(replay.blocks![3]!, { input: { changed: true } })
  assert.throws(() => client.prepareMessages(toolHistory(replay)), /工具调用.*不一致/)
})

for (const replayHandoff of [false, true]) {
  test(`DeepSeek restores text-native history after an old image group is trimmed (force=${replayHandoff})`, async () => {
    const cfg: LlmConfig = { ...config, provider: 'deepseek' }
    const client = new OpenAiCompatLlm(cfg)
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] },
      ...toolHistory(openAiReplay(cfg)),
      { role: 'user', content: 'latest request without images' },
    ]
    const original = structuredClone(history)
    const prepared = client.prepareMessages(history, [], { replayHandoff })
    assert.equal(prepared[2]?.replayHistory?.kind, replayHandoff ? 'handoff' : 'foreign')
    assert.doesNotMatch(JSON.stringify(prepared), /private-old-thinking|private-ref/)
    assert.deepEqual(restoreReplayMessages(prepared), history)
    const trimmed = prepared.slice(1)
    assert.deepEqual(restoreReplayMessages(trimmed), history.slice(1))
    const rerouted = client.prepareMessages(trimmed, [], { replayHandoff })
    assert.deepEqual(rerouted[1], history[2])
    assert.equal(rerouted[1]?.replay?.routeKey, nativeReplayRouteKey(cfg))
    assert.deepEqual(client.prepareMessages(rerouted, [], { replayHandoff }), rerouted)
    assert.deepEqual(history, original)
    const requests = mockWire()
    const reply = await client.chat(trimmed, [], undefined, { replayHandoff })
    assert.equal(requests[0]?.model, cfg.model)
    assert.equal(requests[0]?.messages[1]?.reasoning_content, 'private-old-thinking')
    assert.equal(reply.replay?.routeKey, nativeReplayRouteKey(cfg))
    assert.equal(requests[0]?.messages[3]?.content, 'latest request without images')
  })
}

test('handoff origins remain memory-only and flatten through repeated preparation without self cycles', () => {
  const source: LlmConfig = { ...config, provider: 'anthropic' }
  const history = toolHistory(anthropicReplay(source))
  const target = new OpenAiCompatLlm(config)
  let prepared = target.prepareMessages(history, [], { replayHandoff: true })
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const next = target.prepareMessages(prepared, [], { replayHandoff: true })
    assert.deepEqual(next, prepared)
    assert.deepEqual(restoreReplayMessages(next), history)
    assert.notEqual(next[1], history[1])
    prepared = next
  }
  const serialized = JSON.stringify(prepared)
  assert.doesNotMatch(serialized, /private|signature|reasoning|sources|origins/)
  const detached = JSON.parse(serialized) as LlmMessage[]
  assert.deepEqual(restoreReplayMessages(detached), detached)
  const restoredNative = new AnthropicLlm(source).prepareMessages(prepared, [], { replayHandoff: true })
  assert.deepEqual(restoredNative, history)
  assert.deepEqual(restoredNative[1]?.replay?.blocks, history[1]?.replay?.blocks)
})

test('DeepSeek preparation uses the actual vision route and preserves images across forced idempotent handoffs', async () => {
  const cfg: LlmConfig = { ...config, provider: 'deepseek' }
  const vision = { ...cfg, model: DEEPSEEK_VISION_MODEL }
  const client = new OpenAiCompatLlm(cfg)
  const native = toolHistory(openAiReplay(vision))
  const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,YWJj' } }
  native[2]!.content = [{ type: 'text', text: 'screenshot' }, image]
  const preparedNative = client.prepareMessages(native)
  assert.deepEqual(preparedNative[1], native[1])
  const foreign = toolHistory(openAiReplay())
  foreign[2]!.content = native[2]!.content
  const prepared = client.prepareMessages(foreign, [], { replayHandoff: true })
  assert.equal(prepared[1]?.replayHistory?.targetRouteKey, nativeReplayRouteKey(vision))
  assert.deepEqual(client.prepareMessages(prepared, [], { replayHandoff: true }), prepared)
  const requests = mockWire()
  const reply = await client.chat(prepared, [], undefined, { replayHandoff: true })
  assert.equal(requests[0]?.model, DEEPSEEK_VISION_MODEL)
  assert.equal(reply.replay?.routeKey, nativeReplayRouteKey(vision))
  assert.ok(hasImageContent(requests[0]?.messages[1]?.content as LlmMessage['content']))
  await client.chat(preparedNative)
  assert.equal(requests[1]?.messages[1]?.reasoning_content, 'private-old-thinking')
})

for (const provider of ['openai', 'anthropic'] as const) {
  for (const status of [400, 422]) {
    test(`${provider} HTTP ${status} historical reasoning rejection emits only the safe typed error without retrying`, async () => {
      const client = new LlmService(new Context()).forConfig({ ...config, provider, model: 'target' })
      let requests = 0
      globalThis.fetch = (async () => {
        requests += 1
        return new Response(JSON.stringify({ error: {
          message: 'Missing reasoning_content in assistant message at index 1. private-upstream-echo',
          code: 'private-code', request_id: 'private-request',
        } }), { status })
      }) as typeof fetch
      await assert.rejects(() => client.chat(toolHistory(openAiReplay())), (error: unknown) => {
        assert.ok(error instanceof ReplayHandoffRequiredError)
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private|reasoning_content/)
        return true
      })
      assert.equal(requests, 1)
    })
  }

  test(`${provider} auth, capacity, server and unrelated errors never signal replay retry`, async () => {
    const client = new LlmService(new Context()).forConfig({ ...config, provider, model: 'target' })
    let requests = 0
    for (const [status, message] of [
      [401, 'Missing reasoning_content in assistant message'],
      [429, 'Missing reasoning_content in assistant message'],
      [500, 'Missing reasoning_content in assistant message'],
      [503, 'Invalid signature in thinking block'],
      [400, 'Invalid API signature for authentication'],
      [422, 'max_tokens is too large'],
    ] as const) {
      globalThis.fetch = (async () => {
        requests += 1
        return new Response(JSON.stringify({ error: { message } }), { status })
      }) as typeof fetch
      await assert.rejects(() => client.chat(legacyHistory()), (error: unknown) => !(error instanceof ReplayHandoffRequiredError))
    }
    assert.equal(requests, 6)
  })

  test(`${provider} forced handoff rejection and streaming failures never request another handoff`, async () => {
    const client = new LlmService(new Context()).forConfig({ ...config, provider, model: 'target' })
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response(JSON.stringify({ error: { message: 'Missing reasoning_content in assistant message' } }), { status: 400 })
    }) as typeof fetch
    await assert.rejects(() => client.chat(legacyHistory(), [], undefined, { replayHandoff: true }),
      (error: unknown) => !(error instanceof ReplayHandoffRequiredError))
    assert.equal(requests, 1)
    const events = provider === 'openai' ? [
      { choices: [{ delta: { content: 'started' } }] },
      { error: { message: 'Missing reasoning_content in assistant history', status: 400 } },
    ] : [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'started' } },
      { type: 'error', error: { message: 'Invalid signature in thinking block', status: 400 } },
    ]
    const seen: string[] = []
    globalThis.fetch = (async () => {
      requests += 1
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    }) as typeof fetch
    await assert.rejects(() => client.chat(legacyHistory(), [], undefined, { onDelta: (text) => { seen.push(text) } }),
      (error: unknown) => !(error instanceof ReplayHandoffRequiredError))
    assert.deepEqual(seen, ['started'])
    assert.equal(requests, 2)
  })
}

test('a stale public marker never converts complete same-route native history into handoff data', () => {
  const cfg: LlmConfig = { ...config, provider: 'anthropic', thinking: 'enabled' }
  const history = toolHistory(anthropicReplay(cfg))
  history[1]!.replayHistory = { kind: 'foreign', targetRouteKey: nativeReplayRouteKey(cfg) }
  const client = new AnthropicLlm(cfg)
  assert.deepEqual(client.prepareMessages(history, [], { replayHandoff: true }), history)
})

for (const message of [
  'Expected thinking block but found tool_use in assistant history',
  'Invalid signature in historical assistant thinking block',
  'Missing reasoning_content in assistant message at index 1',
]) {
  test(`plain HTTP history rejection stays safe: ${message}`, async () => {
    globalThis.fetch = (async () => new Response(`${message}; private-echo`, { status: 400 })) as typeof fetch
    await assert.rejects(() => new OpenAiCompatLlm(config).chat(legacyHistory()), (error: unknown) => {
      assert.ok(error instanceof ReplayHandoffRequiredError)
      assert.doesNotMatch(error.message, /private-echo/)
      return true
    })
  })
}

test('an indexed same-route rejection is not retried even with other foreign tool history', async () => {
  const history = [...toolHistory(anthropicReplay({ ...config, provider: 'anthropic' })), ...toolHistory(openAiReplay())]
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: {
    message: 'Missing reasoning_content in assistant message at index 4',
  } }), { status: 400 })) as typeof fetch
  await assert.rejects(() => new OpenAiCompatLlm(config).chat(history), (error: unknown) => !(error instanceof ReplayHandoffRequiredError))
})

test('native signature rejection in mixed Anthropic history cannot masquerade as a foreign compatibility error', async () => {
  const cfg: LlmConfig = { ...config, provider: 'anthropic' }
  const history = [...toolHistory(openAiReplay()), ...toolHistory(anthropicReplay(cfg))]
  let requests = 0
  globalThis.fetch = (async () => {
    requests += 1
    return new Response(JSON.stringify({ error: { message: 'Invalid signature in thinking block' } }), { status: 400 })
  }) as typeof fetch
  await assert.rejects(() => new AnthropicLlm(cfg).chat(history), (error: unknown) => !(error instanceof ReplayHandoffRequiredError))
  assert.equal(requests, 1)
})
