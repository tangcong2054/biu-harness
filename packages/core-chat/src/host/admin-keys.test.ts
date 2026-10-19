import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { dataPath } from '@biu/host-plugin-loader/data-dir'
import { ChatService, adminKeyEnvLock, readAdminApiKeys, writeAdminApiKeys } from './index.ts'

const FIXTURE = 'server-only-key'

class PromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }
  register() {}
}

class SessionsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  peek() {
    return null
  }
}

class AgentsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }
  configure() {}
}

class ToolsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  setMode() {}
  setPinnedExtras() {}
  names() {
    return []
  }
  catalog() {
    return []
  }
}

test('admin key file merges endpoint keys and skips env-locked providers', async () => {
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'env-locked-fixture'
  const dir = await mkdtemp(join(tmpdir(), 'biu-admin-keys-'))
  const path = join(dir, 'chat-secrets.json')
  try {
    assert.equal(adminKeyEnvLock('openai'), 'OPENAI_API_KEY')
    const saved = writeAdminApiKeys({ openai: 'should-not-land', 'token-plan': FIXTURE, empty: '' }, path)
    assert.deepEqual(saved.locked, ['openai'])
    assert.deepEqual(readAdminApiKeys(path), { 'token-plan': FIXTURE })
    const text = readFileSync(path, 'utf8')
    assert.equal(text.includes('should-not-land'), false)
    assert.equal(text.includes('env-locked-fixture'), false)
    writeAdminApiKeys({ 'token-plan': null }, path)
    assert.deepEqual(readAdminApiKeys(path), {})
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('operator key write updates memory and the admin file, not online chat-config', async () => {
  const previousHome = process.env.BIU_HOME
  const previousOnline = process.env.BIU_ONLINE
  const dir = await mkdtemp(join(tmpdir(), 'biu-admin-chat-'))
  process.env.BIU_HOME = dir
  process.env.BIU_ONLINE = '1'
  const ctx = new Context()
  try {
    await ctx.plugin(PromptStub)
    await ctx.plugin(SessionsStub)
    await ctx.plugin(AgentsStub)
    await ctx.plugin(ToolsStub)
    const chat = new ChatService(ctx)
    chat.patch({
      addEndpoint: {
        id: 'ops-test-endpoint',
        label: 'Ops Test',
        baseUrl: 'https://example.test/v1',
        protocol: 'openai-compat',
      },
    })
    const applied = chat.applyAdminApiKeys({ 'ops-test-endpoint': FIXTURE })
    assert.deepEqual(applied.locked, [])
    const secrets = readFileSync(dataPath(dir, 'chat-secrets.json'), 'utf8')
    const config = readFileSync(dataPath(dir, 'chat-config.json'), 'utf8')
    assert.equal(secrets.includes(FIXTURE), true)
    assert.equal(config.includes(FIXTURE), false)
    const llm = chat.resolveLlm()
    assert.equal(llm.endpointId, 'ops-test-endpoint')
    assert.equal(llm.apiKey === FIXTURE, true)
    const view = JSON.stringify(chat.operatorPublicView())
    assert.equal(view.includes(FIXTURE), false)
    assert.equal(view.includes('"acceptsApiKeys":true'), true)
  } finally {
    if (previousHome === undefined) delete process.env.BIU_HOME
    else process.env.BIU_HOME = previousHome
    if (previousOnline === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previousOnline
    await rm(dir, { recursive: true, force: true })
  }
})
