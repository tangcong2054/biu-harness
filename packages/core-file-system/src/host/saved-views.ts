import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { currentRequestWorkspaceId, openAndMigrateBiu } from '@biu/host-plugin-loader/data-dir'
import type { CollectionInfo, CollectionSpec, DbRecord } from '@biu/type-file-system'
import { normalizeSchemaValue, recordBuiltinValues, REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import { builtinAllView, isReadOnlyViewId } from '../catalog-views.ts'
import { normalizeColumnWidths, normalizePageSize, type SavedView } from '../web/saved-view.ts'
import { isViewModeId } from '../web/fields.ts'
import { normalizeCollectionPath } from '../paths.ts'
import {
  SqliteMetadataRuntime,
  type MetadataRepository,
  type MetadataRuntimeMode,
  type SavedViewMutation,
} from '@biu/host-plugin-loader/metadata-runtime'
import {
  countFilterRules,
  flatFiltersToTree,
  looksLikeFilterTree,
  normalizeFilterGroup,
  parseSortsInput,
  VIEW_FILTERS_DESCRIPTION,
  VIEW_FILTER_TREE_DESCRIPTION,
  VIEW_SORTS_DESCRIPTION,
  type FilterGroup,
  type SortRule,
} from '../query-logic.ts'

type DatabaseSync = import('node:sqlite').DatabaseSync

const VIEW_COLUMNS_SHAPE = 'columns 应为字符串数组，例如 ["title","facet"]'

/** db_create / db_update 的 columns：数组、JSON 数组字符串或逗号分隔都接受；不能把 JSON 碎片按逗号拆。 */
export function parseViewColumnsInput(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  if (typeof value !== 'string') throw new Error(VIEW_COLUMNS_SHAPE)
  const text = value.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(VIEW_COLUMNS_SHAPE)
    }
    if (!Array.isArray(parsed)) throw new Error(VIEW_COLUMNS_SHAPE)
    return parseViewColumnsInput(parsed)
  }
  if (text.includes('"') || text.includes(']')) throw new Error(VIEW_COLUMNS_SHAPE)
  return [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))]
}

export type StoredView = Partial<SavedView> & Pick<SavedView, 'id' | 'name'> & {
  createdBy?: string
  revision?: number
  deletedAt?: number
}

type ViewRow = { workspace_id: string; collection: string; payload_json: string }

export class SavedViewsStore {
  private byPath = new Map<string, StoredView[]>()
  private db: DatabaseSync | null = null
  private runtime: SqliteMetadataRuntime | null = null
  private incrementalViews = false

  configureRuntime(
    mode: MetadataRuntimeMode,
    repository: MetadataRepository | null,
    onShadowError?: (error: unknown) => void,
  ) {
    this.runtime = new SqliteMetadataRuntime(
      mode,
      repository,
      () => {
        if (!this.db) this.open(':memory:')
        return this.db!
      },
      ['saved_views'],
      onShadowError,
    )
  }

  async prepare() {
    await this.runtime?.prepare()
    this.hydrate()
  }

  async flush() {
    await this.runtime?.flush()
  }

  async mutate(accountId: string, mutations: readonly SavedViewMutation[]) {
    if (!this.runtime) this.configureRuntime('sqlite', null)
    if (mutations.length) this.incrementalViews = true
    try {
      const results = await this.runtime!.mutateSavedViews(accountId, mutations)
      this.hydrate()
      return results
    } catch (error) {
      if ((error as { committed?: boolean } | null)?.committed) this.byPath.clear()
      throw error
    }
  }

  private requireLegacyViews() {
    if (this.incrementalViews) throw new Error('Saved views require incremental mutations')
    const versioned = this.db?.prepare(`SELECT 1 FROM saved_views
      WHERE CASE WHEN json_valid(payload_json)
        THEN json_type(payload_json, '$.revision') IS NOT NULL OR json_type(payload_json, '$.deletedAt') IS NOT NULL
        ELSE 0 END LIMIT 1`).get()
    if (versioned) throw new Error('Saved views require incremental mutations')
  }

  open(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openAndMigrateBiu(path, { foreignKeys: false })
    this.hydrate()
    return this
  }

  private workspaceId() {
    return currentRequestWorkspaceId()
  }

  private key(collectionPath: string, workspaceId = this.workspaceId()) {
    return `${workspaceId}\0${normalizeCollectionPath(collectionPath)}`
  }

  private scopedEntries() {
    const prefix = `${this.workspaceId()}\0`
    return [...this.byPath.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, views]) => [key.slice(prefix.length), views] as const)
  }

  private hydrate() {
    if (!this.db) return
    this.byPath.clear()
    if (this.runtime && !this.runtime.savedViewCacheValid) return
    const rows = this.db.prepare('SELECT workspace_id, collection, payload_json FROM saved_views').all() as ViewRow[]
    for (const row of rows) {
      const collection = normalizeCollectionPath(row.collection)
      if (!collection || collection === '/' || collection === '/views') continue
      let parsed: StoredView | null = null
      try {
        parsed = JSON.parse(row.payload_json) as StoredView
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const id = String(parsed.id ?? '').trim()
      const name = String(parsed.name ?? id).trim()
      if (!id || isReadOnlyViewId(id) || parsed.builtin || parsed.deletedAt != null) continue
      const key = this.key(collection, row.workspace_id)
      const list = this.byPath.get(key) ?? []
      list.push({ ...parsed, id, name })
      this.byPath.set(key, list)
    }
  }

  private persistPath(collectionPath: string) {
    this.persistPaths([collectionPath])
  }

  /** 多张表一起落盘：包在同一个事务里，失败时整批回滚，避免内存改完而磁盘只写了一半。 */
  private persistPaths(collectionPaths: readonly string[]) {
    if (!this.db) return
    const paths = [...new Set(collectionPaths.map((item) => normalizeCollectionPath(item)))]
    if (!paths.length) return
    const workspaceId = this.workspaceId()
    const upsert = this.db.prepare(
      `INSERT INTO saved_views (workspace_id, collection, view_id, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, collection, view_id)
       DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    )
    const wipe = this.db.prepare('DELETE FROM saved_views WHERE workspace_id = ? AND collection = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const path of paths) {
        wipe.run(workspaceId, path)
        for (const view of this.byPath.get(this.key(path, workspaceId)) ?? []) {
          if (view.builtin || isReadOnlyViewId(String(view.id))) continue
          upsert.run(workspaceId, path, String(view.id), JSON.stringify(view), Date.now())
        }
      }
      this.db.exec('COMMIT')
      this.runtime?.changed('saved_views')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 不传 accountId 时返回本空间全部视图，供视图授权、公开分享等内部判断使用；
   * 传入账号时只返回该账号自己的视图。
   */
  viewsFor(collectionPath: string, accountId?: string): StoredView[] {
    const views = this.byPath.get(this.key(collectionPath)) ?? []
    if (accountId === undefined) return views
    return views.filter((view) => ownsView(view, accountId))
  }

  /** 视图按创建账号分开存：这次写入只替换当前账号自己的视图。 */
  replaceOwned(collectionPath: string, views: StoredView[], accountId: string) {
    this.requireLegacyViews()
    if (!this.db) this.open(':memory:')
    const path = normalizeCollectionPath(collectionPath)
    const key = this.key(path)
    const prev = this.byPath.get(key) ?? []
    const kept = prev.filter((view) => !ownsView(view, accountId))
    const foreign = new Set(kept.map((view) => view.id))
    const mine = views
      .filter((view) => !view.builtin && !isReadOnlyViewId(String(view.id)) && !foreign.has(String(view.id)))
      .map((view) => {
        const { createdBy: _ignored, ...rest } = view
        return { ...rest, id: String(view.id), name: String(view.name || view.id), ...(accountId ? { createdBy: accountId } : {}) }
      })
    this.byPath.set(key, [...kept, ...mine])
    this.persistPath(path)
  }

  replace(collectionPath: string, views: StoredView[]) {
    this.requireLegacyViews()
    if (!this.db) this.open(':memory:')
    const path = normalizeCollectionPath(collectionPath)
    const key = this.key(path)
    this.byPath.set(
      key,
      views
        .filter((view) => !view.builtin && !isReadOnlyViewId(String(view.id)))
        .map((view) => ({ ...view, id: String(view.id), name: String(view.name || view.id) })),
    )
    this.persistPath(path)
  }

  rows(tables: CollectionInfo[], accountId = ''): DbRecord[] {
    const labels = new Map(tables.map((item) => [normalizeCollectionPath(item.path), item.view?.title ?? item.label]))
    const out: DbRecord[] = []
    const seen = new Set<string>()
    const emit = (path: string, tableName: string, view: StoredView) => {
      const rec = asRecord(path, tableName, view)
      if (seen.has(rec.id)) return
      seen.add(rec.id)
      out.push(rec)
    }
    for (const table of tables) {
      const path = normalizeCollectionPath(table.path)
      if (!path || path === '/') continue
      const label = String(labels.get(path) ?? table.label ?? path)
      const all = builtinAllView({ path, label, view: table.view })
      emit(path, label, all)
      for (const view of this.byPath.get(this.key(path)) ?? []) {
        if (view.builtin || isReadOnlyViewId(view.id)) continue
        if (!ownsView(view, accountId)) continue
        emit(path, label, view)
      }
    }
    for (const [path, views] of this.scopedEntries()) {
      if (tables.some((table) => normalizeCollectionPath(table.path) === path)) continue
      for (const view of views) {
        if (view.builtin || isReadOnlyViewId(view.id)) continue
        if (!ownsView(view, accountId)) continue
        emit(path, labels.get(path) ?? path, view)
      }
    }
    return out.sort((a, b) => String(a.table).localeCompare(String(b.table)) || String(a.title).localeCompare(String(b.title)))
  }

  async create(fields: Record<string, unknown>, tables: CollectionInfo[], accountId = ''): Promise<DbRecord> {
    return (await this.createMany([fields], tables, accountId))[0]!
  }

  /**
   * 批量新建：先在内存里校验并构造全部视图（含同批之间撞 id / 撞名），全部通过后再落盘。
   * 任一行不合法时一条都不写，避免“前面的已持久化、后面的报错”。
   */
  async createMany(rows: Array<Record<string, unknown>>, tables: CollectionInfo[], accountId = ''): Promise<DbRecord[]> {
    const pending = new Map<string, StoredView[]>()
    const out: Array<{ path: string; label: string; view: StoredView }> = []
    for (const fields of rows) {
      const tablePath = tablePathOf(fields)
      if (!tablePath || tablePath === '/' || tablePath === '/views') throw new Error('tablePath required')
      const table = tables.find((item) => normalizeCollectionPath(item.path) === tablePath)
      if (!table) throw new Error(`unknown collection: ${tablePath}`)
      const label = table.view?.title ?? table.label ?? tablePath
      const views = pending.get(tablePath) ?? [...(this.byPath.get(this.key(tablePath)) ?? [])]
      const wanted = String(fields.viewId ?? '').trim()
      const id = wanted || `view-${randomUUID()}`
      if (isReadOnlyViewId(id)) throw new Error('builtin view is read-only')
      if (views.some((view) => view.id === id)) throw new Error(`view exists: ${id}`)
      const name = uniqueViewName(
        String(fields.title ?? fields.name ?? '新视图').trim() || '新视图',
        views.filter((view) => ownsView(view, accountId)),
      )
      const now = Date.now()
      const view: StoredView = {
        id,
        name,
        mode: typeof fields.mode === 'string' && isViewModeId(fields.mode) ? fields.mode : 'table',
        sortField: typeof fields.sortField === 'string' && fields.sortField.trim() ? fields.sortField : 'id',
        sortDir: fields.sortDir === 'desc' ? 'desc' : 'asc',
        query: typeof fields.query === 'string' ? fields.query : '',
        groupBy: typeof fields.groupBy === 'string' ? fields.groupBy : '',
        columns: fields.columns != null ? parseViewColumnsInput(fields.columns) : [],
        ...filtersFromPatch(fields.filters),
        ...sortsFromPatch(fields.sorts, fields.sortField, fields.sortDir),
        tree: fields.tree !== false,
        wrap: Boolean(fields.wrap),
        truncate: fields.truncate !== false,
        pageSize: normalizePageSize(fields.pageSize),
        columnWidths: normalizeColumnWidths(fields.columnWidths),
        createdAt: now,
        updatedAt: now,
        ...(accountId ? { createdBy: accountId } : {}),
      }
      pending.set(tablePath, [...views, view])
      out.push({ path: tablePath, label, view })
    }
    const results = await this.mutate(accountId, out.map(({ path, view }) => ({
      type: 'create', collection: path, id: view.id, view: { ...view },
    })))
    return results.map((result, index) => asRecord(result.collection, out[index]!.label, result.view as StoredView))
  }

  /** 批量删除：先确认每个 id 都存在且有权删除，再统一删除；任一不合法时一条都不删。 */
  async removeMany(ids: readonly string[], accountId = ''): Promise<string[]> {
    const unique = [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
    const entries = this.scopedEntries()
    const mutations: SavedViewMutation[] = []
    for (const id of unique) {
      if (isReadOnlyViewId(viewIdOfRow(id))) throw new Error('builtin view is read-only')
      let found = false
      for (const [path, views] of entries) {
        const hit = views.find((view) => rowId(path, view.id) === id)
        if (!hit) continue
        if (!ownsView(hit, accountId)) throw new Error('unknown view: ' + id)
        mutations.push({ type: 'delete', collection: path, id: hit.id, expectedRevision: hit.revision ?? 0 })
        found = true
        break
      }
      if (!found) throw new Error(`unknown view: ${id}`)
    }
    await this.mutate(accountId, mutations)
    return unique
  }

  async write(id: string, patch: Record<string, unknown>, accountId = ''): Promise<DbRecord> {
    if (isReadOnlyViewId(viewIdOfRow(id))) throw new Error('builtin view is read-only')
    for (const [path, views] of this.scopedEntries()) {
      const idx = views.findIndex((view) => rowId(path, view.id) === id)
      if (idx < 0) continue
      const cur = views[idx]!
      if (cur.builtin || isReadOnlyViewId(cur.id)) throw new Error('builtin view is read-only')
      if (!ownsView(cur, accountId)) throw new Error('unknown view: ' + id)
      const next: StoredView = {
        ...cur,
        ...(typeof patch.title === 'string' ? { name: patch.title } : {}),
        ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
        ...(typeof patch.mode === 'string' && isViewModeId(patch.mode) ? { mode: patch.mode } : {}),
        ...(typeof patch.sortField === 'string' ? { sortField: patch.sortField } : {}),
        ...(patch.sortDir === 'asc' || patch.sortDir === 'desc' ? { sortDir: patch.sortDir } : {}),
        ...(typeof patch.query === 'string' ? { query: patch.query } : {}),
        ...(typeof patch.groupBy === 'string' ? { groupBy: patch.groupBy } : {}),
        ...('filters' in patch ? filtersFromPatch(patch.filters) : {}),
        ...('filterTree' in patch ? { filterTree: normalizeFilterGroup(parseJsonValue(patch.filterTree)) } : {}),
        ...('sorts' in patch ? sortsFromPatch(patch.sorts, patch.sortField ?? cur.sortField, patch.sortDir ?? cur.sortDir) : {}),
        ...('columns' in patch && patch.columns != null ? { columns: parseViewColumnsInput(patch.columns) } : {}),
        ...(typeof patch.pageSize === 'number' ? { pageSize: patch.pageSize } : {}),
        ...(typeof patch.tree === 'boolean' ? { tree: patch.tree } : {}),
        ...(typeof patch.wrap === 'boolean' ? { wrap: patch.wrap } : {}),
        ...(typeof patch.truncate === 'boolean' ? { truncate: patch.truncate } : {}),
        ...('columnWidths' in patch ? { columnWidths: normalizeColumnWidths(patch.columnWidths) } : {}),
        ...('emoji' in patch ? { emoji: String(patch.emoji ?? '') } : {}),
        ...('facet' in patch ? { facet: normalizeSchemaValue(patch.facet) } : {}),
        updatedAt: Date.now(),
        createdAt: Number((cur as { createdAt?: number }).createdAt) || Date.now(),
      }
      const [result] = await this.mutate(accountId, [{
        type: 'update', collection: path, id: cur.id,
        expectedRevision: (patch.expectedRevision !== undefined ? patch.expectedRevision : cur.revision ?? 0) as number,
        view: { ...next },
      }])
      return asRecord(path, path, result!.view as StoredView)
    }
    throw new Error(`unknown view: ${id}`)
  }
}

function rowId(path: string, viewId: string) {
  return `${path.replace(/^\//, '')}::${viewId}`
}

/**
 * 视图按创建账号分开看。没有 createdBy 的只剩无账号的本机历史数据，
 * 这里归给所有人：否则它们既不出现在列表里、也删不掉，永久残留。
 * 云端历史视图由 MySQL 迁移补上空间所有者。
 */
function ownsView(view: { createdBy?: unknown }, accountId: string) {
  const owner = typeof view.createdBy === 'string' ? view.createdBy.trim() : ''
  return !owner || owner === accountId
}

function viewIdOfRow(id: string) {
  const cut = id.indexOf('::')
  return cut >= 0 ? id.slice(cut + 2) : id
}

function tablePathOf(fields: Record<string, unknown>) {
  const raw = fields.tablePath ?? (typeof fields.table === 'string' && String(fields.table).startsWith('/') ? fields.table : '')
  return normalizeCollectionPath(String(raw ?? ''))
}

function uniqueViewName(base: string, views: StoredView[]) {
  const names = new Set(views.map((view) => view.name))
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function filtersFromPatch(value: unknown): { filters: Record<string, string>; filterTree: FilterGroup } {
  const raw = parseJsonValue(value)
  if (looksLikeFilterTree(raw)) {
    return { filters: {}, filterTree: normalizeFilterGroup(raw) }
  }
  const filters = asFilters(raw)
  return { filters, filterTree: flatFiltersToTree(filters) }
}

function sortsFromPatch(value: unknown, sortField: unknown, sortDir: unknown): { sorts: SortRule[]; sortField: string; sortDir: 'asc' | 'desc' } {
  const sorts = parseSortsInput(value, String(sortField || 'title'), sortDir === 'desc' ? 'desc' : 'asc')
  return {
    sorts,
    sortField: sorts[0]?.field || 'title',
    sortDir: sorts[0]?.dir ?? 'asc',
  }
}

function asFilters(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item == null || typeof item === 'object') continue
      out[key] = String(item)
    }
    return out
  }
  return {}
}

function asRecord(path: string, tableName: string, view: StoredView): DbRecord {
  const filters = view.filters && typeof view.filters === 'object' ? view.filters : {}
  const sorts = parseSortsInput(view.sorts, view.sortField, view.sortDir === 'desc' ? 'desc' : 'asc')
  const filterTree = view.filterTree
  return {
    id: rowId(path, view.id),
    title: view.name,
    table: tableName,
    tablePath: path,
    viewId: view.id,
    revision: view.revision ?? 0,
    mode: view.mode ?? 'table',
    sortField: sorts[0]?.field || view.sortField || 'title',
    sortDir: sorts[0]?.dir ?? (view.sortDir === 'desc' ? 'desc' : 'asc'),
    query: view.query ?? '',
    groupBy: view.groupBy ?? '',
    tree: view.tree !== false,
    wrap: Boolean(view.wrap),
    truncate: view.truncate !== false,
    pageSize: normalizePageSize(view.pageSize),
    columns: Array.isArray(view.columns) ? view.columns.map(String) : [],
    columnWidths: view.columnWidths ?? {},
    filters: JSON.stringify(filters),
    sorts: JSON.stringify(sorts.map((item) => ({ field: item.field, dir: item.dir }))),
    filterTree: filterTree ? JSON.stringify(filterTree) : '',
    ...recordBuiltinValues(view as Record<string, unknown>),
  }
}

/** 工具广播给前端的视图快照（含扁平 filters / filterTree / sorts）。 */
export function clientViewFromDbRow(row: Record<string, unknown> | undefined) {
  if (!row) return undefined
  const id = String(row.viewId ?? '').trim()
  if (!id || isReadOnlyViewId(id)) return undefined
  const parsedFilters = filtersFromPatch(row.filters)
  const fromTree = parseJsonValue(row.filterTree)
  const tree = looksLikeFilterTree(fromTree) ? normalizeFilterGroup(fromTree) : parsedFilters.filterTree
  const sortsPatch = sortsFromPatch(row.sorts, row.sortField, row.sortDir)
  return {
    id,
    tablePath: normalizeCollectionPath(String(row.tablePath ?? '')),
    revision: row.revision,
    name: String(row.title ?? row.name ?? id),
    mode: row.mode,
    sortField: sortsPatch.sortField,
    sortDir: sortsPatch.sortDir,
    sorts: sortsPatch.sorts,
    query: String(row.query ?? ''),
    groupBy: String(row.groupBy ?? ''),
    columns: Array.isArray(row.columns) ? row.columns.map((item) => String(item)) : [],
    filters: parsedFilters.filters,
    filterTree: countFilterRules(tree) ? tree : undefined,
    tree: row.tree !== false,
    wrap: Boolean(row.wrap),
    truncate: row.truncate !== false,
    pageSize: normalizePageSize(row.pageSize),
    columnWidths: row.columnWidths,
    builtin: false,
  }
}

export function viewsCollection(
  store: SavedViewsStore,
  tables: () => CollectionInfo[],
  accountId: () => string = () => '',
): CollectionSpec {
  const list = () => store.rows(tables(), accountId())
  return {
    id: 'views',
    path: '/views',
    label: '视图',
    view: {
      moduleId: 'views-db',
      route: '/db-views',
      title: '视图',
      inspector: false,
      blurb: '各表已保存的视图。列表 db_list /views。新建 db_create /views records=[{title, tablePath, mode}]，tablePath 如 /pages。改筛选 db_update 写 filters 或 filterTree（JSON 字符串）。filters 扁平等于：{"project":"biu","tags":"test"}（tags 含该标签）。OR/复杂条件用 filterTree：{"kind":"group","combinator":"or","children":[{"kind":"rule","field":"tags","op":"eq","value":"test"},{"kind":"rule","field":"tags","op":"eq","value":"bug"}]}。rule.op=eq|neq|contains|not_contains|is_empty|not_empty|gt|lt|within，value 是字符串。排序 sorts：[{"field":"title","dir":"asc"}]。内置「全部 xx」只读。',
      order: 17,
      icon: 'eye',
    },
    records: { update: true, create: true, delete: true },
    schema: {
      labelField: 'title',
      columns: ['title', 'table', 'mode', 'sortField', 'sortDir', 'query', 'groupBy', 'pageSize'],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '视图', writable: true },
        table: { type: 'string', label: '来源表' },
        tablePath: { type: 'string', label: '表路径', writable: true },
        viewId: { type: 'string', label: '视图 ID' },
        revision: { type: 'number', label: '版本' },
        expectedRevision: { type: 'number', label: '预期版本', writable: true },
        mode: { type: 'string', label: '呈现', writable: true },
        sortField: { type: 'string', label: '排序字段', writable: true },
        sortDir: { type: 'select', label: '升降序', writable: true, enum: ['asc', 'desc'] },
        sorts: { type: 'string', label: '排序', writable: true, description: VIEW_SORTS_DESCRIPTION },
        query: { type: 'string', label: '搜索', writable: true },
        groupBy: { type: 'string', label: '分组', writable: true },
        tree: { type: 'boolean', label: '树形' },
        wrap: { type: 'boolean', label: '换行' },
        truncate: { type: 'boolean', label: '截断' },
        pageSize: { type: 'number', label: '每页', writable: true },
        columns: { type: 'multi-select', label: '列', writable: true },
        filters: { type: 'string', label: '筛选', writable: true, description: VIEW_FILTERS_DESCRIPTION },
        filterTree: { type: 'string', label: '筛选树', writable: true, description: VIEW_FILTER_TREE_DESCRIPTION },
      },
    },
    list,
    get: (id) => list().find((row) => row.id === id) ?? null,
    update: (id, patch) => store.write(id, patch, accountId()),
    create: (rows) => store.createMany(rows, tables(), accountId()),
    remove: async (query) => store.removeMany(query.ids ?? [], accountId()),
  }
}
