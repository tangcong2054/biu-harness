import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { Context, Service } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import { DatabaseService } from './index.ts'

/**
 * MySQL 控制面下的列表/读取可见性必须算上授权：
 * 回归点：以前只看归属（私人只给 owner），邀请协作（记录授权、视图授权）在列表和打开记录时都不生效。
 */

type Policy = { ownership: string; accessMode: string; parentCollection: string; parentRecordId: string; ownerAccountId?: string }
type Grants = {
  records: Record<string, string>
  views: Array<{ viewId: string; grantedBy: string; role: string }>
  savedViews: Array<{ id: string; filters?: Record<string, unknown>; filterTree?: unknown }>
}

function boot() {
  const ctx = new Context()
  const state = { revision: 0, grantCalls: 0 }
  const policies: Record<string, Policy> = {
    p_x1: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
    p_x2: { ownership: 'personal', accessMode: 'restricted', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
    p_y: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
    p_child: { ownership: 'personal', accessMode: 'inherit', parentCollection: '/pages', parentRecordId: 'p_y', ownerAccountId: 'ada' },
    p_team: { ownership: 'workspace', accessMode: 'members', parentCollection: '', parentRecordId: '', ownerAccountId: 'ada' },
  }
  const grantsByAccount: Record<string, Grants> = {}
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership(accountId: string, workspaceId: string) {
        return workspaceId === 'ws_a' && ['ada', 'bob', 'carol'].includes(accountId)
          ? { role: 'member', memberKind: 'member' }
          : null
      },
      async collectionScopeSources(workspaceId: string, collection: string) {
        if (workspaceId !== 'ws_a' || collection !== '/pages') return { policies: {}, owners: [] }
        return { policies: { ...policies }, owners: Object.keys(policies) }
      },
      async collectionGrantSources(accountId: string, workspaceId: string, collection: string): Promise<Grants> {
        state.grantCalls += 1
        if (workspaceId !== 'ws_a' || collection !== '/pages') return { records: {}, views: [], savedViews: [] }
        return grantsByAccount[accountId] ?? { records: {}, views: [], savedViews: [] }
      },
      async authzRevision() {
        return state.revision
      },
      async authzWorkspaceRevision() {
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
    { id: 'p_x1', title: 'X 一', project: 'X' },
    { id: 'p_x2', title: 'X 二', project: 'X' },
    { id: 'p_y', title: 'Y 页', project: 'Y' },
    { id: 'p_child', title: 'Y 子页', project: 'Y' },
    { id: 'p_team', title: '团队页', project: 'T' },
  ]
  db.register({
    id: 'pages',
    path: '/pages',
    label: '页面',
    schema: {
      labelField: 'title',
      fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string' }, project: { type: 'string' } },
    },
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id) ?? null,
  })
  const as = <T,>(accountId: string, fn: () => T) => runWithAccount(accountId, () => runWithRequestWorkspace('ws_a', fn))
  const ids = async (accountId: string) =>
    (await as(accountId, () => db.list('/pages'))).items.map((row) => String(row.id)).sort()
  const canRead = async (accountId: string, id: string) =>
    as(accountId, () => db.read(`/pages/${id}`)).then(() => true, () => false)
  const allows = async (accountId: string, id: string, action: string) => {
    const spec = (db as unknown as { collection(path: string): unknown }).collection('/pages')
    const record = rows.find((row) => row.id === id)
    const assertLive = (db as unknown as {
      assertLiveRecord(spec: unknown, id: string, action: string, record?: unknown): Promise<void>
    }).assertLiveRecord.bind(db)
    return as(accountId, () => assertLive(spec, id, action, record)).then(() => true, () => false)
  }
  const projectX = { id: 'v_x', filters: { project: 'X' } }
  return { db, as, ids, canRead, allows, grantsByAccount, state, policies, projectX }
}

test('a collaborator invited to a custom view sees and opens the records matching its filter', async () => {
  const { ids, canRead, grantsByAccount, projectX } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'ada', role: 'viewer' }], savedViews: [projectX] }
  assert.deepEqual(await ids('bob'), ['p_team', 'p_x1', 'p_x2'])
  assert.equal(await canRead('bob', 'p_x1'), true)
  assert.equal(await canRead('bob', 'p_y'), false)
})

test('the owner still sees everything and an uninvited member only sees team records', async () => {
  const { ids, grantsByAccount, projectX } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'ada', role: 'viewer' }], savedViews: [projectX] }
  assert.deepEqual(await ids('ada'), ['p_child', 'p_team', 'p_x1', 'p_x2', 'p_y'])
  assert.deepEqual(await ids('carol'), ['p_team'])
  // Bob 的授权结果不能被 Carol 复用，反之亦然。
  assert.deepEqual(await ids('bob'), ['p_team', 'p_x1', 'p_x2'])
  assert.deepEqual(await ids('carol'), ['p_team'])
})

test('a direct record grant makes the record and its inheriting children visible', async () => {
  const { ids, canRead, grantsByAccount } = boot()
  grantsByAccount.bob = { records: { p_y: 'viewer' }, views: [], savedViews: [] }
  assert.deepEqual(await ids('bob'), ['p_child', 'p_team', 'p_y'])
  assert.equal(await canRead('bob', 'p_child'), true)
})

test('the granted role limits what the collaborator may do', async () => {
  const { allows, grantsByAccount, projectX } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'ada', role: 'viewer' }], savedViews: [projectX] }
  grantsByAccount.carol = { records: { p_y: 'editor' }, views: [], savedViews: [] }
  assert.equal(await allows('bob', 'p_x1', 'resource:read'), true)
  assert.equal(await allows('bob', 'p_x1', 'resource:update'), false)
  assert.equal(await allows('bob', 'p_x1', 'resource:delete'), false)
  assert.equal(await allows('carol', 'p_y', 'resource:update'), true)
})

test('a grant on a missing view, an empty view or a malformed filter grants nothing', async () => {
  const { ids, grantsByAccount } = boot()
  grantsByAccount.bob = {
    records: {},
    views: [
      { viewId: 'v_deleted', grantedBy: 'ada', role: 'viewer' },
      { viewId: 'v_bad', grantedBy: 'ada', role: 'viewer' },
    ],
    savedViews: [{ id: 'v_bad', filters: { $tree: 'broken' } }],
  }
  assert.deepEqual(await ids('bob'), ['p_team'])
})

test('the builtin "all" view only grants the records owned by whoever granted it', async () => {
  const { ids, grantsByAccount } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'builtin-all:/pages', grantedBy: 'ada', role: 'viewer' }], savedViews: [] }
  assert.deepEqual(await ids('bob'), ['p_child', 'p_team', 'p_x1', 'p_x2', 'p_y'])
  grantsByAccount.carol = { records: {}, views: [{ viewId: 'builtin-all:/pages', grantedBy: 'bob', role: 'viewer' }], savedViews: [] }
  assert.deepEqual(await ids('carol'), ['p_team'])
})

test('unknown roles are ignored and grants are not queried when everything is already visible', async () => {
  const { ids, grantsByAccount, state, policies } = boot()
  grantsByAccount.bob = { records: { p_y: 'superuser' }, views: [], savedViews: [] }
  assert.deepEqual(await ids('bob'), ['p_team'])
  for (const key of Object.keys(policies)) policies[key] = { ...policies[key]!, ownership: 'workspace', accessMode: 'members' }
  state.revision += 1
  const before = state.grantCalls
  assert.deepEqual(await ids('carol'), ['p_child', 'p_team', 'p_x1', 'p_x2', 'p_y'])
  assert.equal(state.grantCalls, before)
})

test('revoking a grant hides the records again once the authz revision moves', async () => {
  const { ids, grantsByAccount, state, projectX } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'ada', role: 'viewer' }], savedViews: [projectX] }
  assert.deepEqual(await ids('bob'), ['p_team', 'p_x1', 'p_x2'])
  grantsByAccount.bob = { records: {}, views: [], savedViews: [] }
  state.revision += 1
  assert.deepEqual(await ids('bob'), ['p_team'])
})

test('a view filtered by collection membership (facet) grants the records in that collection', async () => {
  const { db, ids, canRead, grantsByAccount } = boot()
  db.facets.upsert({ id: 'cdb', label: 'CDB 实例巡检', fields: [] })
  db.facets.writeRecordFacet('/pages', 'p_x1', { tags: ['cdb'], values: {} }, 'X 一')
  db.facets.writeRecordFacet('/pages', 'p_y', { tags: ['cdb'], values: {} }, 'Y 页')
  // 与线上“汇报”视图相同的结构：filters 为空，条件写在 filterTree 里。
  const report = {
    id: '1791443424667',
    filters: {},
    filterTree: {
      kind: 'group', id: 'g', combinator: 'and',
      children: [{ kind: 'rule', id: 'r', field: 'facet', op: 'eq', value: 'cdb' }],
    },
  }
  grantsByAccount.bob = { records: {}, views: [{ viewId: report.id, grantedBy: 'ada', role: 'viewer' }], savedViews: [report] }
  assert.deepEqual(await ids('bob'), ['p_team', 'p_x1', 'p_y'])
  assert.equal(await canRead('bob', 'p_y'), true)
  assert.equal(await canRead('bob', 'p_x2'), false)
  // 按合集名称筛选同样生效。
  grantsByAccount.carol = {
    records: {},
    views: [{ viewId: 'by-label', grantedBy: 'ada', role: 'viewer' }],
    savedViews: [{
      id: 'by-label',
      filters: { $tree: { kind: 'group', combinator: 'and', children: [{ kind: 'rule', field: 'facet', op: 'eq', value: 'CDB 实例巡检' }] } },
    }],
  }
  assert.deepEqual(await ids('carol'), ['p_team', 'p_x1', 'p_y'])
})

test('a filter tree whose root is a single rule grants nothing instead of everything', async () => {
  const { ids, grantsByAccount } = boot()
  grantsByAccount.bob = {
    records: {},
    views: [{ viewId: 'bare', grantedBy: 'ada', role: 'viewer' }],
    savedViews: [{ id: 'bare', filterTree: { kind: 'rule', field: 'project', op: 'eq', value: 'X' } }],
  }
  assert.deepEqual(await ids('bob'), ['p_team'])
})

test('a view cannot re-share private records its granter cannot see', async () => {
  const { ids, canRead, grantsByAccount, projectX } = boot()
  // Carol 不是这些私人页面的拥有者，她建的视图授权不能把 Ada 的私人页面带给 Bob。
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'carol', role: 'viewer' }], savedViews: [projectX] }
  assert.deepEqual(await ids('bob'), ['p_team'])
  assert.equal(await canRead('bob', 'p_x1'), false)
  // 空间成员都能看到的记录不受影响；授权人缺失时什么都不给。
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: '', role: 'viewer' }], savedViews: [projectX] }
  assert.deepEqual(await ids('bob'), ['p_team'])
})

test('records seen through a grant show and group as shared for the collaborator only', async () => {
  const { as, db, grantsByAccount, projectX } = boot()
  grantsByAccount.bob = { records: {}, views: [{ viewId: 'v_x', grantedBy: 'ada', role: 'viewer' }], savedViews: [projectX] }
  const labels = async (accountId: string, filter?: Record<string, unknown>) => Object.fromEntries(
    (await as(accountId, () => db.list('/pages', filter))).items.map((row) => [row.id, (row as Record<string, unknown>).shareScope]),
  )
  const bob = await labels('bob')
  expect(bob.p_x1).toBe('共享')
  expect(bob.p_team).toBe('空间')
  expect(Object.keys(await labels('bob', { $scope: 'shared' })).sort()).toEqual(['p_x1', 'p_x2'])
  expect(Object.keys(await labels('bob', { $scope: 'personal' }))).toEqual([])
  // 拥有者看到的仍是自己的私人页，不受协作者视角影响。
  const ada = await labels('ada')
  expect(ada.p_x1).toBe('私人')
  expect(await labels('bob')).toEqual(bob)
})
