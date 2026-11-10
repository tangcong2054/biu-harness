/** @vitest-environment node */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { Context, Service } from 'cordis'
import { dataPath } from '@biu/host-plugin-loader/data-dir'
import { ChatService, adminKeyEnvLock, apply, readAdminApiKeys, writeAdminApiKeys } from './index.ts'

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
  peek(id?: string) {
    return id === 'existing-session' ? { config: { provider: 'openai', model: 'gpt-test' } } : null
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

type ConfigRoute = {
  json(): Promise<unknown>
  query: URLSearchParams
  send(status: number, body: unknown): void
}

class HttpStub extends Service {
  routes = new Map<string, (route: ConfigRoute) => unknown>()
  constructor(ctx: Context) {
    super(ctx, 'http')
  }
  route(method: string, path: string, handler: (route: ConfigRoute) => unknown) {
    this.routes.set(`${method} ${path}`, handler)
  }
  async request(method: string, payload?: unknown) {
    let response: { status: number; body: unknown } | undefined
    const handler = this.routes.get(`${method} /api/chat/config`)
    assert.ok(handler)
    await handler({
      json: async () => payload,
      query: new URLSearchParams(),
      send: (status, body) => { response = { status, body } },
    })
    assert.ok(response)
    return response
  }
}

class HubStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'hub')
  }
  register() {}
}

async function withReplayConfig(
  online: boolean,
  run: (boot: () => Promise<{ chat: ChatService; http: HttpStub }>, path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'biu-replay-config-'))
  vi.stubEnv('BIU_HOME', dir)
  vi.stubEnv('BIU_ONLINE', online ? '1' : '0')
  for (const name of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'CHAT_MODEL']) vi.stubEnv(name, '')
  try {
    await run(async () => {
      const ctx = new Context()
      await ctx.plugin(PromptStub)
      await ctx.plugin(SessionsStub)
      await ctx.plugin(AgentsStub)
      await ctx.plugin(ToolsStub)
      const http = new HttpStub(ctx)
      new HubStub(ctx)
      apply(ctx)
      return { chat: ctx.chat, http }
    }, dataPath(dir, 'chat-config.json'))
  } finally {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
}

for (const online of [false, true]) {
  test(`replay config persists and reloads without credentials (online=${online})`, async () => {
    await withReplayConfig(online, async (boot, path) => {
      const { chat, http } = await boot()
      assert.equal(chat.publicView().replayMode, 'native-replay')
      assert.equal(chat.resolveLlm().replayMode, 'native-replay')
      const saved = await http.request('POST', { replayMode: 'native-replay' })
      assert.equal(saved.status, 200)
      assert.equal((saved.body as { replayMode: string }).replayMode, 'native-replay')
      const persisted = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(persisted.replayMode, 'native-replay')
      if (online) assert.equal('apiKeys' in persisted, false)
      const reloaded = await boot()
      assert.equal(reloaded.chat.publicView().configured, false)
      assert.equal(reloaded.chat.resolveLlm().replayMode, 'native-replay')
      assert.equal(reloaded.chat.resolveLlm('existing-session').replayMode, 'native-replay')
      const effective = reloaded.chat.resolveEffective('existing-session')
      assert.equal(effective.defaults.replayMode, 'native-replay')
      assert.equal(effective.effective.replayMode, 'native-replay')
      assert.equal(effective.effective.provider, 'openai')
      assert.equal(effective.effective.model, 'gpt-test')
      const publicConfig = await reloaded.http.request('GET')
      assert.equal(publicConfig.status, 200)
      assert.equal((publicConfig.body as { replayMode: string }).replayMode, 'native-replay')
      await reloaded.http.request('POST', { replayMode: 'lean-replay' })
      assert.equal((await boot()).chat.resolveLlm().replayMode, 'lean-replay')
    })
  })
}

test('missing or invalid persisted replay modes fall back to native replay without replacing an explicit lean choice', async () => {
  await withReplayConfig(false, async (boot, path) => {
    const { chat } = await boot()
    chat.patch({ replayMode: 'lean-replay' })
    const valid = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal((await boot()).chat.resolveLlm().replayMode, 'lean-replay')
    for (const replayMode of [undefined, null, '', 'native', 42, {}, ['native-replay']]) {
      writeFileSync(path, JSON.stringify({ ...valid, replayMode }))
      const reloaded = await boot()
      assert.equal(reloaded.chat.publicView().replayMode, 'native-replay')
      assert.equal(reloaded.chat.resolveLlm().replayMode, 'native-replay')
    }
  })
})

test('HTTP rejects invalid replay modes atomically and preserves the secret boundary', async () => {
  await withReplayConfig(true, async (boot, path) => {
    const { chat, http } = await boot()
    chat.patch({ replayMode: 'native-replay' })
    const before = chat.publicView()
    const persisted = readFileSync(path, 'utf8')
    for (const replayMode of [null, '', 'lean', 'NATIVE-REPLAY', 0, {}, []]) {
      const response = await http.request('POST', { replayMode, model: 'must-not-apply' })
      assert.equal(response.status, 400)
      assert.deepEqual(chat.publicView(), before)
      assert.equal(readFileSync(path, 'utf8'), persisted)
    }
    assert.throws(() => chat.patch({ replayMode: 'bad', model: 'must-not-apply' } as never), /replayMode/)
    assert.deepEqual(chat.publicView(), before)
    const forbidden = await http.request('POST', { replayMode: 'lean-replay', setApiKey: { openai: FIXTURE } })
    assert.equal(forbidden.status, 403)
    assert.deepEqual(chat.publicView(), before)
    assert.equal(readFileSync(path, 'utf8'), persisted)
    const unchanged = await http.request('POST', { systemPrompt: 'updated' })
    assert.equal(unchanged.status, 200)
    assert.equal(chat.publicView().replayMode, 'native-replay')
  })
})
