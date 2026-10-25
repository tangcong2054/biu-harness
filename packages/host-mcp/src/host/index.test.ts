import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import * as tools from '@biu/host-tools'
import * as mcp from './index.ts'
import { incompleteReason, listToEnv, listToHeaders, parseMcpConfig, serializeMcpConfig, toolAllowed } from './config.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biu-mcp-'))
  process.env.BIU_MCP_CONFIG = join(dir, 'mcp.json')
})

afterEach(() => {
  delete process.env.BIU_MCP_CONFIG
  delete process.env.BIU_ONLINE
  delete process.env.BIU_HOME
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(mcp)
  return ctx
}

test('in-process mcp echo provider', async () => {
  const ctx = await boot()
  const listed = await ctx.tools.invoke('mcp_list')
  assert.equal(Array.isArray(listed) && listed.some((item: { name: string }) => item.name === 'mcp_echo'), true)
  assert.equal(ctx.tools.executionMode('mcp_servers'), 'parallel')
  assert.equal(ctx.tools.executionMode('mcp_list'), 'parallel')
  assert.equal(ctx.tools.executionMode('mcp_call', { server: 'echo', name: 'mcp_echo' }), 'parallel')
  assert.equal(ctx.tools.executionMode('mcp_call', { server: 'missing', name: 'unknown' }), 'exclusive')
  const result = (await ctx.tools.invoke('mcp_call', { server: 'echo', name: 'mcp_echo', arguments: { text: 'hi' } })) as { text: string }
  assert.equal(result.text, 'hi')
  const catalog = ctx.mcp.catalog('echo')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0]?.name, 'mcp_echo')
  assert.equal(catalog[0]?.allowed, true)
})

test('mcp_remove refuses built-in echo and exposes add/remove tools', async () => {
  const ctx = await boot()
  for (const name of ['mcp_add_stdio', 'mcp_remove', 'mcp_servers', 'mcp_list', 'mcp_call']) {
    assert.equal(ctx.tools.names().includes(name), true, name)
  }
  await assert.rejects(() => ctx.tools.invoke('mcp_remove', { id: 'echo' }), /cannot remove built-in/)
  assert.deepEqual(ctx.mcp.serverIds(), ['echo'])
})

test('mcp_servers reports the built-in row as ready', async () => {
  const ctx = await boot()
  const rows = (await ctx.tools.invoke('mcp_servers')) as Array<{ id: string; status: string; builtin: boolean; toolCount: number }>
  assert.deepEqual(rows.map((row) => row.id), ['echo'])
  assert.equal(rows[0]?.status, 'ready')
  assert.equal(rows[0]?.builtin, true)
  assert.equal(rows[0]?.toolCount, 1)
})

test('config parses the Cursor mcpServers shape and infers transport', () => {
  const parsed = parseMcpConfig({
    mcpServers: {
      local: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { TOKEN: 'x' } },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer k' } },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
      off: { command: 'noop', enabled: false },
      broken: { args: ['nothing'] },
    },
  })
  // broken 缺 command，但不会被丢掉：它成为一行草稿，界面上能看到还差什么。
  assert.deepEqual(parsed.map((item) => item.id), ['broken', 'legacy', 'local', 'off', 'remote'])
  const byId = new Map(parsed.map((item) => [item.id, item]))
  assert.equal(incompleteReason(byId.get('broken')!), '还没填命令（command），填好后启用')
  assert.equal(incompleteReason(byId.get('local')!), '')
  assert.equal(incompleteReason(byId.get('remote')!), '')
  assert.equal(byId.get('local')?.transport, 'stdio')
  assert.equal(byId.get('local')?.env.TOKEN, 'x')
  assert.equal(byId.get('remote')?.transport, 'http')
  assert.equal(byId.get('legacy')?.transport, 'sse')
  assert.equal(byId.get('local')?.enabled, true)
  assert.equal(byId.get('off')?.enabled, false)
})

test('config round-trips through the mcpServers shape', () => {
  const source = {
    mcpServers: {
      local: { command: 'npx', args: ['-y', 'x'], tools: { deny: ['write_file'] } },
      remote: { type: 'http', url: 'https://example.com/mcp', enabled: false },
    },
  }
  const again = parseMcpConfig(serializeMcpConfig(parseMcpConfig(source)))
  assert.equal(again.length, 2)
  assert.deepEqual(again[0]?.tools.deny, ['write_file'])
  assert.equal(again[1]?.enabled, false)
})

test('tool selection: deny wins over allow and both take wildcards', () => {
  assert.equal(toolAllowed({ allow: [], deny: [] }, 'read_file'), true)
  assert.equal(toolAllowed({ allow: ['read_file'], deny: [] }, 'read_file'), true)
  assert.equal(toolAllowed({ allow: ['read_file'], deny: [] }, 'write_file'), false)
  assert.equal(toolAllowed({ allow: [], deny: ['write_file'] }, 'write_file'), false)
  assert.equal(toolAllowed({ allow: ['read_*'], deny: [] }, 'read_text_file'), true)
  assert.equal(toolAllowed({ allow: ['*'], deny: ['write_*'] }, 'write_file'), false)
  assert.equal(toolAllowed({ allow: ['read_file'], deny: ['read_file'] }, 'read_file'), false)
})

test('restore loads .biu/mcp.json and keeps disabled servers idle', async () => {
  writeFileSync(
    process.env.BIU_MCP_CONFIG!,
    JSON.stringify({ mcpServers: { parked: { command: 'noop-command', enabled: false } } }),
  )
  const ctx = await boot()
  await ctx.mcp.restore()
  const rows = ctx.mcp.listServers()
  assert.deepEqual(rows.map((row) => row.id), ['echo', 'parked'])
  const parked = rows.find((row) => row.id === 'parked')
  assert.equal(parked?.status, 'idle')
  assert.equal(parked?.enabled, false)
})

test('setToolFilter persists the selection without reconnecting', async () => {
  writeFileSync(
    process.env.BIU_MCP_CONFIG!,
    JSON.stringify({ mcpServers: { parked: { command: 'noop-command', enabled: false } } }),
  )
  const ctx = await boot()
  await ctx.mcp.restore()
  const row = ctx.mcp.setToolFilter('parked', { allow: ['read_*'], deny: ['read_secret'] })
  assert.deepEqual(row.allow, ['read_*'])
  assert.deepEqual(row.deny, ['read_secret'])
  const onDisk = parseMcpConfig(JSON.parse(readFileSync(process.env.BIU_MCP_CONFIG!, 'utf8')) as unknown)
  assert.deepEqual(onDisk[0]?.tools, { allow: ['read_*'], deny: ['read_secret'] })
})

test('a disabled tool cannot be reached even by guessing its name', async () => {
  writeFileSync(
    process.env.BIU_MCP_CONFIG!,
    JSON.stringify({
      mcpServers: { parked: { command: 'noop-command', enabled: false, tools: { deny: ['write_file'] } } },
    }),
  )
  const ctx = await boot()
  await ctx.mcp.restore()
  await assert.rejects(
    () => ctx.tools.invoke('mcp_call', { server: 'parked', name: 'write_file' }),
    /disabled by server config/,
  )
  // 未被排除的工具走到连接检查才失败，说明过滤没有误伤。
  await assert.rejects(
    () => ctx.tools.invoke('mcp_call', { server: 'parked', name: 'read_file' }),
    /not connected/,
  )
})

test('echo is reserved and cannot be overwritten by upsert', async () => {
  const ctx = await boot()
  await assert.rejects(() => ctx.mcp.upsert({ id: 'echo', command: 'noop' }), /reserved/)
})

test('draft(): a new row lands disabled, persisted, and says what it needs', async () => {
  const ctx = await boot()
  const row = ctx.mcp.draft()
  assert.equal(row.id, 'new-server')
  assert.equal(row.enabled, false)
  assert.equal(row.status, 'idle')
  assert.equal(row.error, '还没填命令（command），填好后启用')
  // 已经落盘，重启后这行草稿还在。
  assert.deepEqual(parseMcpConfig(JSON.parse(readFileSync(process.env.BIU_MCP_CONFIG!, 'utf8')) as unknown).map((c) => c.id), ['new-server'])
  // 连续新建不会撞名。
  assert.equal(ctx.mcp.draft().id, 'new-server-2')
})

test('a draft cannot be connected until it has a command', async () => {
  const ctx = await boot()
  ctx.mcp.draft()
  await assert.rejects(() => ctx.mcp.connect('new-server'), /not configured yet/)
})

test('patchConfig fills a draft field by field and persists each step', async () => {
  const ctx = await boot()
  ctx.mcp.draft()
  await ctx.mcp.patchConfig('new-server', { command: 'noop-command' })
  let row = ctx.mcp.listServers().find((item) => item.id === 'new-server')
  assert.equal(row?.command, 'noop-command')
  assert.equal(row?.error, '', '填完命令后不该再提示缺字段')
  await ctx.mcp.patchConfig('new-server', { args: ['-y', 'pkg'], env: { TOKEN: 'x' } })
  const config = ctx.mcp.configOf('new-server')
  assert.deepEqual(config.args, ['-y', 'pkg'])
  assert.deepEqual(config.env, { TOKEN: 'x' })
  row = ctx.mcp.listServers().find((item) => item.id === 'new-server')
  assert.equal(row?.status, 'idle', '草稿还停用着，填字段不该去连接')
})

test('switching transport to http asks for a url instead of a command', async () => {
  const ctx = await boot()
  ctx.mcp.draft()
  await ctx.mcp.patchConfig('new-server', { command: 'noop' })
  await ctx.mcp.patchConfig('new-server', { transport: 'http' })
  const row = ctx.mcp.listServers().find((item) => item.id === 'new-server')
  assert.equal(row?.error, '还没填地址（url），需要 http(s) 开头')
  await ctx.mcp.patchConfig('new-server', { url: 'https://example.com/mcp' })
  assert.equal(ctx.mcp.listServers().find((item) => item.id === 'new-server')?.error, '')
})

test('rename moves the config to the new key and frees the old one', async () => {
  const ctx = await boot()
  ctx.mcp.draft()
  await ctx.mcp.patchConfig('new-server', { command: 'noop-command' })
  await ctx.mcp.rename('new-server', 'filesystem')
  assert.deepEqual(ctx.mcp.serverIds(), ['echo', 'filesystem'])
  assert.equal(ctx.mcp.configOf('filesystem').command, 'noop-command')
  const onDisk = parseMcpConfig(JSON.parse(readFileSync(process.env.BIU_MCP_CONFIG!, 'utf8')) as unknown)
  assert.deepEqual(onDisk.map((c) => c.id), ['filesystem'])
  // 不能撞上已有的名字，也不能改内置行。
  ctx.mcp.draft()
  await assert.rejects(() => ctx.mcp.rename('new-server', 'filesystem'), /already exists/)
  await assert.rejects(() => ctx.mcp.rename('echo', 'anything'), /built-in/)
})

test('env / headers survive the round trip through their table form', () => {
  assert.deepEqual(listToEnv(['TOKEN=abc', 'EMPTY=', 'no-separator', '=nokey']), { TOKEN: 'abc', EMPTY: '' })
  // token 里带逗号不能被当成分隔符切开。
  assert.deepEqual(listToEnv(['LIST=a,b,c']), { LIST: 'a,b,c' })
  assert.deepEqual(listToHeaders(['Authorization: Bearer x,y', 'Bad']), { Authorization: 'Bearer x,y' })
})

test('online MCP configuration and agent tool calls are isolated by workspace', async () => {
  process.env.BIU_ONLINE = '1'
  process.env.BIU_HOME = dir
  const ctx = new Context()
  ctx.provide('account', { store: { isMember: (accountId: string, workspaceId: string) =>
    accountId === 'acc_member' && ['ws_first', 'ws_second'].includes(workspaceId) } })
  await ctx.plugin(tools)
  await ctx.plugin(mcp)
  const inWorkspace = <T>(id: string, fn: () => T) =>
    runWithAccount('acc_member', () => runWithRequestWorkspace(id, fn))
  await inWorkspace('ws_first', () => ctx.mcp.upsert({ id: 'shared', command: 'first-server', enabled: false }))
  await inWorkspace('ws_second', () => ctx.mcp.upsert({ id: 'shared', command: 'second-server', enabled: false }))
  assert.equal(inWorkspace('ws_first', () => ctx.mcp.configOf('shared').command), 'first-server')
  assert.equal(inWorkspace('ws_second', () => ctx.mcp.configOf('shared').command), 'second-server')
  await inWorkspace('ws_first', () => ctx.mcp.upsert({ id: 'only-first', command: 'noop', enabled: false }))
  assert.equal(inWorkspace('ws_second', () => ctx.mcp.listServers().some((s) => s.id === 'only-first')), false)
  const firstServers = await inWorkspace('ws_first', () => ctx.tools.invoke('mcp_servers')) as Array<{ id: string }>
  const secondServers = await inWorkspace('ws_second', () => ctx.tools.invoke('mcp_servers')) as Array<{ id: string }>
  assert.deepEqual(firstServers.map((s) => s.id), ['echo', 'only-first', 'shared'])
  assert.deepEqual(secondServers.map((s) => s.id), ['echo', 'shared'])
  await assert.rejects(() => inWorkspace('ws_second', () => ctx.tools.invoke('mcp_list', { server: 'only-first' })), /unknown mcp server/)
  await assert.rejects(() => inWorkspace('ws_second', () => ctx.tools.invoke('mcp_call', {
    server: 'only-first', name: 'anything', arguments: {},
  })), /unknown mcp server/)
  assert.deepEqual(inWorkspace('ws_first', () => ctx.mcp.serverIds()), ['echo', 'only-first', 'shared'])
  assert.deepEqual(inWorkspace('ws_second', () => ctx.mcp.serverIds()), ['echo', 'shared'])
  const firstPath = inWorkspace('ws_first', () => mcp.mcpConfigPath(dir))
  const secondPath = inWorkspace('ws_second', () => mcp.mcpConfigPath(dir))
  assert.notEqual(firstPath, secondPath)
  assert.equal(parseMcpConfig(JSON.parse(readFileSync(firstPath, 'utf8'))).length, 2)
  assert.equal(parseMcpConfig(JSON.parse(readFileSync(secondPath, 'utf8'))).length, 1)
  await assert.rejects(() => ctx.tools.invoke('mcp_call', { server: 'echo', name: 'mcp_echo' }), /工作区成员身份/)
  assert.throws(() => inWorkspace('ws_third', () => ctx.mcp.listServers()), /工作区成员身份/)
})

test('authenticated workspace MCP stays isolated even when BIU_ONLINE is unset', async () => {
  process.env.BIU_HOME = dir
  const ctx = new Context()
  ctx.provide('account', { store: {
    isMember: (accountId: string, workspaceId: string) => accountId === 'acc_member' && ['ws_first', 'ws_second'].includes(workspaceId),
    activeWorkspaceId: () => 'ws_first',
  } })
  await ctx.plugin(tools)
  await ctx.plugin(mcp)
  const scoped = <T>(workspaceId: string, fn: () => T) =>
    runWithAccount('acc_member', () => runWithRequestWorkspace(workspaceId, fn))
  await scoped('ws_first', () => ctx.mcp.upsert({ id: 'only-first', command: 'unused', enabled: false }))
  assert.deepEqual(scoped('ws_first', () => ctx.mcp.serverIds()), ['echo', 'only-first'])
  assert.deepEqual(scoped('ws_second', () => ctx.mcp.serverIds()), ['echo'])
  assert.equal(readFileSync(scoped('ws_first', () => mcp.mcpConfigPath(dir)), 'utf8').includes('only-first'), true)
  // 直接调 agent 工具也不能读取另一个工作区的 MCP，且无账号时不能回退到全局配置。
  await assert.rejects(() => scoped('ws_second', () => ctx.tools.invoke('mcp_call', { server: 'only-first', name: 'any' })), /unknown mcp server/)
  await assert.rejects(() => ctx.tools.invoke('mcp_servers'), /工作区成员身份/)
})

test('mcp table only keeps enable, disable, and uninstall actions', () => {
  const src = readFileSync(resolve(import.meta.dirname, './collection.ts'), 'utf8')
  assert.match(src, /id: 'enable'/)
  assert.match(src, /id: 'disable'/)
  assert.match(src, /id: 'uninstall'/)
  for (const id of ['add', 'connect', 'disconnect', 'refresh', 'list_tools', 'select']) {
    assert.doesNotMatch(src, new RegExp(`id: '${id}'`), id)
  }
})
