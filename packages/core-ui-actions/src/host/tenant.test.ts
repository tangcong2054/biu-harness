import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { UiActionsHostService } from './index.ts'

/**
 * MySQL 控制面下会话 token 与成员关系只在云端。以前租户解析只读同步 store，
 * 拿到空账号后 tenantMatches 永远匹配不到浏览器客户端，UI 动作整体失效；
 * 工作区参数也直接信任了客户端。
 */

function request(cookie: string) {
  return { headers: { cookie } } as unknown as IncomingMessage
}

function boot() {
  const ctx = new Context()
  class MysqlAccount extends Service {
    // 本机镜像是空的：同步方法什么都查不到。
    store = { accountByToken: () => null, isMember: () => false }
    async accountByToken(token: string) {
      return token === 'tok-ada' ? { id: 'ada' } : null
    }
    async isMemberAsync(accountId: string, workspaceId: string) {
      return accountId === 'ada' && workspaceId === 'ws_a'
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  new MysqlAccount(ctx)
  return new UiActionsHostService(ctx)
}

test('UI actions tenant comes from the async account service', async () => {
  const host = boot()
  assert.deepEqual(await host.resolveTenant(request('biu_account=tok-ada'), 'ws_a'), {
    accountId: 'ada',
    workspaceId: 'ws_a',
  })
})

test('UI actions never trusts a workspace the account is not a member of', async () => {
  const host = boot()
  assert.deepEqual(await host.resolveTenant(request('biu_account=tok-ada'), 'ws_other'), {
    accountId: 'ada',
    workspaceId: '',
  })
  // token 无效：没有账号，也就没有成员关系可言。
  assert.deepEqual((await host.resolveTenant(request('biu_account=nope'), 'ws_a')).accountId, '')
})
