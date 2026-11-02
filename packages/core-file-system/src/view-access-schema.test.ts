import { describe, expect, it } from 'vitest'
import { REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import { effectiveDataScope, recordMatchesGrantedView, viewRowFilters } from './view-access.ts'

const schema = { labelField: 'title', fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string' as const } } }
const packs = [{ id: 'cdb', label: 'CDB 实例巡检', fields: [] }]
const record = { id: 'p1', title: 'P1', facet: { tags: ['cdb'], values: {} } }
const other = { id: 'p2', title: 'P2', facet: { tags: ['other'], values: {} } }
const tree = JSON.stringify({ kind: 'group', combinator: 'and', children: [{ kind: 'rule', field: 'facet', op: 'eq', value: 'cdb' }] })

describe('view grant matching uses the collection schema', () => {
  it('parses view rows with both flat filters and a filter tree', () => {
    expect(viewRowFilters('{}', tree)).toEqual({ $tree: JSON.parse(tree) })
    expect(viewRowFilters('{"project":"X"}', '')).toEqual({ project: 'X' })
    expect(viewRowFilters('broken', '')).toBeUndefined()
    // 顶层不是规则组的树不合并：列表匹配器会把它当成“无条件”。
    expect(viewRowFilters('{}', JSON.stringify({ kind: 'rule', field: 'facet', op: 'eq', value: 'cdb' }))).toEqual({})
  })

  it('matches a facet filter by id or label only when the schema is given', () => {
    const views = [{ id: 'v', filters: viewRowFilters('{}', tree) }]
    const owner = { grantedBy: 'ada', recordOwnerId: 'ada' }
    expect(recordMatchesGrantedView(record, 'v', views, 'personal', owner, schema, packs)).toBe(true)
    expect(recordMatchesGrantedView(other, 'v', views, 'personal', owner, schema, packs)).toBe(false)
    const byLabel = [{ id: 'v', filters: { $tree: { kind: 'group', combinator: 'and', children: [{ kind: 'rule', field: 'facet', op: 'eq', value: 'CDB 实例巡检' }] } } }]
    expect(recordMatchesGrantedView(record, 'v', byLabel, 'personal', owner, schema, packs)).toBe(true)
    // 没有表结构时合集字段按文本比较，匹配不上（以前的缺陷）。
    expect(recordMatchesGrantedView(record, 'v', views, 'personal', owner)).toBe(false)
  })

  it('computes the effective data scope with the same schema', () => {
    const views = [{ id: 'v', filters: viewRowFilters('{}', tree) }]
    const grants = [{ viewId: 'v', subjectType: 'account' as const, subjectId: 'bob', memberKind: 'member', grantedBy: 'ada' }]
    expect(effectiveDataScope('personal', record, grants, views, [], 'ada', schema, packs)).toBe('workspace')
    expect(effectiveDataScope('personal', other, grants, views, [], 'ada', schema, packs)).toBe('personal')
  })
})
