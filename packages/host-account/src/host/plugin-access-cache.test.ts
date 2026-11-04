import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { Context, Service } from 'cordis'
import { AccountService } from './index.ts'

/**
 * MySQL 控制面下工具可见性只读同步的插件授权缓存。
 * 回归点：
 *  - 插件包删除、成员移除 / 改角色、空间删除后缓存不失效，撤销授权后工具仍可调用；
 *  - 多实例部署收不到别的实例的撤销，必须有 TTL；
 *  - 服务重启后缓存为空，需要能预热。
 */

let dir = ''
let previousOnline: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biu-plugin-cache-'))
  previousOnline = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '1'
})

afterEach(() => {
  vi.useRealTimers()
  if (previousOnline === undefined) delete process.env.BIU_ONLINE
  else process.env.BIU_ONLINE = previousOnline
  rmSync(dir, { recursive: true, force: true })
})

function boot() {
  const grants = new Set(['ada\tws_a\tdemo', 'ada\tws_a\tother', 'bob\tws_a\tdemo'])
  const repository = {
    async canAccessPlugin(accountId: string, workspaceId: string, pluginId: string) {
      return grants.has(`${accountId}\t${workspaceId}\t${pluginId}`)
    },
    async removePluginPackage(_actor: string, pluginId: string) {
      for (const key of [...grants]) if (key.endsWith(`\t${pluginId}`)) grants.delete(key)
    },
    async uninstallPluginForAccount(accountId: string, workspaceId: string, pluginId: string) {
      grants.delete(`${accountId}\t${workspaceId}\t${pluginId}`)
    },
  }
  const ctx = new Context()
  class CloudStorage extends Service {
    accountMode = 'mysql' as const
    accountRepository = repository
    constructor(inner: Context) {
      super(inner, 'cloudStorage')
    }
  }
  new CloudStorage(ctx)
  const account = new AccountService(ctx, { sqlitePath: join(dir, 'biu.sqlite') })
  return { account, grants }
}

test('plugin access cache is empty after restart until warmed', async () => {
  const { account } = boot()
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), false)
  await account.warmPluginAccess('ada', 'ws_a', ['demo', 'other', 'missing'])
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), true)
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'other'), true)
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'missing'), false)
})

test('removing a plugin package revokes every cached grant for it', async () => {
  const { account } = boot()
  await account.warmPluginAccess('ada', 'ws_a', ['demo', 'other'])
  await account.warmPluginAccess('bob', 'ws_a', ['demo'])
  await account.removePluginPackage('ada', 'demo')
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), false)
  assert.equal(account.canAccessPluginCached('bob', 'ws_a', 'demo'), false)
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'other'), true)
})

test('member removal and role changes forget that member grants only', async () => {
  const { account } = boot()
  await account.warmPluginAccess('ada', 'ws_a', ['demo'])
  await account.warmPluginAccess('bob', 'ws_a', ['demo'])
  account.forgetPluginAccess({ accountId: 'bob', workspaceId: 'ws_a' })
  assert.equal(account.canAccessPluginCached('bob', 'ws_a', 'demo'), false)
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), true)
  account.forgetPluginAccess({ workspaceId: 'ws_a' })
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), false)
})

test('cached grants expire so revocations on another instance converge', async () => {
  const { account, grants } = boot()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'))
  await account.warmPluginAccess('ada', 'ws_a', ['demo'])
  // 另一台实例撤销了授权：这里收不到通知。
  grants.delete('ada\tws_a\tdemo')
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), true)
  vi.setSystemTime(new Date('2026-10-25T00:00:31Z'))
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), false)
})

test('workspace-wide authorization changes from the repository forget that workspace grants', async () => {
  const listeners = new Set<(workspaceId: string) => void>()
  const ctx = new Context()
  const repository = {
    async canAccessPlugin() { return true },
    async membership(accountId: string, workspaceId: string) {
      return accountId === 'ada' && workspaceId === 'ws_a' ? { role: 'member', memberKind: 'member' } : null
    },
    async listWorkspaces() { throw new Error('isMemberAsync must not list every workspace') },
    onWorkspaceAuthzChange(listener: (workspaceId: string) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  class CloudStorage extends Service {
    accountMode = 'mysql' as const
    accountRepository = repository
    constructor(inner: Context) {
      super(inner, 'cloudStorage')
    }
  }
  new CloudStorage(ctx)
  const account = new AccountService(ctx, { sqlitePath: join(dir, 'biu.sqlite') })
  assert.equal(await account.isMemberAsync('ada', 'ws_a'), true)
  assert.equal(await account.isMemberAsync('bob', 'ws_a'), false)
  await account.warmPluginAccess('ada', 'ws_a', ['demo'])
  await account.warmPluginAccess('ada', 'ws_b', ['demo'])
  for (const listener of listeners) listener('ws_a')
  assert.equal(account.canAccessPluginCached('ada', 'ws_a', 'demo'), false)
  assert.equal(account.canAccessPluginCached('ada', 'ws_b', 'demo'), true)
})

test('operations access and identity come from MySQL membership in MySQL mode', async () => {
  const ctx = new Context()
  const roles: Record<string, { role: string; memberKind: string }> = {
    acc_operations_admin: { role: 'owner', memberKind: 'member' },
    ops_admin: { role: 'admin', memberKind: 'member' },
    ops_member: { role: 'member', memberKind: 'member' },
    ops_external: { role: 'admin', memberKind: 'external' },
  }
  const repository = {
    async membership(accountId: string, workspaceId: string) {
      return workspaceId === 'ws_operations' ? roles[accountId] ?? null : null
    },
    async accountById(id: string) {
      return id === 'acc_operations_admin' ? { id, email: 'admin', name: '平台运营' } : null
    },
    async listWorkspaces(accountId: string) {
      return accountId === 'acc_operations_admin' ? [{ id: 'ws_operations', name: '平台运营' }] : []
    },
  }
  class CloudStorage extends Service {
    accountMode = 'mysql' as const
    accountRepository = repository
    constructor(inner: Context) {
      super(inner, 'cloudStorage')
    }
  }
  new CloudStorage(ctx)
  const account = new AccountService(ctx, { sqlitePath: join(dir, 'biu.sqlite') })
  assert.equal(existsSync(join(dir, 'biu.sqlite')), false)
  assert.equal(account.authorization, undefined)
  assert.throws(() => account.store.activeWorkspaceId(), /SQLite account replica is disabled/)
  // 本地副本里没有任何运营成员；MySQL 才是真实数据。
  assert.equal(await account.isOperationsOperatorAsync('acc_operations_admin'), true)
  assert.equal(await account.isOperationsOperatorAsync('ops_admin'), true)
  assert.equal(await account.isOperationsOperatorAsync('ops_member'), false)
  assert.equal(await account.isOperationsOperatorAsync('ops_external'), false)
  assert.equal(await account.isOperationsOperatorAsync('ops_admin', 'ws_other'), false)
  assert.equal(await account.isOperationsOperatorAsync(''), false)
  assert.deepEqual(await account.operationsIdentityAsync(), {
    id: 'acc_operations_admin', email: 'admin', name: '平台运营', workspaceId: 'ws_operations', workspaceName: '平台运营',
  })
})

test('online accounts refuse to start on SQLite', async () => {
  const previousVitest = process.env.VITEST
  delete process.env.VITEST
  try {
    assert.throws(
      () => new AccountService(new Context(), { sqlitePath: join(dir, 'biu.sqlite') }),
      /online SQLite is no longer supported/,
    )
  } finally {
    process.env.VITEST = previousVitest
  }
})
