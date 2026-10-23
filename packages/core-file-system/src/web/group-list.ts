import type { CollectionSchema, DbRecord } from '@biu/type-file-system'
import type { SortRule } from '../query-logic.ts'
import type { ListPage } from './db-client.ts'
import {
  groupField,
  groupListFilter,
  groupListKeys,
  mergeListFilters,
  resolveFieldType,
  type GroupBucket,
} from './fields.ts'
import { groupedFullFetchCount } from './table-window.ts'

const MULTI_VALUED = new Set<string>(['multi-select', 'facet'])

export type GroupedCollectionPage = {
  buckets: GroupBucket[]
  items: Array<DbRecord & { path?: string }>
  total: number
  schema?: CollectionSchema
}

/** 分组视图：每个组按自己的页码拉一页，不再混拉一大页再客户端切。 */
export async function listGroupedCollection(opts: {
  path: string
  groupBy: string
  schema?: CollectionSchema
  extraValues?: string[]
  pageSize: number
  groupPages?: Record<string, number>
  wrap?: boolean
  fillKeys?: string[]
  query?: string
  sortField?: string
  sortDir?: string
  sorts?: SortRule[]
  filters?: Record<string, unknown>
  columns?: string[]
  list: (input: {
    path: string
    limit: number
    offset?: number
    query?: string
    sortField?: string
    sortDir?: string
    sorts?: SortRule[]
    filters?: Record<string, unknown>
    columns?: string[]
  }) => Promise<ListPage>
}): Promise<GroupedCollectionPage | null> {
  const keys = groupListKeys(opts.schema, opts.groupBy, opts.extraValues)
  if (!keys.length) return null
  const pageSize = Math.max(1, opts.pageSize)
  const fullCount = groupedFullFetchCount(pageSize, keys.length, opts.wrap)
  const filled = new Set(opts.fillKeys ?? [])
  // 标签 / 多选：一条记录可落在多个组，各组 total 相加会重复计数；另取一次不分组的总数（只要 1 行）。
  const group = groupField(opts.schema, opts.groupBy)
  const multiValued = group ? MULTI_VALUED.has(resolveFieldType(group.field)) : false
  const distinctTotal = multiValued
    ? opts
        .list({
          path: opts.path,
          limit: 1,
          offset: 0,
          query: opts.query,
          sortField: opts.sortField,
          sortDir: opts.sortDir,
          sorts: opts.sorts,
          filters: opts.filters,
          columns: opts.columns,
        })
        .then((page) => page.total)
        .catch(() => undefined)
    : Promise.resolve(undefined)
  const pages = await Promise.all(
    keys.map(async (item, index) => {
      const filters = mergeListFilters(opts.filters ?? {}, groupListFilter(opts.groupBy, item.key))
      if (!filters) return { ...item, rows: [] as DbRecord[], total: 0, schema: undefined as CollectionSchema | undefined }
      const pageIndex = Math.max(0, opts.groupPages?.[item.key || 'unset'] ?? 0)
      const full = index < fullCount || filled.has(item.key) || filled.has(item.key || 'unset')
      const listed = await opts.list({
        path: opts.path,
        limit: full ? pageSize : 1,
        offset: pageIndex * pageSize,
        query: opts.query,
        sortField: opts.sortField,
        sortDir: opts.sortDir,
        sorts: opts.sorts,
        filters,
        columns: opts.columns,
      })
      return { ...item, rows: listed.items, total: listed.total, schema: listed.schema }
    }),
  )
  const buckets = pages
    .map(({ key, label, rows, total }) => ({ key, label, rows, total }))
    .filter((item) => item.total > 0)
  // 多值字段（标签 / 多选）分组时同一条记录会出现在多个组里；buckets 保留重复用于分组展示，
  // items 是整张表的记录集，必须按 id 去重，否则切回不分组时会出现同一行多次、React key 冲突。
  const seen = new Set<string>()
  const items: Array<DbRecord & { path?: string }> = []
  for (const row of buckets.flatMap((item) => item.rows) as Array<DbRecord & { path?: string }>) {
    const id = String(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    items.push(row)
  }
  const summed = buckets.reduce((sum, item) => sum + item.total, 0)
  const exact = await distinctTotal
  const total = Number.isFinite(exact) ? Number(exact) : summed
  const schema = pages.find((item) => item.schema)?.schema
  return { buckets, items, total, schema }
}
