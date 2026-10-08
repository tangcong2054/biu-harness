import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { afterEach, test, vi } from 'vitest'
import { LlmHttpError, LlmService, type LlmConfig } from './index.ts'
import {
  DEFAULT_TENCENT_TPM_RETRY_MS,
  DEFAULT_TENCENT_TOKEN_PLAN_MAX_OUTPUT,
  DEFAULT_TENCENT_TOKEN_PLAN_TPM,
  isTencentTokenPlan,
  resolveTencentTokenPlanHeadroom,
  resolveTencentTokenPlanMaxOutput,
  resolveTencentTokenPlanTpm,
  tencentTpmRetryDelay,
  TencentTokenPlanTpmLimiter,
} from './tencent-token-plan-tpm.ts'

const tokenPlanConfig: LlmConfig = {
  endpointId: 'custom-name',
  provider: 'openai',
  apiKey: 'secret',
  model: 'glm-5.2',
  baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
}

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

test('resolves explicit Token Plan output cap from request or model reserve', () => {
  assert.equal(
    resolveTencentTokenPlanMaxOutput({ ...tokenPlanConfig, outputReserveTokens: 12_000 }),
    12_000,
  )
  assert.equal(resolveTencentTokenPlanMaxOutput(tokenPlanConfig, 4096), 4096)
  assert.equal(resolveTencentTokenPlanMaxOutput(tokenPlanConfig), DEFAULT_TENCENT_TOKEN_PLAN_MAX_OUTPUT)
})

test('Token Plan requests send max_tokens matching the local output reservation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }))
  const service = new LlmService(new Context())
  const client = service.forConfig({ ...tokenPlanConfig, outputReserveTokens: 16_384 })

  await client.chat([{ role: 'user', content: 'normal' }])
  await client.chat([{ role: 'user', content: 'compact' }], [], undefined, {
    maxOutputTokens: 4096,
  })

  assert.equal(bodies[0]?.max_tokens, 16_384)
  assert.equal(bodies[1]?.max_tokens, 4096)
})

test('recognizes Tencent TPM errors and honors Retry-After', () => {
  assert.equal(
    tencentTpmRetryDelay(new LlmHttpError('limited', 429, 429003, 'req-1', 2500)),
    2500,
  )
  assert.equal(
    tencentTpmRetryDelay(new Error('Token usage exceeds the current model TPM limit')),
    DEFAULT_TENCENT_TPM_RETRY_MS,
  )
  assert.equal(tencentTpmRetryDelay(new LlmHttpError('other', 500)), undefined)
})

test('Token Plan automatically retries one 429003 response', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'biu-tpm-retry-'))
  tempDirs.push(logDir)
  vi.stubEnv('BIU_LLM_LOG_DIR', logDir)
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 429003,
          message: 'Token usage exceeds the current model TPM limit',
          request_id: 'req-tpm',
        },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      })
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }))
  const service = new LlmService(new Context())
  const reply = await service
    .forConfig({ ...tokenPlanConfig, outputReserveTokens: 16_384 })
    .chat([{ role: 'user', content: 'retry' }])
  assert.equal(calls, 2)
  assert.equal(reply.content, 'ok')
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

test('server cooldown delays subsequent reservations', async () => {
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
  limiter.defer(2500)
  await limiter.acquire(10)
  assert.deepEqual(waits, [2500])
})
