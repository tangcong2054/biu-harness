import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { LlmConfig } from './index.ts'
import {
  DEFAULT_TENCENT_TOKEN_PLAN_TPM,
  isTencentTokenPlan,
  resolveTencentTokenPlanHeadroom,
  resolveTencentTokenPlanTpm,
  TencentTokenPlanTpmLimiter,
} from './tencent-token-plan-tpm.ts'

const tokenPlanConfig: LlmConfig = {
  endpointId: 'custom-name',
  provider: 'openai',
  apiKey: 'secret',
  model: 'glm-5.2',
  baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
}

test('detects Tencent Token Plan by endpoint id or official URL', () => {
  assert.equal(isTencentTokenPlan(tokenPlanConfig), true)
  assert.equal(
    isTencentTokenPlan({ ...tokenPlanConfig, endpointId: 'token-plan', baseUrl: 'https://proxy.test/v1' }),
    true,
  )
  assert.equal(
    isTencentTokenPlan({ ...tokenPlanConfig, baseUrl: 'https://api.openai.com/v1' }),
    false,
  )
})

test('resolves Tencent Token Plan TPM settings safely', () => {
  assert.equal(resolveTencentTokenPlanTpm({}), DEFAULT_TENCENT_TOKEN_PLAN_TPM)
  assert.equal(resolveTencentTokenPlanTpm({ TENCENT_TOKEN_PLAN_TPM: '5000000' }), 5_000_000)
  assert.equal(resolveTencentTokenPlanTpm({ TENCENT_TOKEN_PLAN_TPM: '0' }), DEFAULT_TENCENT_TOKEN_PLAN_TPM)
  assert.equal(resolveTencentTokenPlanHeadroom({}), 0.9)
  assert.equal(resolveTencentTokenPlanHeadroom({ TENCENT_TOKEN_PLAN_TPM_HEADROOM: '0.8' }), 0.8)
})

test('queues requests until enough rolling-window capacity is released', async () => {
  let now = 0
  const waits: number[] = []
  const limiter = new TencentTokenPlanTpmLimiter({
    limit: 100,
    headroom: 1,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms)
      now += ms
    },
  })

  await limiter.acquire(70)
  await limiter.acquire(40)
  assert.deepEqual(waits, [60_000])
})

test('reconciles estimated reservation with provider usage', async () => {
  let now = 0
  const waits: number[] = []
  const limiter = new TencentTokenPlanTpmLimiter({
    limit: 100,
    headroom: 1,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms)
      now += ms
    },
  })

  const first = await limiter.acquire(80)
  first.finish({ inputTokens: 20, outputTokens: 10 })
  await limiter.acquire(60)
  assert.deepEqual(waits, [])
})

test('rejects a request larger than local safe capacity', async () => {
  const limiter = new TencentTokenPlanTpmLimiter({ limit: 100, headroom: 0.9 })
  await assert.rejects(() => limiter.acquire(91), /超过本地 TPM 安全容量 90/)
})
