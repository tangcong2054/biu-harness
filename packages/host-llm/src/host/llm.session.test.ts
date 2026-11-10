import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { afterEach, test } from 'vitest'
import {
  AnthropicLlm,
  LlmService,
  OpenAiCompatLlm,
  nativeReplayRouteKey,
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

test('native OpenAI rejects missing capture and every route change before fetching tool continuation', async () => {
  const requests = mockWire()
  const replay: NativeReplay = {
    version: 1, complete: true, routeKey: nativeReplayRouteKey(config), protocol: 'openai-compat',
    reasoningField: 'reasoning_content', reasoningContent: 'private-thinking',
  }
  await assert.rejects(() => new OpenAiCompatLlm(config).chat(toolHistory()), /新建会话或清除上下文/)
  for (const change of [
    { provider: 'deepseek' as const }, { model: 'different-model' },
    { baseUrl: 'https://other.example.test/v1' }, { endpointId: 'different-endpoint' },
  ]) await assert.rejects(() => new OpenAiCompatLlm({ ...config, ...change }).chat(toolHistory(replay)), /入口已改变/)
  assert.equal(requests.length, 0)
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

test('Anthropic refuses missing signatures, wrong routes or changed tool state before fetching', async () => {
  const anthropic: LlmConfig = { ...config, provider: 'anthropic' }
  const requests = mockWire('anthropic')
  await assert.rejects(() => new AnthropicLlm(anthropic).chat(toolHistory()), /缺少完整/)
  const missingSignature = anthropicReplay(anthropic)
  Object.assign(missingSignature.blocks![0]!, { signature: '' })
  await assert.rejects(() => new AnthropicLlm(anthropic).chat(toolHistory(missingSignature)), /签名不完整/)
  await assert.rejects(() => new AnthropicLlm({ ...anthropic, endpointId: 'new-endpoint' }).chat(toolHistory(anthropicReplay(anthropic))), /入口已改变/)
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

  test(`${provider} text-only native route changes cannot silently fall back to lean`, async () => {
    const cfg: LlmConfig = { ...config, provider }
    const requests = mockWire(provider)
    const replay: NativeReplay = provider === 'anthropic' ? {
      version: 1, complete: true, protocol: 'anthropic', routeKey: nativeReplayRouteKey(cfg),
      blocks: [{ type: 'text', text: 'answer' }],
    } : { version: 1, complete: true, protocol: 'openai-compat', routeKey: nativeReplayRouteKey(cfg) }
    const changed = new LlmService(new Context()).forConfig({ ...cfg, model: 'different-model' })
    await assert.rejects(() => changed.chat([{ role: 'assistant', content: 'answer', replay }]), /入口已改变/)
    assert.equal(requests.length, 0)
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
