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
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership(accountId: string, workspaceId: string) {
        return members.has(`${accountId}\t${workspaceId}`) ? { role: 'member', memberKind: 'member' } : null
      },
      async collectionScopeSources(workspaceId: string, collection: string) {
        if (collection !== '/sessions') return { policies: {}, owners: [] }
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
  return { ctx, as, policies, owners }
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
