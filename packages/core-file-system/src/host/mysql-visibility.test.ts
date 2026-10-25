import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import { DatabaseService } from './index.ts'

/**
 * MySQL 控制面下列表会把「当前账号能否看见这条记录」缓存进 mysqlVisible。
 * 回归点：缓存 key 以前不带账号，A 列表时算出的 true 会被 B 的合集读取直接复用，
 * A 的私有页面因此出现在 B 的合集里。
 */

type Policy = { ownership: string; accessMode: string; parentCollection: string; parentRecordId: string; ownerAccountId?: string }

function boot() {
  const ctx = new Context()
  const state = { revision: 0 }
  const policies: Record<string, Policy> = {
    p_ada: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
    p_team: { ownership: 'workspace', accessMode: 'members', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
  }
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership(accountId: string, workspaceId: string) {
        return workspaceId === 'ws_a' && (accountId === 'ada' || accountId === 'bob')
          ? { role: 'member', memberKind: 'member' }
          : null
      },
      async collectionScopeSources(workspaceId: string, collection: string) {
        if (workspaceId !== 'ws_a' || collection !== '/pages') return { policies: {}, owners: [] }
        return { policies: { ...policies }, owners: Object.keys(policies) }
      },
      async authzRevision(_workspaceId: string, _collections: readonly string[]) {
        return state.revision
      },
      async authzWorkspaceRevision(_workspaceId: string) {
        return state.revision
      },
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  new AccountBridge(ctx)
  const db = new DatabaseService(ctx)
  const rows: DbRecord[] = [
    { id: 'p_ada', title: 'Ada 私有页' },
    { id: 'p_team', title: '团队页' },
  ]
  db.register({
    id: 'pages',
    path: '/pages',
    label: '页面',
    schema: { labelField: 'title', fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string' } } },
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id) ?? null,
  })
  const as = <T,>(accountId: string, fn: () => T) => runWithAccount(accountId, () => runWithRequestWorkspace('ws_a', fn))
  return { db, as, policies, state }
}

test('MySQL list cache follows the cloud authz revision written by other instances', async () => {
  const { db, as, policies, state } = boot()
  assert.deepEqual((await as('bob', () => db.list('/pages'))).items.map((row) => row.id), ['p_team'])
  // 另一台实例把 Ada 的私有页改成了团队可见：本实例没有任何本地写入。
  policies.p_ada = { ...policies.p_ada!, ownership: 'workspace', accessMode: 'members' }
  assert.deepEqual((await as('bob', () => db.list('/pages'))).items.map((row) => row.id), ['p_team'])
  state.revision += 1
  assert.deepEqual((await as('bob', () => db.list('/pages'))).items.map((row) => row.id).sort(), ['p_ada', 'p_team'])
})

test('MySQL visibility cache never leaks one account result to another', async () => {
  const { db, as } = boot()
  db.facets.upsert({ id: 'tag', label: 'Tag', fields: [] })
  db.facets.writeRecordFacet('/pages', 'p_ada', { tags: ['tag'], values: {} }, 'Ada 私有页')
  db.facets.writeRecordFacet('/pages', 'p_team', { tags: ['tag'], values: {} }, '团队页')

  // Ada 先列一次，缓存里写入「Ada 能看见 p_ada」。
  const adaList = await as('ada', () => db.list('/pages'))
  assert.deepEqual(adaList.items.map((row) => row.id).sort(), ['p_ada', 'p_team'])

  // Bob 读合集：只能看到团队页。
  const bobFacet = await as('bob', () => db.collectFacet('tag'))
  assert.deepEqual(bobFacet.items.map((item) => item.id), ['p_team'])

  // Bob 列表同样看不到 Ada 的私有页；之后 Ada 仍然能看见自己的。
  const bobList = await as('bob', () => db.list('/pages'))
  assert.deepEqual(bobList.items.map((row) => row.id), ['p_team'])
  const adaFacet = await as('ada', () => db.collectFacet('tag'))
  assert.deepEqual(adaFacet.items.map((item) => item.id).sort(), ['p_ada', 'p_team'])
})
