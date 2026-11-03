import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import * as sessionStore from '@biu/host-session-store'
import * as sessions from './index.ts'

/**
 * Online + MySQL 控制面：成员关系与归属只在云端。
 * 回归点：以前 inWorkspace 读本机 SQLite 空表，actor 解析为 null 后直接 return true，
 * 所有租户的会话都能被列出、按 id 读取。
 */

type Policy = { ownership: string; accessMode: string; parentCollection: string; parentRecordId: string; ownerAccountId?: string }

async function boot() {
  const ctx = new Context()
  await ctx.plugin(sessionStore, { driver: 'memory' })
  await ctx.plugin(sessions)
  const members = new Set(['ada\tws_a', 'bob\tws_a', 'cara\tws_b'])
  const policies: Record<string, Record<string, Policy>> = { ws_a: {}, ws_b: {} }
  const owners: Record<string, Set<string>> = { ws_a: new Set(), ws_b: new Set() }
  const parents: Record<string, Record<string, Policy>> = {}
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership(accountId: string, workspaceId: string) {
        return members.has(`${accountId}\t${workspaceId}`) ? { role: 'member', memberKind: 'member' } : null
      },
      async collectionScopeSources(workspaceId: string, collection: string) {
        if (collection !== '/sessions') return { policies: parents[`${workspaceId}:${collection}`] ?? {}, owners: [] }
        return { policies: { ...(policies[workspaceId] ?? {}) }, owners: [...(owners[workspaceId] ?? [])] }
      },
      async attachPolicy(input: { actorId: string; workspaceId: string; recordId: string; ownership: string; accessMode: string }) {
        policies[input.workspaceId] ??= {}
        owners[input.workspaceId] ??= new Set()
        policies[input.workspaceId]![input.recordId] = {
          ownership: input.ownership,
          accessMode: input.accessMode,
          parentCollection: '',
          parentRecordId: '',
          ownerAccountId: input.actorId,
        }
        owners[input.workspaceId]!.add(input.recordId)
      },
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  await ctx.plugin(AccountBridge)
  const as = <T,>(accountId: string, workspaceId: string, fn: () => T) =>
    runWithAccount(accountId, () => runWithRequestWorkspace(workspaceId, fn))
  return { ctx, as, policies, owners, parents, members }
}

test('MySQL: private sessions are not visible to other members or other workspaces', async () => {
  const { ctx, as } = await boot()
  const adaSession = await as('ada', 'ws_a', () => ctx.sessions.create('ada-private'))
  const caraSession = await as('cara', 'ws_b', () => ctx.sessions.create('cara-private'))

  const adaList = await as('ada', 'ws_a', () => ctx.sessions.listSummaries())
  const bobList = await as('bob', 'ws_a', () => ctx.sessions.listSummaries())
  const caraList = await as('cara', 'ws_b', () => ctx.sessions.listSummaries())
  assert.deepEqual(adaList.map((item) => item.id), [adaSession.id])
  assert.deepEqual(bobList.map((item) => item.id), [])
  assert.deepEqual(caraList.map((item) => item.id), [caraSession.id])

  assert.equal(await as('ada', 'ws_a', () => ctx.sessions.inWorkspaceAsync(adaSession.id)), true)
  assert.equal(await as('bob', 'ws_a', () => ctx.sessions.inWorkspaceAsync(adaSession.id)), false)
  assert.equal(await as('cara', 'ws_b', () => ctx.sessions.inWorkspaceAsync(adaSession.id)), false)
  // 冒充别的空间：不是成员，什么都拿不到。
  assert.equal(await as('cara', 'ws_a', () => ctx.sessions.inWorkspaceAsync(adaSession.id)), false)
  assert.deepEqual((await as('cara', 'ws_a', () => ctx.sessions.listSummaries())).map((item) => item.id), [])
})

test('MySQL: workspace-shared sessions are visible to every member', async () => {
  const { ctx, as, policies } = await boot()
  const shared = await as('ada', 'ws_a', () => ctx.sessions.create('ada-shared'))
  policies.ws_a![shared.id] = { ...policies.ws_a![shared.id]!, ownership: 'workspace', accessMode: 'members' }
  assert.equal(await as('bob', 'ws_a', () => ctx.sessions.inWorkspaceAsync(shared.id)), true)
  assert.deepEqual((await as('bob', 'ws_a', () => ctx.sessions.listSummaries())).map((item) => item.id), [shared.id])
})

test('MySQL: sessions without cloud ownership and calls without context fail closed', async () => {
  const { ctx, as, policies, owners } = await boot()
  const legacy = await as('ada', 'ws_a', () => ctx.sessions.create('legacy'))
  delete policies.ws_a![legacy.id]
  owners.ws_a!.delete(legacy.id)
  assert.equal(await as('ada', 'ws_a', () => ctx.sessions.inWorkspaceAsync(legacy.id)), false)
  // 没有账号 / 工作区上下文：不能因为解析不到 actor 就全部放行。
  assert.equal(await ctx.sessions.inWorkspaceAsync(legacy.id), false)
  assert.deepEqual((await ctx.sessions.listSummaries()).map((item) => item.id), [])
  // 同步入口在 MySQL 下不再读本机空表放行。
  assert.equal(as('ada', 'ws_a', () => ctx.sessions.inWorkspace(legacy.id)), false)
})

test('scope pushdown is equivalent across identities, ownership, inheritance, view grants and revocation', async () => {
  const originalFlag = process.env.BIU_SESSION_SCOPE_PUSHDOWN
  const { ctx, as, policies, owners, parents, members } = await boot()
  const list = (account: string, workspace: string, enabled: boolean) => {
    process.env.BIU_SESSION_SCOPE_PUSHDOWN = enabled ? '1' : '0'
    return as(account, workspace, () => ctx.sessions.listSummaries())
  }
  const compare = async () => {
    for (const [account, workspace] of [['ada', 'ws_a'], ['bob', 'ws_a'], ['cara', 'ws_b'], ['cara', 'ws_a'], ['', ''], ['ada', 'ws_a']]) {
      const before = await list(account, workspace, false)
      const after = await list(account, workspace, true)
      assert.deepEqual(after, before)
    }
  }
  try {
    const own = await as('ada', 'ws_a', () => ctx.sessions.create('private'))
    const shared = await as('ada', 'ws_a', () => ctx.sessions.create('shared'))
    policies.ws_a[shared.id].accessMode = 'members'
    policies.ws_a[shared.id].ownership = 'workspace'
    const policyOnly = await as('ada', 'ws_a', () => ctx.sessions.create('policy-only'))
    owners.ws_a.delete(policyOnly.id)
    const ownerOnly = await as('ada', 'ws_a', () => ctx.sessions.create('owner-only'))
    delete policies.ws_a[ownerOnly.id]
    const other = await as('cara', 'ws_b', () => ctx.sessions.create('other-workspace'))
    const inherited = await as('ada', 'ws_a', () => ctx.sessions.create('inherited'))
    policies.ws_a[inherited.id] = { ownership: 'workspace', accessMode: 'inherit', parentCollection: '/pages', parentRecordId: 'parent', ownerAccountId: 'bob' }
    parents['ws_a:/pages'] = { parent: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' } }
    await compare()
    const bob = await list('bob', 'ws_a', true)
    assert.ok(bob.some(s => s.id === shared.id))
    assert.ok(!bob.some(s => s.id === own.id || s.id === policyOnly.id || s.id === inherited.id || s.id === other.id))
    const originalView = ctx.sessions.viewAccess
    ctx.sessions.viewAccess = (id, row) => id === other.id && row?.id === other.id
    await compare()
    assert.ok((await list('ada', 'ws_a', true)).some(s => s.id === other.id))
    ctx.sessions.viewAccess = originalView
    members.delete('bob\tws_a')
    parents['ws_a:/pages'].parent.ownerAccountId = 'cara'
    delete policies.ws_a[shared.id]
    owners.ws_a.delete(shared.id)
    await compare()
    assert.deepEqual(await list('bob', 'ws_a', true), [])
    const delegate = ctx.sessionStore.listSummaries.bind(ctx.sessionStore)
    let requested: readonly string[] | undefined
    ctx.sessionStore.listSummaries = async options => { requested = options?.sessionIds; return delegate(options) }
    await list('ada', 'ws_a', true)
    assert.ok(requested?.includes(own.id))
    assert.ok(!requested?.includes(other.id))
    await list('cara', 'ws_a', true)
    assert.deepEqual(requested, [])
  } finally {
    if (originalFlag === undefined) delete process.env.BIU_SESSION_SCOPE_PUSHDOWN
    else process.env.BIU_SESSION_SCOPE_PUSHDOWN = originalFlag
  }
})

test('MySQL: reading a session does not write ownership into the local replica', async () => {
  const { ctx, as } = await boot()
  const attachCalls: string[] = []
  const account = ctx.get('account') as unknown as { store?: unknown }
  // 线上账号服务总带着本机副本；以前每次读会话都会往里写一次归属，副本里空间不存在时直接抛错。
  account.store = {
    activeWorkspaceId: () => 'ws_stale',
    attach: (_ws: string, _collection: string, id: string) => {
      attachCalls.push(id)
      throw new Error('工作区不存在')
    },
  }
  const created = await as('ada', 'ws_a', () => ctx.sessions.create('ada'))
  assert.ok(await as('ada', 'ws_a', () => ctx.sessions.get(created.id)))
  assert.ok(await as('ada', 'ws_a', () => ctx.sessions.get(created.id)))
  assert.deepEqual(attachCalls, [])
})

test('MySQL: shared sessions are decided by MySQL grants, not the local view-grant hook', async () => {
  const { ctx, as } = await boot()
  const shared = await as('ada', 'ws_a', () => ctx.sessions.create('ada-private'))
  const granted = new Set<string>()
  const hookCalls: string[] = []
  ctx.sessions.viewAccess = Object.assign((id: string) => { hookCalls.push(id); return true }, { mayAllow: () => true })
  ctx.sessions.mysqlGrants = {
    readable: async (items) => new Set(items.map((item) => item.id).filter((id) => granted.has(id))),
    mayGrant: async () => granted.size > 0,
  }
  assert.equal(await as('bob', 'ws_a', () => ctx.sessions.inWorkspaceAsync(shared.id)), false)
  assert.deepEqual((await as('bob', 'ws_a', () => ctx.sessions.listSummaries())).map((item) => item.id), [])
  granted.add(shared.id)
  assert.equal(await as('bob', 'ws_a', () => ctx.sessions.inWorkspaceAsync(shared.id)), true)
  const previous = process.env.BIU_SESSION_SCOPE_PUSHDOWN
  process.env.BIU_SESSION_SCOPE_PUSHDOWN = '1'
  try {
    assert.deepEqual((await as('bob', 'ws_a', () => ctx.sessions.listSummaries())).map((item) => item.id), [shared.id])
  } finally {
    if (previous === undefined) delete process.env.BIU_SESSION_SCOPE_PUSHDOWN
    else process.env.BIU_SESSION_SCOPE_PUSHDOWN = previous
  }
  // 本地副本里的视图授权（可能早已在 MySQL 撤销）不再参与判断。
  assert.deepEqual(hookCalls, [])
})
