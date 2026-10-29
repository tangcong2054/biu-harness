import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context, Service } from 'cordis'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import { DatabaseService } from './index.ts'

/**
 * 合并上游「新建 MCP 服务器默认归属到工作区」（spec.defaultScope）后，
 * 本分支 Online 的归属写在 MySQL（attachPolicy）。回归点：表声明 defaultScope='workspace' 时，
 * 调用方不给 scope 也要按空间归属写进云端，而不是按个人私有写；显式 scope 仍然优先。
 */

type Attached = { collection: string; recordId: string; ownership: string; accessMode: string; memberDefaultRole?: string }

function boot() {
  const ctx = new Context()
  const attached: Attached[] = []
  class AccountBridge extends Service {
    usesMysqlAccounts() {
      return true
    }
    // 生产里 AccountService 总带着本机 CollabStore；MySQL 控制面下它是空的。
    store = { activeWorkspaceId: () => null }
    mysql = {
      async attachPolicy(input: Attached & { actorId: string; workspaceId: string }) {
        assert.equal(input.actorId, 'ada')
        assert.equal(input.workspaceId, 'ws_a')
        attached.push({
          collection: input.collection,
          recordId: input.recordId,
          ownership: input.ownership,
          accessMode: input.accessMode,
          ...(input.memberDefaultRole ? { memberDefaultRole: input.memberDefaultRole } : {}),
        })
      },
      async membership() {
        return { role: 'member', memberKind: 'member' }
      },
      async collectionScopeSources() {
        return { policies: {}, owners: [] }
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
  const register = (name: string, defaultScope?: 'workspace') => {
    const rows: DbRecord[] = []
    db.register({
      id: name,
      path: `/${name}`,
      label: name,
      records: { create: true },
      ...(defaultScope ? { defaultScope } : {}),
      schema: { labelField: 'title', fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string', writable: true } } },
      list: () => rows,
      get: (id) => rows.find((row) => row.id === id) ?? null,
      create: (inputs) =>
        inputs.map((input, index) => {
          const row = { id: `${name}_${rows.length + index + 1}`, title: String(input.title ?? '') }
          rows.push(row)
          return row
        }),
    })
  }
  register('mcp', 'workspace')
  register('pages')
  const as = <T,>(fn: () => T) => runWithAccount('ada', () => runWithRequestWorkspace('ws_a', fn))
  return { db, as, attached }
}

test('a collection that declares defaultScope=workspace is attached as workspace-owned in MySQL', async () => {
  const { db, as, attached } = boot()
  await as(() => db.create('/mcp', [{ title: 'github' }]))
  assert.deepEqual(attached, [
    { collection: '/mcp', recordId: 'mcp_1', ownership: 'workspace', accessMode: 'members', memberDefaultRole: 'editor' },
  ])
})

test('collections without defaultScope stay personal, and an explicit scope still wins', async () => {
  const { db, as, attached } = boot()
  await as(() => db.create('/pages', [{ title: 'note' }]))
  await as(() => db.create('/mcp', [{ title: 'private-mcp' }], { scope: 'personal' }))
  assert.deepEqual(attached, [
    { collection: '/pages', recordId: 'pages_1', ownership: 'personal', accessMode: 'private' },
    { collection: '/mcp', recordId: 'mcp_1', ownership: 'personal', accessMode: 'private' },
  ])
})
