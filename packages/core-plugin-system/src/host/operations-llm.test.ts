import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { Context } from 'cordis'
import { readOperatorLlm, testOperatorLlm, writeOperatorLlm } from './operations-plugin.ts'

const FIXTURE = 'server-only-key'

function ctx(allowed: boolean): Context {
  return {
    get(name: string) {
      if (name !== 'account') return undefined
      return { store: { isOperationsOperator: () => allowed } }
    },
  } as unknown as Context
}

function chatDouble() {
  const calls: Array<{ name: string; payload: unknown }> = []
  const view = { endpointId: 'deepseek', hint: 'ser…nly', configured: true, acceptsApiKeys: true }
  const chat = {
    activateAccount() {
      calls.push({ name: 'activate', payload: null })
    },
    patch(payload: unknown) {
      calls.push({ name: 'patch', payload })
    },
    applyAdminApiKeys(payload: unknown) {
      calls.push({ name: 'keys', payload })
      return { locked: [], view }
    },
    operatorPublicView() {
      return view
    },
    async testConnection(payload: { endpointId?: string; apiKey?: string }) {
      calls.push({ name: 'test', payload })
      return {
        ok: false,
        endpointId: payload.endpointId || 'deepseek',
        detail: `rejected ${payload.apiKey || ''}`,
      }
    },
    invalidateEndpoint(endpointId: string) {
      calls.push({ name: 'invalidate', payload: endpointId })
    },
    markEndpointReachable() {
      calls.push({ name: 'reachable', payload: null })
    },
  }
  return { chat, calls }
}

test('people outside the operations workspace cannot read or write model keys', async () => {
  const { chat, calls } = chatDouble()
  const read = await readOperatorLlm(ctx(false), chat)
  const write = await writeOperatorLlm(ctx(false), chat, { setApiKey: { deepseek: FIXTURE } })
  const tested = await testOperatorLlm(ctx(false), chat, { apiKey: FIXTURE })
  assert.equal(read.status, 403)
  assert.equal(write.status, 403)
  assert.equal(tested.status, 403)
  assert.equal(calls.length, 0)
  assert.equal(JSON.stringify(write.body).includes(FIXTURE), false)
  assert.equal(JSON.stringify(tested.body).includes(FIXTURE), false)
})

test('operator model save reuses the chat patch and admin key writer', async () => {
  const { chat, calls } = chatDouble()
  const result = await writeOperatorLlm(ctx(true), chat, {
    endpointId: 'deepseek',
    model: 'deepseek-v4-flash',
    setApiKey: { deepseek: FIXTURE },
  })
  assert.equal(result.status, 200)
  assert.equal(JSON.stringify(result.body).includes(FIXTURE), false)
  assert.deepEqual(calls.map((call) => call.name), ['activate', 'patch', 'keys'])
  assert.deepEqual(calls[1]?.payload, { endpointId: 'deepseek', model: 'deepseek-v4-flash' })
  assert.deepEqual(calls[2]?.payload, { deepseek: FIXTURE })
})

test('connection failures do not echo the submitted key', async () => {
  const { chat } = chatDouble()
  const result = await testOperatorLlm(ctx(true), chat, { endpointId: 'deepseek', apiKey: FIXTURE })
  assert.equal(result.status, 400)
  const body = JSON.stringify(result.body)
  assert.equal(body.includes(FIXTURE), false)
  assert.equal(body.includes('rejected'), true)
})

test('in MySQL mode operator access comes from MySQL membership, not the local replica', async () => {
  const chat = chatDouble().chat
  const calls: string[] = []
  const mysqlCtx = (role: string | null) => ({
    get(name: string) {
      if (name !== 'account') return undefined
      return {
        // 本地副本说是运营管理员，MySQL 才是真实数据。
        store: { isOperationsOperator: () => true },
        async isOperationsOperatorAsync(accountId: string) {
          calls.push(accountId)
          return role === 'owner' || role === 'admin'
        },
      }
    },
  }) as unknown as Context
  assert.equal((await readOperatorLlm(mysqlCtx(null), chat)).status, 403)
  assert.equal((await readOperatorLlm(mysqlCtx('member'), chat)).status, 403)
  assert.equal((await readOperatorLlm(mysqlCtx('admin'), chat)).status, 200)
  assert.equal(calls.length, 3)
})
