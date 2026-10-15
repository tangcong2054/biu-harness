import assert from 'node:assert/strict'
import { test } from 'vitest'
import { modelIdsFromListBody, resolveModelsListUrl, resolveChatCompletionsUrl } from '@biu/host-llm'

test('resolveModelsListUrl derives from baseUrl', () => {
  assert.equal(resolveModelsListUrl('https://api.openai.com/v1', 'openai'), 'https://api.openai.com/v1/models')
  assert.equal(
    resolveModelsListUrl('https://api.closeai-asia.com/v1/chat/completions', 'openai'),
    'https://api.closeai-asia.com/v1/models',
  )
  assert.equal(resolveModelsListUrl(undefined, 'deepseek'), 'https://api.deepseek.com/models')
})

test('modelIdsFromListBody keeps upstream ids and drops blanks', () => {
  assert.deepEqual(
    modelIdsFromListBody({
      data: [
        { id: 'gpt-4o' },
        { id: ' gpt-4o ' },
        { id: 'claude-sonnet-4-20250514' },
        { id: '' },
        'deepseek-chat',
      ],
    }),
    ['gpt-4o', 'claude-sonnet-4-20250514', 'deepseek-chat'],
  )
  assert.deepEqual(modelIdsFromListBody({ models: ['kimi-k2'] }), ['kimi-k2'])
  assert.deepEqual(modelIdsFromListBody({}), [])
})

test('resolveChatCompletionsUrl still works alongside models url', () => {
  assert.equal(
    resolveChatCompletionsUrl('https://api.openai.com/v1', 'openai'),
    'https://api.openai.com/v1/chat/completions',
  )
})
