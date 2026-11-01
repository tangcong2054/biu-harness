import { expect, test } from 'vitest'
import { accessMemberViewMatches, accessRecordViewMatches } from './access-matchers.ts'
import { builtinScopeViewId } from '../catalog-views.ts'

const tree = { kind: 'group', combinator: 'and', children: [{ kind: 'rule', field: 'status', op: 'eq', value: 'done' }] }

test('record access matches filterTree and rejects missing views', () => {
  const views = [{ id: 'done', filterTree: tree }]
  expect(accessRecordViewMatches('done', { id: 'p', status: 'done' }, views, 'personal', 'ada', 'ada')).toBe(true)
  expect(accessRecordViewMatches('done', { id: 'p', status: 'todo' }, views, 'personal', 'ada', 'ada')).toBe(false)
  expect(accessRecordViewMatches('missing', { id: 'p' }, views, 'personal', 'ada', 'ada')).toBe(false)
  expect(accessRecordViewMatches(builtinScopeViewId('personal', 'missing'), { id: 'p' }, views, 'personal', 'ada', 'ada')).toBe(false)
})

test('scoped all-view grants remain confined to the grantor records', () => {
  const views = [{ id: 'builtin-all:/pages' }]
  const id = builtinScopeViewId('personal', 'builtin-all:/pages')
  expect(accessRecordViewMatches(id, { id: 'p' }, views, 'personal', 'ada', 'ada')).toBe(true)
  expect(accessRecordViewMatches(id, { id: 'p' }, views, 'personal', 'bob', 'ada')).toBe(false)
  expect(accessRecordViewMatches(id, { id: 'p' }, views, 'workspace', 'ada', 'ada')).toBe(false)
})

test('member view predicates are evaluated against the actual member', () => {
  const views = [{ id: 'editors', filters: { role: 'member' } }]
  expect(accessMemberViewMatches('editors', { id: 'bob', role: 'member' }, views)).toBe(true)
  expect(accessMemberViewMatches('editors', { id: 'bob', role: 'viewer' }, views)).toBe(false)
  expect(accessMemberViewMatches('missing', { id: 'bob' }, views)).toBe(false)
})

test('malformed filters never degrade into an unfiltered authorization', () => {
  for (const filterTree of ['broken', { unexpected: true }, { kind: 'group', combinator: 'and', children: [{ kind: 'rule', field: 'status', op: 'bad', value: 'done' }] }]) {
    const views = [{ id: 'bad', filterTree }]
    expect(accessMemberViewMatches('bad', { id: 'bob' }, views)).toBe(false)
    expect(accessRecordViewMatches('bad', { id: 'p' }, views, 'personal', 'ada', 'ada')).toBe(false)
    expect(accessRecordViewMatches(builtinScopeViewId('personal', 'bad'), { id: 'p' }, views, 'personal', 'ada', 'ada')).toBe(false)
  }
  expect(accessRecordViewMatches('all', { id: 'p' }, [{ id: 'all', filters: {} }], 'personal', 'ada', 'ada')).toBe(true)
})
