import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REQUIRED_RECORD_FIELDS, type CollectionSchema } from '@biu/type-file-system'
import { listGroupedCollection } from './group-list.ts'
import type { ListPage } from './db-client.ts'

const schema: CollectionSchema = {
  labelField: 'title',
  fields: {
    ...REQUIRED_RECORD_FIELDS,
    title: { type: 'string' },
    status: { type: 'select', enum: ['todo', 'doing', 'done'] },
    shareScope: { type: 'select', enum: ['私人', '空间', '共享'] },
  },
}

test('grouped collection fetches each group page instead of a mixed 200', async () => {
  const calls: Array<{ limit: number; offset: number; filters?: Record<string, unknown> }> = []
  const list = async (input: {
    path: string
    limit: number
    offset?: number
    filters?: Record<string, unknown>
  }): Promise<ListPage> => {
    calls.push({ limit: input.limit, offset: input.offset ?? 0, filters: input.filters })
    const status = String(input.filters?.status ?? '')
    if (input.filters?.$tree) return { items: [], total: 0, schema }
    if (status === 'doing') return { items: [{ id: 'd1', title: 'doing-1', status: 'doing' }], total: 41, schema }
    if (status === 'todo') return { items: [], total: 0, schema }
    return { items: [], total: 3, schema }
  }
  const page = await listGroupedCollection({
    path: '/tasks',
    groupBy: 'status',
    schema,
    pageSize: 20,
    groupPages: { doing: 1 },
    list,
  })
  assert.ok(page)
  assert.equal(calls.some((call) => call.limit === 200), false)
  assert.deepEqual(
    calls.map((call) => ({
      status: call.filters?.status,
      empty: Boolean(call.filters?.$tree),
      limit: call.limit,
      offset: call.offset,
    })),
    [
      { status: 'todo', empty: false, limit: 20, offset: 0 },
      { status: 'doing', empty: false, limit: 20, offset: 20 },
      { status: 'done', empty: false, limit: 20, offset: 0 },
      { status: undefined, empty: true, limit: 20, offset: 0 },
    ],
  )
  assert.deepEqual(
    page!.buckets.map((item) => [item.key, item.total, item.rows.map((row) => row.id)]),
    [
      ['doing', 41, ['d1']],
      ['done', 3, []],
    ],
  )
})

test('wrap groups larger than the window only fully fetch the first group', async () => {
  const limits: number[] = []
  await listGroupedCollection({
    path: '/tasks',
    groupBy: 'status',
    schema,
    pageSize: 100,
    wrap: true,
    list: async (input) => {
      limits.push(input.limit)
      return { items: [{ id: String(limits.length), title: 'row' }], total: 80, schema }
    },
  })
  assert.deepEqual(limits, [100, 1, 1, 1])
})

test('scrolled wrap groups can fill later buckets at page size', async () => {
  const limits: Array<{ status?: unknown; limit: number }> = []
  await listGroupedCollection({
    path: '/tasks',
    groupBy: 'status',
    schema,
    pageSize: 100,
    wrap: true,
    fillKeys: ['doing'],
    list: async (input) => {
      limits.push({ status: input.filters?.status, limit: input.limit })
      return { items: [{ id: String(limits.length), title: 'row' }], total: 80, schema }
    },
  })
  assert.deepEqual(limits, [
    { status: 'todo', limit: 100 },
    { status: 'doing', limit: 100 },
    { status: 'done', limit: 1 },
    { status: undefined, limit: 1 },
  ])
})

test('shareScope groups query $scope, not shareScope equality', async () => {
  const scopes: unknown[] = []
  await listGroupedCollection({
    path: '/tasks',
    groupBy: 'shareScope',
    schema,
    pageSize: 20,
    list: async (input) => {
      scopes.push(input.filters?.$scope)
      assert.equal(input.filters?.shareScope, undefined)
      return { items: [{ id: String(input.filters?.$scope), title: String(input.filters?.$scope) }], total: 1, schema }
    },
  })
  assert.deepEqual(scopes, ['personal', 'workspace', 'shared'])
})

test('grouped table fetch no longer uses a mixed 200-row page', () => {
  const browser = readFileSync(resolve(import.meta.dirname, './browser.tsx'), 'utf8')
  assert.doesNotMatch(browser, /groupBy \? 200/)
  assert.match(browser, /listGroupedCollection\(/)
  assert.match(browser, /wrap: wrapCells/)
  assert.match(browser, /fillKeys: groupFillKeys/)
  assert.match(browser, /JSON\.stringify\(groupPages\)/)
  assert.match(browser, /count = group\.total \?\? group\.rows\.length/)
  assert.match(browser, /group\.total != null \? group\.rows/)
})

test('multi-value grouping keeps duplicates in buckets but dedupes the flat item list', async () => {
  const tagSchema: CollectionSchema = {
    labelField: 'title',
    fields: {
      ...REQUIRED_RECORD_FIELDS,
      title: { type: 'string' },
      labels: { type: 'multi-select', enum: ['a', 'b', 'c'] },
    },
  }
  const shared = { id: 'p1', title: 'shared', labels: ['a', 'b', 'c'] }
  const only = { id: 'p2', title: 'only-b', labels: ['b'] }
  const list = async (input: { filters?: Record<string, unknown> }): Promise<ListPage> => {
    const raw = JSON.stringify(input.filters ?? {})
    if (raw.includes('$tree')) return { items: [], total: 0, schema: tagSchema }
    if (!input.filters || raw === '{}') return { items: [shared], total: 2, schema: tagSchema }
    if (raw.includes('"a"')) return { items: [shared], total: 1, schema: tagSchema }
    if (raw.includes('"b"')) return { items: [shared, only], total: 2, schema: tagSchema }
    if (raw.includes('"c"')) return { items: [shared], total: 1, schema: tagSchema }
    return { items: [], total: 0, schema: tagSchema }
  }
  const page = await listGroupedCollection({ path: '/pages', groupBy: 'labels', schema: tagSchema, pageSize: 20, list })
  assert.ok(page)
  assert.deepEqual(
    page!.buckets.map((item) => [item.key, item.rows.map((row) => row.id)]),
    [
      ['a', ['p1']],
      ['b', ['p1', 'p2']],
      ['c', ['p1']],
    ],
  )
  assert.deepEqual(
    page!.items.map((row) => row.id),
    ['p1', 'p2'],
  )
  // 各组 total 相加是 1+2+1=4，真实记录只有 2 条
  assert.equal(page!.total, 2)
})

test('single-value grouping keeps summing bucket totals without an extra request', async () => {
  let calls = 0
  const list = async (input: { filters?: Record<string, unknown> }): Promise<ListPage> => {
    calls += 1
    const status = String(input.filters?.status ?? '')
    if (status === 'todo') return { items: [{ id: 't1', status: 'todo' }], total: 3, schema }
    if (status === 'done') return { items: [{ id: 'x1', status: 'done' }], total: 2, schema }
    return { items: [], total: 0, schema }
  }
  const page = await listGroupedCollection({ path: '/tasks', groupBy: 'status', schema, pageSize: 20, list })
  assert.equal(page!.total, 5)
  assert.equal(calls, 4)
})
