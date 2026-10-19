import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mysqlRecordVisible, resolveRecordScope, type ScopeSource } from './record-scope.ts'

function source(policies: ScopeSource['policies'], owners: string[] = []): ScopeSource {
  return { policies, owners: new Set(owners) }
}

test('有策略时按私人、空间、共享各归一类', () => {
  const sources = new Map<string, ScopeSource>([
    ['/pages', source({
      mine: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '' },
      room: { ownership: 'workspace', accessMode: 'restricted', parentCollection: '', parentRecordId: '' },
      open: { ownership: 'personal', accessMode: 'members', parentCollection: '', parentRecordId: '' },
      link: { ownership: 'shared', accessMode: 'private', parentCollection: '', parentRecordId: '' },
    })],
  ])
  assert.equal(resolveRecordScope('/pages', 'mine', sources), 'personal')
  assert.equal(resolveRecordScope('/pages', 'room', sources), 'workspace')
  assert.equal(resolveRecordScope('/pages', 'open', sources), 'workspace')
  assert.equal(resolveRecordScope('/pages', 'link', sources), 'shared')
})

test('没有策略但已归属工作区时归入空间', () => {
  const sources = new Map<string, ScopeSource>([['/skills', source({}, ['whoami'])]])
  assert.equal(resolveRecordScope('/skills', 'whoami', sources), 'workspace')
  assert.equal(resolveRecordScope('/skills', 'missing', sources), null)
})

test('继承父记录的分类', () => {
  const sources = new Map<string, ScopeSource>([
    ['/pages', source({
      child: { ownership: 'personal', accessMode: 'inherit', parentCollection: '/pages', parentRecordId: 'parent' },
      parent: { ownership: 'shared', accessMode: 'private', parentCollection: '', parentRecordId: '' },
    })],
  ])
  assert.equal(resolveRecordScope('/pages', 'child', sources), 'shared')
})

test('私人或受限页面只给创建者，空间页面给成员', () => {
  const sources = new Map<string, ScopeSource>([
    ['/pages', source({
      mine: { ownership: 'personal', accessMode: 'private', parentCollection: '', parentRecordId: '', ownerAccountId: 'acc_me' },
      room: { ownership: 'workspace', accessMode: 'members', parentCollection: '', parentRecordId: '', ownerAccountId: 'acc_other' },
      locked: { ownership: 'workspace', accessMode: 'restricted', parentCollection: '', parentRecordId: '', ownerAccountId: 'acc_other' },
      child: { ownership: 'personal', accessMode: 'inherit', parentCollection: '/pages', parentRecordId: 'mine', ownerAccountId: 'acc_other' },
    })],
  ])
  assert.equal(mysqlRecordVisible('/pages', 'mine', sources, 'acc_me'), true)
  assert.equal(mysqlRecordVisible('/pages', 'mine', sources, 'acc_other'), false)
  assert.equal(mysqlRecordVisible('/pages', 'room', sources, 'acc_other'), true)
  assert.equal(mysqlRecordVisible('/pages', 'room', sources, 'acc_me'), true)
  assert.equal(mysqlRecordVisible('/pages', 'locked', sources, 'acc_other'), true)
  assert.equal(mysqlRecordVisible('/pages', 'locked', sources, 'acc_me'), false)
  assert.equal(mysqlRecordVisible('/pages', 'child', sources, 'acc_me'), true)
  assert.equal(mysqlRecordVisible('/pages', 'child', sources, 'acc_other'), false)
  assert.equal(mysqlRecordVisible('/pages', 'missing', sources, 'acc_me'), true)
})
