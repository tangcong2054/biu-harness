import assert from 'node:assert/strict'
import { test } from 'vitest'
import { resolveOpenAiCompatUrl } from '@biu/host-llm'

test('uses provider default endpoint when no custom endpoint is configured', () => {
  assert.equal(
    resolveOpenAiCompatUrl({ provider: 'deepseek', apiKey: 'test', model: 'deepseek-chat' }),
    'https://api.deepseek.com/chat/completions',
  )
  assert.equal(
    resolveOpenAiCompatUrl({ provider: 'openai', apiKey: 'test', model: 'gpt-4o-mini' }),
    'https://api.openai.com/v1/chat/completions',
  )
})

test('accepts a custom HTTPS chat completions endpoint', () => {
  assert.equal(
    resolveOpenAiCompatUrl({
      provider: 'openai',
      apiKey: 'test',
      model: 'deepseek/deepseek-v4-flash-vision-exp',
      endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    }),
    'https://tokenhub.tencentmaas.com/v1/chat/completions',
  )
})

test('rejects unsafe custom endpoints', () => {
  assert.throws(
    () => resolveOpenAiCompatUrl({ provider: 'openai', apiKey: 'test', model: 'x', endpoint: 'http://example.com/v1/chat/completions' }),
    /HTTPS/,
  )
  assert.throws(
    () => resolveOpenAiCompatUrl({ provider: 'openai', apiKey: 'test', model: 'x', endpoint: 'https://user:pass@example.com/v1/chat/completions' }),
    /credentials/,
  )
})
