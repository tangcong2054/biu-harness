import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { LlmConfig, LlmMessage } from '@biu/host-llm'
import {
  AUTO_COMPACT_PROMPT,
  buildAutoCompactMessages,
  resolveContextPolicy,
} from './context-policy.ts'

const config: LlmConfig = {
  provider: 'openai',
  apiKey: 'k',
  model: 'demo',
  contextWindowTokens: 200_000,
  outputReserveTokens: 16_000,
}

test('policy derives model-aware compact and hard budgets including tool schemas', () => {
  const withoutTools = resolveContextPolicy(config, [], {})
  const withTools = resolveContextPolicy(
    config,
    [{ type: 'function', function: { name: 'large', description: 'x'.repeat(4000) } }],
    {},
  )
  assert.equal(withoutTools.contextWindowTokens, 200_000)
  assert.equal(withoutTools.outputReserveTokens, 16_000)
  assert.equal(withoutTools.autoCompactRatio, 0.6)
  assert.equal(withoutTools.hardContextRatio, 0.8)
  assert.equal(withoutTools.autoCompactMessageTokens, 104_000)
  assert.equal(withoutTools.hardMessageTokens, 144_000)
  assert.ok(withTools.toolSchemaTokens > 900)
  assert.ok(withTools.autoCompactMessageTokens < withoutTools.autoCompactMessageTokens)
  assert.ok(withTools.hardMessageTokens < withoutTools.hardMessageTokens)
})

test('legacy CTX_BUDGET is a stricter override, not a way to disable model safety', () => {
  const strict = resolveContextPolicy(config, [], { CTX_BUDGET: '50000' })
  assert.equal(strict.hardMessageTokens, 50_000)
  assert.equal(strict.autoCompactMessageTokens, 37_500)

  const zero = resolveContextPolicy(config, [], { CTX_BUDGET: '0' })
  assert.equal(zero.hardMessageTokens, 144_000)
  assert.equal(zero.autoCompactMessageTokens, 104_000)
})

test('ratios and automatic compact can be configured safely', () => {
  const policy = resolveContextPolicy(config, [], {
    BIU_AUTO_COMPACT: 'false',
    BIU_AUTO_COMPACT_RATIO: '0.5',
    BIU_CONTEXT_HARD_RATIO: '0.75',
    BIU_COMPACT_MAX_OUTPUT: '2000',
  })
  assert.equal(policy.autoCompactEnabled, false)
  assert.equal(policy.autoCompactRatio, 0.5)
  assert.equal(policy.hardContextRatio, 0.75)
  assert.equal(policy.compactMaxOutputTokens, 2000)
})

test('compact request drops binary images and keeps a structured instruction', () => {
  const source: LlmMessage[] = [
    { role: 'system', content: 'normal agent system prompt' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '分析截图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    { role: 'assistant', content: '已分析' },
  ]
  const compact = buildAutoCompactMessages(source, 20_000)
  assert.equal(compact.overBudget, false)
  assert.equal(compact.messages[0]?.content, AUTO_COMPACT_PROMPT)
  assert.equal(compact.messages.at(-1)?.role, 'user')
  const json = JSON.stringify(compact.messages)
  assert.doesNotMatch(json, /data:image/)
  assert.match(json, /图片二进制未放入压缩请求/)
  assert.doesNotMatch(json, /normal agent system prompt/)
})
