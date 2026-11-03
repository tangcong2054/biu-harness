import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import { DatabaseService } from './index.ts'

/**
 * MySQL 控制面下有登录账号时，权限只按 MySQL 判断，不再回退到本地 SQLite 副本。
 * 回归点（线上那份副本是过期的，新账号在里面根本没有成员关系，旧逻辑会直接跳过检查）：
 *  - 新建记录不看空间角色：查看者、外部协作者也能新建；
 *  - 单条编辑、批量删除只看“看得见”，不看角色：普通成员能改、能删成员默认“阅读”的页面；
 *  - MySQL 里没有归属的记录回退到副本，等于对所有人开放；
 *  - 回收站不过滤；
 *  - 插件主人按副本判断，同空间成员能拿到别人插件的主人。
 */

type Policy = {
  ownership: string; accessMode: string; parentCollection: string; parentRecordId: string
  ownerAccountId?: string; memberDefaultRole?: string
}

function boot() {
  const ctx = new Context()
  const policies: Record<string, Policy> = {
    p_mine: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
    p_team: { ownership: 'workspace', accessMode: 'members', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada', memberDefaultRole: 'editor' },
    p_shared: { ownership: 'shared', accessMode: 'members', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada', memberDefaultRole: 'viewer' },
  }
  const legacy: Record<string, string> = {}
  const members: Record<string, { role: string; memberKind: string }> = {
    ada: { role: 'owner', memberKind: 'member' },
    bob: { role: 'member', memberKind: 'member' },
    vic: { role: 'viewer', memberKind: 'member' },
    eve: { role: 'member', memberKind: 'external' },
  }
  const grants: Record<string, Record<string, string>> = {}
  const attached: Array<{ actorId: string; recordId: string }> = []
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership(accountId: string, workspaceId: string) {
        return workspaceId === 'ws_a' ? members[accountId] ?? null : null
      },
      async collectionScopeSources(workspaceId: string, collection: string) {
        if (workspaceId !== 'ws_a' || collection !== '/pages') return { policies: {}, owners: [] }
        return { policies: { ...policies }, owners: [...Object.keys(policies), ...Object.keys(legacy)], legacyOwners: { ...legacy } }
      },
      async collectionGrantSources(accountId: string, workspaceId: string, collection: string) {
        if (workspaceId !== 'ws_a' || collection !== '/pages') return { records: {}, views: [], savedViews: [] }
        return { records: { ...grants[accountId] }, views: [], savedViews: [] }
      },
      async attachPolicy(input: { actorId: string; recordId: string }) {
        attached.push({ actorId: input.actorId, recordId: input.recordId })
      },
      async recordOwnerships(collection: string, recordId: string) {
        if (collection !== '/plugins') return []
        return recordId === 'p-ada' ? [{ workspaceId: 'ws_a', ownerId: 'ada' }]
          : recordId === 'p-other' ? [{ workspaceId: 'ws_b', ownerId: 'zed' }]
            : []
      },
      async authzRevision() {
        return 0
      },
      async authzWorkspaceRevision() {
        return 0
      },
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  new AccountBridge(ctx)
  const db = new DatabaseService(ctx)
  const rows: DbRecord[] = [
    { id: 'p_mine', title: 'Ada 私人' },
    { id: 'p_team', title: '空间可编辑' },
    { id: 'p_shared', title: '空间只读' },
    { id: 'p_orphan', title: '没有归属' },
    { id: 'p_legacy', title: '旧记录' },
  ]
  db.register({
    id: 'pages',
    path: '/pages',
    label: '页面',
    records: { create: true },
    schema: {
      labelField: 'title',
      parentField: 'parentId',
      fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string', writable: true } },
    },
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id) ?? null,
    create: (inputs) => inputs.map((input, index) => {
      const row = { id: `p_new${rows.length + index}`, title: String(input.title ?? ''), parentId: String(input.parentId ?? '') }
      rows.push(row)
      return row
    }),
  })
  const as = <T,>(accountId: string, fn: () => T) => runWithAccount(accountId, () => runWithRequestWorkspace('ws_a', fn))
  const internal = db as unknown as {
    collection(path: string): unknown
    assertLiveRecord(spec: unknown, id: string, action: string, record?: unknown): Promise<void>
    loadMysqlScopes(collection: string, rows: DbRecord[]): Promise<boolean>
    visibleRecords(collection: string, rows: DbRecord[], action?: string): DbRecord[]
    pluginOwnership(recordId: string): Promise<{ here: string; elsewhere: boolean }>
  }
  const allows = (accountId: string, id: string, action: string) =>
    as(accountId, () => internal.assertLiveRecord(internal.collection('/pages'), id, action, rows.find((row) => row.id === id)))
      .then(() => true, () => false)
  const bulk = (accountId: string, action: string) => as(accountId, async () => {
    await internal.loadMysqlScopes('/pages', rows)
    return internal.visibleRecords('/pages', rows, action).map((row) => String(row.id)).sort()
  })
  const ids = async (accountId: string) =>
    (await as(accountId, () => db.list('/pages'))).items.map((row) => String(row.id)).sort()
  const creates = (accountId: string, input: Record<string, unknown> = { title: 'new' }) =>
    as(accountId, () => db.create('/pages', [input])).then(() => true, () => false)
  return { db, as, rows, policies, legacy, members, grants, attached, internal, allows, bulk, ids, creates }
}

test('creating records follows the MySQL workspace role, not the local replica', async () => {
  const { creates } = boot()
  assert.equal(await creates('bob'), true)
  assert.equal(await creates('ada'), true)
  assert.equal(await creates('vic'), false)
  assert.equal(await creates('eve'), false)
  assert.equal(await creates('nobody'), false)
})

test('creating a child requires edit access to the parent record', async () => {
  const { creates } = boot()
  assert.equal(await creates('bob', { title: 'child', parentId: 'p_team' }), true)
  assert.equal(await creates('bob', { title: 'child', parentId: 'p_shared' }), false)
  assert.equal(await creates('bob', { title: 'child', parentId: 'p_mine' }), false)
  assert.equal(await creates('ada', { title: 'child', parentId: 'p_mine' }), true)
})

test('single-record writes check the role, not just visibility', async () => {
  const { allows, grants } = boot()
  // 成员默认可编辑：能改不能删（删除要“管理”）。
  assert.equal(await allows('bob', 'p_team', 'resource:update'), true)
  assert.equal(await allows('bob', 'p_team', 'resource:delete'), false)
  // 成员默认只读：能看不能改。
  assert.equal(await allows('bob', 'p_shared', 'resource:read'), true)
  assert.equal(await allows('bob', 'p_shared', 'resource:update'), false)
  // 空间查看者即使拿到编辑授权也只能阅读。
  grants.vic = { p_team: 'editor' }
  assert.equal(await allows('vic', 'p_team', 'resource:read'), true)
  assert.equal(await allows('vic', 'p_team', 'resource:update'), false)
  // 创建者和空间管理者。
  assert.equal(await allows('ada', 'p_shared', 'resource:delete'), true)
  // 编辑授权能改别人的私人页面，阅读授权不能。
  grants.bob = { p_mine: 'editor' }
  assert.equal(await allows('bob', 'p_mine', 'resource:update'), true)
  grants.bob = { p_mine: 'viewer' }
  assert.equal(await allows('bob', 'p_mine', 'resource:update'), false)
})

test('bulk delete and restore only keep rows the caller may manage', async () => {
  const { bulk } = boot()
  assert.deepEqual(await bulk('bob', 'resource:delete'), [])
  assert.deepEqual(await bulk('bob', 'resource:restore'), [])
  assert.deepEqual(await bulk('ada', 'resource:delete'), ['p_mine', 'p_shared', 'p_team'])
})

test('records without any MySQL ownership are not open to everyone', async () => {
  const { ids, allows, legacy } = boot()
  assert.deepEqual(await ids('bob'), ['p_shared', 'p_team'])
  assert.equal(await allows('bob', 'p_orphan', 'resource:read'), false)
  // 只有旧 record_owners 的记录：内部成员按空间角色，外部成员不给。
  legacy.p_legacy = 'ada'
  assert.equal(await allows('bob', 'p_legacy', 'resource:read'), true)
  assert.equal(await allows('bob', 'p_legacy', 'resource:update'), true)
  assert.equal(await allows('bob', 'p_legacy', 'resource:delete'), false)
  assert.equal(await allows('vic', 'p_legacy', 'resource:update'), false)
  assert.equal(await allows('eve', 'p_legacy', 'resource:read'), false)
  assert.equal(await allows('ada', 'p_legacy', 'resource:delete'), true)
  assert.equal(await allows('nobody', 'p_team', 'resource:read'), false)
})

test('the trash only lists what the caller can read in MySQL', async () => {
  const { db, as } = boot()
  for (const id of ['p_mine', 'p_team', 'p_orphan']) db.facets.markDeleted('/pages', id)
  const trash = async (accountId: string) =>
    (await as(accountId, () => db.listTrash())).items.map((item) => item.id).sort()
  assert.deepEqual(await trash('bob'), ['p_team'])
  assert.deepEqual(await trash('ada'), ['p_mine', 'p_team'])
  assert.deepEqual(await trash('nobody'), [])
})

test('plugin ownership is read from MySQL, so another member cannot become the owner', async () => {
  const { as, internal } = boot()
  assert.deepEqual(await as('bob', () => internal.pluginOwnership('p-ada')), { here: 'ada', elsewhere: false })
  assert.deepEqual(await as('bob', () => internal.pluginOwnership('p-other')), { here: '', elsewhere: true })
  assert.deepEqual(await as('bob', () => internal.pluginOwnership('p-new')), { here: '', elsewhere: false })
})
