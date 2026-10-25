import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import * as fs from './index.ts'
import { runWithSession } from '@biu/host-sessions/scope'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'

/**
 * 回归点：同步入口在 AccountService 上看到 tenantForRecord 就直接返回空，
 * 本机 store 的回退永远走不到；没有请求工作区的后台调用把文件写进 `_unassigned`，
 * 同一会话出现两套目录（异步入口能解析出真实工作区）。
 */

let previousOnline: string | undefined
let previousHome: string | undefined
let home = ''

beforeEach(async () => {
  previousOnline = process.env.BIU_ONLINE
  previousHome = process.env.BIU_HOME
  home = await mkdtemp(join(tmpdir(), 'cordis-fs-tenant-'))
  process.env.BIU_ONLINE = '1'
  process.env.BIU_HOME = home
})

afterEach(() => {
  if (previousOnline === undefined) delete process.env.BIU_ONLINE
  else process.env.BIU_ONLINE = previousOnline
  if (previousHome === undefined) delete process.env.BIU_HOME
  else process.env.BIU_HOME = previousHome
})

async function boot(mysql: boolean) {
  const ctx = new Context()
  class Account extends Service {
    usesMysqlAccounts() {
      return mysql
    }
    async tenantForRecord(collection: string, id: string) {
      return collection === '/sessions' && id === 's1' ? { workspaceId: 'ws_cloud', accountId: 'ada' } : null
    }
    // MySQL 控制面下本机镜像为空；SQLite 控制面下本机就是权威。
    store = {
      tenantForRecord: (collection: string, id: string) =>
        !mysql && collection === '/sessions' && id === 's1' ? { workspaceId: 'ws_local' } : null,
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  await ctx.plugin(Account)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  await ctx.plugin(fs, { root: await mkdtemp(join(tmpdir(), 'cordis-fs-root-')) })
  return ctx
}

const sessionDir = (workspace: string) => join(home, '.biu', 'workspaces', `workspace-${workspace}`, 'sessions', 'session-s1')

test('SQLite control plane: background sync callers resolve the owning workspace', async () => {
  const ctx = await boot(false)
  assert.equal(runWithSession('s1', () => ctx.fs.effectiveRoot()), sessionDir('ws_local'))
})

test('MySQL control plane: sync callers reuse the workspace resolved by the async path', async () => {
  const ctx = await boot(true)
  const asyncRoot = await runWithSession('s1', () => ctx.fs.effectiveRootAsync())
  assert.equal(asyncRoot, sessionDir('ws_cloud'))
  // 后台同步调用（没有请求工作区）：必须落到同一目录，不能是 _unassigned。
  assert.equal(runWithSession('s1', () => ctx.fs.effectiveRoot()), sessionDir('ws_cloud'))
})

test('MySQL control plane: a request workspace is remembered for later background calls', async () => {
  const ctx = await boot(true)
  runWithRequestWorkspace('ws_cloud', () => runWithSession('s1', () => ctx.fs.effectiveRoot()))
  assert.equal(runWithSession('s1', () => ctx.fs.effectiveRoot()), sessionDir('ws_cloud'))
})
