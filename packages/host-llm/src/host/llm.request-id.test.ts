import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { AnthropicLlm, LlmHttpError, OpenAiCompatLlm, consumeChatCompletionSse, requestIdFromHeaders } from '@biu/host-llm'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('requestIdFromHeaders checks common provider headers in order', () => {
  assert.equal(requestIdFromHeaders(new Headers({ 'x-request-id': 'a', 'request-id': 'b' })), 'a')
  assert.equal(requestIdFromHeaders(new Headers({ 'X-TC-RequestId': 'tc-1' })), 'tc-1')
  assert.equal(requestIdFromHeaders(new Headers({ 'request-id': 'req_anthropic' })), 'req_anthropic')
  assert.equal(requestIdFromHeaders(new Headers({ 'x-request-id': '  ' })), undefined)
  assert.equal(requestIdFromHeaders(new Headers()), undefined)
  assert.equal(requestIdFromHeaders(undefined), undefined)
})

test('consumeChatCompletionSse keeps chunk id as responseId and stream request_id as fallback', async () => {
  const reply = await consumeChatCompletionSse(
    sseBody([
      'data: {"id":"chatcmpl-1","request_id":"req-stream","choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  )
  assert.equal(reply.responseId, 'chatcmpl-1')
  assert.equal(reply.requestId, 'req-stream')
})

test('consumeChatCompletionSse prefers the header request id over the stream one', async () => {
  const reply = await consumeChatCompletionSse(
    sseBody([
      'data: {"id":"chatcmpl-2","request_id":"req-stream","choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    { requestId: 'req-header' },
  )
  assert.equal(reply.requestId, 'req-header')
})

test('consumeChatCompletionSse omits ids when the provider sends none', async () => {
  const reply = await consumeChatCompletionSse(
    sseBody(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']),
  )
  assert.equal('requestId' in reply, false)
  assert.equal('responseId' in reply, false)
})

test('OpenAiCompatLlm returns the response header request id on success', async () => {
  globalThis.fetch = (async () =>
    new Response(
      'data: {"id":"chatcmpl-3","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'tc-req-1' } },
    )) as typeof fetch
  const llm = new OpenAiCompatLlm({ provider: 'openai', apiKey: 'k', model: 'm', baseUrl: 'http://llm.test/v1' })
  const reply = await llm.chat([{ role: 'user', content: 'hi' }])
  assert.equal(reply.content, 'ok')
  assert.equal(reply.requestId, 'tc-req-1')
  assert.equal(reply.responseId, 'chatcmpl-3')
})

test('OpenAiCompatLlm errors fall back to the header request id when the body has none', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'boom' } }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'x-request-id': 'tc-req-err' },
    })) as typeof fetch
  const llm = new OpenAiCompatLlm({ provider: 'openai', apiKey: 'k', model: 'm', baseUrl: 'http://llm.test/v1' })
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'hi' }]),
    (error: unknown) => {
      assert.ok(error instanceof LlmHttpError)
      assert.equal(error.requestId, 'tc-req-err')
      assert.match(error.message, /request_id=tc-req-err/)
      return true
    },
  )
})

test('AnthropicLlm returns request-id header and message id', async () => {
  globalThis.fetch = (async () =>
    new Response(
      [
        'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_a1' } },
    )) as typeof fetch
  const llm = new AnthropicLlm({ provider: 'anthropic', apiKey: 'k', model: 'm', baseUrl: 'http://llm.test' })
  const reply = await llm.chat([{ role: 'user', content: 'hi' }])
  assert.equal(reply.content, 'ok')
  assert.equal(reply.requestId, 'req_a1')
  assert.equal(reply.responseId, 'msg_1')
})
