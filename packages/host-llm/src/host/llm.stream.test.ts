import assert from 'node:assert/strict'
import { test } from 'vitest'
import { consumeChatCompletionSse, consumeMessagesSse, attachProviderOptions } from '@biu/host-llm'

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('consumeChatCompletionSse yields text deltas and usage', async () => {
  const deltas: string[] = []
  const reply = await consumeChatCompletionSse(
    sseBody([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]),
    { onDelta: (text) => { deltas.push(text) } },
  )
  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(reply.content, '你好')
  assert.deepEqual(reply.toolCalls, [])
  assert.deepEqual(reply.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
})

test('consumeChatCompletionSse streams DeepSeek reasoning_content separately from the answer', async () => {
  const reasoning: string[] = []
  const deltas: string[] = []
  const reply = await consumeChatCompletionSse(
    sseBody([
      'data: {"choices":[{"delta":{"reasoning_content":"先"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"短"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    {
      onDelta: (text) => { deltas.push(text) },
      onReasoningDelta: (text) => { reasoning.push(text) },
    },
  )
  assert.deepEqual(reasoning, ['先', '想'])
  assert.deepEqual(deltas, ['短'])
  assert.equal(reply.content, '短')
})

test('consumeChatCompletionSse streams tool_calls before the stream ends', async () => {
  const tools: Array<{ id: string; name: string; arguments: string }> = []
  const reply = await consumeChatCompletionSse(
    sseBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"clock_now","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    { onToolDelta: (call) => { tools.push({ ...call }) } },
  )
  assert.equal(reply.toolCalls[0]?.name, 'clock_now')
  assert.ok(tools.length >= 2)
  assert.equal(tools[0]?.name, 'clock_now')
  assert.equal(tools.at(-1)?.arguments, '{}')
})

test('consumeChatCompletionSse aborts with signal', async () => {
  const abort = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
      abort.abort()
    },
  })
  await assert.rejects(() => consumeChatCompletionSse(stream, { signal: abort.signal }), /cancelled/)
})

test('attachProviderOptions disables DeepSeek thinking', () => {
  const body: Record<string, unknown> = {}
  attachProviderOptions(body, {
    provider: 'deepseek',
    apiKey: 'k',
    model: 'deepseek-v4-flash',
    thinking: 'disabled',
  }, 'openai-compat')
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.reasoning_effort, undefined)
})

test('attachProviderOptions sends enabled thinking plus Max effort', () => {
  const body: Record<string, unknown> = {}
  attachProviderOptions(body, {
    provider: 'deepseek',
    apiKey: 'k',
    model: 'deepseek-v4-flash',
    thinking: 'enabled',
    reasoningEffort: 'max',
  }, 'openai-compat')
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'max')
})

function eventsBody(events: unknown[]): ReadableStream<Uint8Array> {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
  return sseBody([data.slice(0, 17), data.slice(17, 101), data.slice(101)])
}

for (const field of ['reasoning_content', 'reasoning'] as const) {
  test(`OpenAI captures complete ${field} without changing display callbacks`, async () => {
    const reasoning: string[] = []
    const reply = await consumeChatCompletionSse(sseBody([
      `data: ${JSON.stringify({ choices: [{ delta: { [field]: '想' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { [field]: '好了', content: '答' } }] })}\n\n`,
      'data: [DONE]',
    ]), { routeKey: 'route-test', onReasoningDelta: (text) => { reasoning.push(text) } })
    assert.equal(reply.content, '答')
    assert.deepEqual(reasoning, ['想', '好了'])
    assert.deepEqual(reply.replay, {
      version: 1, complete: true, routeKey: 'route-test', protocol: 'openai-compat',
      reasoningField: field, reasoningContent: '想好了',
    })
  })
}

test('OpenAI captures ordinary replies without inventing an empty reasoning field', async () => {
  const reply = await consumeChatCompletionSse(sseBody([
    'data: {"choices":[{"delta":{"content":"plain"}}]}\n\n', 'data: [DONE]\n\n',
  ]), { routeKey: 'route-test' })
  assert.equal(reply.replay?.complete, true)
  assert.equal('reasoningContent' in reply.replay!, false)
  assert.equal('reasoningField' in reply.replay!, false)
})

test('OpenAI rejects unfinished streams, provider errors and incomplete tool arguments', async () => {
  for (const chunks of [
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
    ['data: {"error":{"message":"upstream-error"}}\n\n', 'data: [DONE]\n\n'],
    ['data: invalid-json\n\n', 'data: [DONE]\n\n'],
    ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"tool","arguments":"{"}}]}}]}\n\n', 'data: [DONE]\n\n'],
  ]) {
    await assert.rejects(() => consumeChatCompletionSse(sseBody(chunks), { routeKey: 'route-test' }))
  }
})

test('OpenAI cannot publish native replay after aborting a partial reasoning stream', async () => {
  const abort = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"partial"}}]}\n\n'))
    },
    cancel() { cancelled = true },
  })
  await assert.rejects(() => consumeChatCompletionSse(stream, {
    routeKey: 'route-test', signal: abort.signal, onReasoningDelta: () => { abort.abort() },
  }), /cancelled/)
  assert.equal(cancelled, true)
})

test('Anthropic captures indexed blocks, starting text, signatures, redactions and parallel tools', async () => {
  const reasoning: string[] = []
  const text: string[] = []
  const calls: Array<{ id: string; arguments: string }> = []
  const reply = await consumeMessagesSse(eventsBody([
    { type: 'message_start', message: { id: 'msg-native', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '先', citations: [] } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '查' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '原始', signature: 's-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'one-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'two' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redaction' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'b', name: 'second', input: {} } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'a', name: 'first', input: { seed: true } } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '2}' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'message_delta', usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]), {
    routeKey: 'route-test',
    onDelta: (value) => { text.push(value) },
    onReasoningDelta: (value) => { reasoning.push(value) },
    onToolDelta: (value) => { calls.push(value) },
  })
  assert.equal(reply.content, '先查')
  assert.deepEqual(text, ['先', '查'])
  assert.deepEqual(reasoning, ['原始', '思考'])
  assert.deepEqual(reply.toolCalls, [
    { id: 'a', name: 'first', arguments: '{"seed":true}' },
    { id: 'b', name: 'second', arguments: '{"x":2}' },
  ])
  assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 8 })
  assert.deepEqual(reply.replay?.blocks, [
    { type: 'thinking', thinking: '原始思考', signature: 's-one-two' },
    { type: 'redacted_thinking', data: 'opaque-redaction' },
    { type: 'text', text: '先查', citations: [] },
    { type: 'tool_use', id: 'a', name: 'first', input: { seed: true } },
    { type: 'tool_use', id: 'b', name: 'second', input: { x: 2 } },
  ])
  assert.equal(reply.replay?.complete, true)
  assert.equal(calls.at(-1)?.id, 'b')
  assert.equal(calls.at(-1)?.arguments, '{"x":2}')
})

test('Anthropic retains a complete native marker for ordinary text-only responses', async () => {
  const reply = await consumeMessagesSse(eventsBody([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'plain' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]), { routeKey: 'route-test' })
  assert.equal(reply.replay?.complete, true)
  assert.deepEqual(reply.replay?.blocks, [{ type: 'text', text: 'plain' }])
})

test('Anthropic rejects missing signatures, incomplete blocks and error events', async () => {
  for (const events of [
    [{ type: 'message_start', message: {} }],
    [{ type: 'error', error: { message: 'upstream-error' } }, { type: 'message_stop' }],
    [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'partial', signature: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ],
    [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
      { type: 'message_stop' },
    ],
  ]) await assert.rejects(() => consumeMessagesSse(eventsBody(events), { routeKey: 'route-test' }))
})

test('Anthropic does not expose replay after cancellation during thinking', async () => {
  const abort = new AbortController()
  await assert.rejects(() => consumeMessagesSse(eventsBody([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'partial', signature: '' } },
  ]), {
    routeKey: 'route-test', signal: abort.signal, onReasoningDelta: () => { abort.abort() },
  }), /cancelled/)
})
