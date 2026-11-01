import { builtinAllViewId, stubBuiltinAllView, stubBuiltinBlockKindView, stubBuiltinCatalogView, stubBuiltinTagView, stubBuiltinScopeView, stubBuiltinMemberView, isReadOnlyViewId, isBuiltinAllViewForCollection, isBuiltinAllViewId } from '../catalog-views.ts'
import { isIndexCollection } from './database-path.ts'
import { listCollection } from './db-client.ts'
import { looksLikeFilterTree, normalizeFilterGroup, parseSortsInput } from '../query-logic.ts'
import { normalizePageSize, normalizeSavedView, normalizeColumnWidths, type SavedView } from './saved-view.ts'

export function workspaceViewScope() {
  try {
    return sessionStorage.getItem('biu.workspaceId') || localStorage.getItem('biu.workspaceId') || 'local'
  } catch {
    return 'local'
  }
}

/** 视图按账号隔离；浏览器里只有登录令牌，用它的短指纹区分缓存，不把令牌本身写进键名。 */
function accountViewScope() {
  let token = ''
  try {
    token = localStorage.getItem('biu.account.token') ?? ''
  } catch {
    /* ignore */
  }
  if (!token) return 'anon'
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

const VIEWS_KEY_PREFIX = 'fsdb.views:'

export function viewsKey(collectionPath: string) {
  return `${VIEWS_KEY_PREFIX}${workspaceViewScope()}:${accountViewScope()}:${collectionPath}`
}

/** 换账号登录后清掉同一空间里其他登录留下的视图缓存。 */
function pruneForeignViewCaches() {
  try {
    const workspace = `${VIEWS_KEY_PREFIX}${workspaceViewScope()}:`
    const own = `${workspace}${accountViewScope()}:`
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(workspace) && !key.startsWith(own)) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function activeViewStorageKey(collectionPath: string) {
  return `fsdb.activeView:${workspaceViewScope()}:${collectionPath}`
}

const memoryViews = new Map<string, SavedView[]>()
const viewCacheRevisions = new Map<string, number>()

export function rememberViews(collectionPath: string, views: SavedView[]) {
  const key = viewsKey(collectionPath)
  memoryViews.set(key, views.map((view) => normalizeSavedView(view)))
  viewCacheRevisions.set(key, (viewCacheRevisions.get(key) ?? 0) + 1)
}

export function loadViews(collectionPath: string): SavedView[] {
  const remembered = memoryViews.get(viewsKey(collectionPath))
  if (remembered) return remembered
  try {
    const raw = localStorage.getItem(viewsKey(collectionPath))
    const parsed = raw ? (JSON.parse(raw) as SavedView[]) : []
    if (parsed.length) return parsed.map((view) => normalizeSavedView(view))
  } catch {
    /* ignore */
  }
  return []
}

export type CrumbRecord = { id: string; label: string; emoji?: string; mascot?: unknown }

const memoryRecords = new Map<string, CrumbRecord[]>()
const memoryRecordMeta = new Map<string, CrumbRecord>()

function recordsKey(collectionPath: string, viewId?: string) {
  return `${workspaceViewScope()}\0${collectionPath}\0${viewId ?? ''}`
}

function recordMetaKey(collectionPath: string, recordId: string) {
  return `${workspaceViewScope()}\0${collectionPath}\0id:${recordId}`
}

function keepCrumbLabel(row: CrumbRecord, prev?: CrumbRecord) {
  const next = String(row.label ?? '').trim()
  const last = String(prev?.label ?? '').trim()
  if (next && next !== row.id) return next
  if (last && last !== row.id) return last
  return next || last || row.id
}

export function rememberRecords(collectionPath: string, rows: CrumbRecord[], viewId?: string) {
  const painted = rows.map((row) => {
    const last = memoryRecordMeta.get(recordMetaKey(collectionPath, row.id))
    const next = {
      ...last,
      ...row,
      label: keepCrumbLabel(row, last),
      emoji: row.emoji || last?.emoji,
      mascot: row.mascot ?? last?.mascot,
    }
    memoryRecordMeta.set(recordMetaKey(collectionPath, row.id), next)
    return next
  })
  memoryRecords.set(recordsKey(collectionPath, viewId), painted)
}

export function loadRecords(collectionPath: string, viewId?: string): CrumbRecord[] {
  return memoryRecords.get(recordsKey(collectionPath, viewId)) ?? []
}

export function peekRecord(collectionPath: string, recordId: string): CrumbRecord | undefined {
  return memoryRecordMeta.get(recordMetaKey(collectionPath, recordId))
}

export function loadActiveViewId(collectionPath: string, listed: SavedView[]) {
  try {
    const id = localStorage.getItem(activeViewStorageKey(collectionPath))
    if (id && listed.some((view) => view.id === id)) return id
  } catch {
    /* ignore */
  }
  return listed[0]?.id ?? null
}

export function viewForPath(collectionPath: string, routeViewId?: string): SavedView | null {
  const listed = loadViews(collectionPath)
  const fallback = stubBuiltinAllView(builtinAllViewId(collectionPath))
  const preferred =
    (routeViewId
      ? listed.find((item) => item.id === routeViewId) ??
        stubBuiltinScopeView(routeViewId, listed) ??
        stubBuiltinMemberView(routeViewId) ??
        stubBuiltinCatalogView(routeViewId) ??
        stubBuiltinTagView(routeViewId) ??
        stubBuiltinBlockKindView(routeViewId) ??
        (isBuiltinAllViewForCollection(routeViewId, collectionPath) ? stubBuiltinAllView(routeViewId) : null)
      : undefined) ??
    listed.find((item) => item.id === loadActiveViewId(collectionPath, listed)) ??
    fallback ??
    listed[0]
  return preferred ? withViewDisplay(collectionPath, normalizeSavedView(preferred)) : null
}

export function defaultViewId(collectionPath: string, routeViewId?: string) {
  return viewForPath(collectionPath, routeViewId)?.id ?? builtinAllViewId(collectionPath)
}

/** 水合时列表可能还没有内置块类型视图；URL 上的 builtin-block: 仍用 stub 还原，不能退回「全部」。 */
export function pickViewForRoute(listed: SavedView[], collectionPath: string, routeViewId?: string) {
  const route = String(routeViewId ?? '').trim()
  if (route) {
    return listed.find((item) => item.id === route) ?? viewForPath(collectionPath, route)
  }
  return listed.find((item) => item.id === loadActiveViewId(collectionPath, listed)) ?? listed[0] ?? null
}

export type StarredView = { path: string; viewId: string }

const STARRED_VIEWS_KEY = 'fsdb.starredViews'

export function loadStarredViews(): StarredView[] {
  try {
    const raw = localStorage.getItem(STARRED_VIEWS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const rec = item as Record<string, unknown>
      const path = String(rec.path ?? '').trim()
      const viewId = String(rec.viewId ?? '').trim()
      return path && viewId ? [{ path, viewId }] : []
    })
  } catch {
    return []
  }
}

let starredViews = loadStarredViews()
let starredVersion = 0
const starredListeners = new Set<() => void>()

export function getStarredViews() {
  return starredViews
}

export function subscribeStarredViews(fn: () => void) {
  starredListeners.add(fn)
  return () => {
    starredListeners.delete(fn)
  }
}

export function getStarredViewsVersion() {
  return starredVersion
}

export function persistStarredViews(items: StarredView[]) {
  starredViews = items
  starredVersion += 1
  localStorage.setItem(STARRED_VIEWS_KEY, JSON.stringify(items))
  for (const fn of starredListeners) fn()
}

type ViewMutation =
  | { type: 'create'; collection: string; id: string; view: SavedView }
  | { type: 'update'; collection: string; id: string; expectedRevision: number; view: SavedView }
  | { type: 'delete'; collection: string; id: string; expectedRevision: number }

/** 服务端已确认的视图（含版本），作为增量差异基线；不受本地乐观更新影响。 */
const confirmedViews = new Map<string, Map<string, SavedView>>()
const saveQueues = new Map<string, Promise<void>>()

function confirmViews(key: string, views: readonly SavedView[]) {
  confirmedViews.set(key, new Map(views.filter((view) => !view.builtin).map((view) => [view.id, normalizeSavedView(view)])))
}

function viewContent(view: SavedView) {
  const { revision: _r, createdBy: _c, createdAt: _a, updatedAt: _u, ...rest } = normalizeSavedView(view)
  return JSON.stringify(rest)
}

export function savedViewMutations(collectionPath: string, base: ReadonlyMap<string, SavedView>, desired: readonly SavedView[]) {
  const mutations: ViewMutation[] = []
  const wanted = new Map<string, SavedView>()
  for (const view of desired) if (!view.builtin && !isReadOnlyViewId(view.id)) wanted.set(view.id, view)
  for (const [id, view] of wanted) {
    const { revision: _r, createdBy: _c, createdAt: _a, updatedAt: _u, ...payload } = normalizeSavedView(view)
    const prev = base.get(id)
    if (!prev) mutations.push({ type: 'create', collection: collectionPath, id, view: payload as SavedView })
    else if (viewContent(prev) !== viewContent(view)) {
      mutations.push({ type: 'update', collection: collectionPath, id, expectedRevision: prev.revision ?? 0, view: payload as SavedView })
    }
  }
  for (const [id, prev] of base) {
    if (!wanted.has(id)) mutations.push({ type: 'delete', collection: collectionPath, id, expectedRevision: prev.revision ?? 0 })
  }
  return mutations
}

function patchCachedRevisions(key: string, revisions: ReadonlyMap<string, number>, deleted: ReadonlySet<string>) {
  const cached = memoryViews.get(key)
  if (!cached) return
  const next = cached.filter((view) => !deleted.has(view.id))
    .map((view) => revisions.has(view.id) ? { ...view, revision: revisions.get(view.id) } : view)
  memoryViews.set(key, next)
  try {
    if (next.length) localStorage.setItem(key, JSON.stringify(next))
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export class SavedViewSaveError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
  get conflict() {
    return this.status === 409
  }
}

/**
 * 只提交相对服务端已确认版本的变化（新增/修改/显式删除）。
 * 同一集合串行提交；失败（网络错误、非 2xx、版本冲突）抛出，调用方据此回滚或重新拉取。
 * previous 为本次乐观更新之前的列表，仅在尚无确认基线时使用。
 */
export function pushSavedViews(collectionPath: string, views: SavedView[], previous: readonly SavedView[] = []) {
  const key = viewsKey(collectionPath)
  const desired = views.filter((view) => !view.builtin).map((view) => normalizeSavedView(view))
  const fallback = previous.filter((view) => !view.builtin).map((view) => normalizeSavedView(view))
  const run = async () => {
    if (viewsKey(collectionPath) !== key) throw new SavedViewSaveError('账号或空间已切换，未保存', 409, 'SAVED_VIEW_SCOPE')
    if (!confirmedViews.has(key)) confirmViews(key, fallback)
    const base = confirmedViews.get(key)!
    const mutations = savedViewMutations(collectionPath, base, desired)
    if (!mutations.length) return
    const res = await fetch('/api/db/saved-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: collectionPath, mutations }),
    })
    const data = (await res.json().catch(() => null)) as
      | { error?: unknown; code?: unknown; views?: Array<{ id?: unknown; revision?: unknown; deleted?: unknown }> }
      | null
    if (!res.ok) {
      if (res.status === 409 || res.status === 503) confirmedViews.delete(key)
      throw new SavedViewSaveError(
        typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`,
        res.status,
        typeof data?.code === 'string' ? data.code : '',
      )
    }
    const revisions = new Map<string, number>()
    const deleted = new Set<string>()
    for (const item of data?.views ?? []) {
      const id = String(item?.id ?? '')
      if (!id) continue
      if (item.deleted) deleted.add(id)
      else if (typeof item.revision === 'number' && Number.isSafeInteger(item.revision)) revisions.set(id, item.revision)
    }
    const desiredById = new Map(desired.map((view) => [view.id, view]))
    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        base.delete(mutation.id)
        continue
      }
      const revision = revisions.get(mutation.id)
      if (revision === undefined) {
        confirmedViews.delete(key)
        return
      }
      base.set(mutation.id, { ...desiredById.get(mutation.id)!, revision })
    }
    if (viewsKey(collectionPath) === key) patchCachedRevisions(key, revisions, deleted)
  }
  const queued = (saveQueues.get(key) ?? Promise.resolve()).then(run)
  const tail = queued.catch(() => {})
  saveQueues.set(key, tail)
  void tail.then(() => { if (saveQueues.get(key) === tail) saveQueues.delete(key) })
  return queued
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function parseViewFilterTree(value: unknown) {
  const raw = parseMaybeJson(value)
  if (!looksLikeFilterTree(raw)) return undefined
  return normalizeFilterGroup(raw)
}

function parseViewFilters(value: unknown): Record<string, string> {
  const raw = parseMaybeJson(value)
  if (looksLikeFilterTree(raw)) return {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
      if (key.startsWith('$')) continue
      out[key] = String(item)
    }
    return out
  }
  return {}
}

export function savedViewFromRecord(row: { [key: string]: unknown; revision?: unknown; viewId?: unknown; title?: unknown; mode?: unknown; sortField?: unknown; sortDir?: unknown; sorts?: unknown; query?: unknown; groupBy?: unknown; columns?: unknown; filters?: unknown; filterTree?: unknown; tree?: unknown; wrap?: unknown; truncate?: unknown; pageSize?: unknown; columnWidths?: unknown }): SavedView | null {
  const id = String(row.viewId ?? '').trim()
  if (!id || isReadOnlyViewId(id)) return null
  const sortDir = row.sortDir === 'desc' ? 'desc' : 'asc'
  const sortField = String(row.sortField ?? 'title')
  const filters = parseViewFilters(row.filters)
  const filterTree = parseViewFilterTree(row.filterTree) ?? (looksLikeFilterTree(parseMaybeJson(row.filters)) ? normalizeFilterGroup(parseMaybeJson(row.filters)) : undefined)
  return normalizeSavedView({
    id,
    name: String(row.title ?? id),
    revision: typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : undefined,
    mode: String(row.mode ?? 'table') as SavedView['mode'],
    sortField,
    sortDir,
    sorts: parseSortsInput(row.sorts, sortField, sortDir),
    query: String(row.query ?? ''),
    groupBy: String(row.groupBy ?? ''),
    columns: Array.isArray(row.columns) ? row.columns.map((item) => String(item)) : [],
    filters,
    filterTree,
    tree: row.tree !== false,
    wrap: Boolean(row.wrap),
    truncate: row.truncate !== false,
    pageSize: normalizePageSize(row.pageSize),
    columnWidths: normalizeColumnWidths(row.columnWidths),
    builtin: false,
  })
}

const viewsPulls = new Map<string, Promise<void>>()
const viewsPulledAt = new Map<string, number>()
const VIEWS_PULL_TTL_MS = 2500

export async function pullSavedViews(collectionPaths: readonly string[] = [], force = false) {
  const scope = viewsKey('')
  const paths = [...new Set(collectionPaths)].sort()
  const key = JSON.stringify([scope, paths])
  const pending = viewsPulls.get(key)
  if (pending) return pending
  if (!force && Date.now() - (viewsPulledAt.get(key) ?? 0) < VIEWS_PULL_TTL_MS) return
  const request = pullSavedViewsNow(paths, scope).then((complete) => {
    if (complete) viewsPulledAt.set(key, Date.now())
  }).finally(() => { viewsPulls.delete(key) })
  viewsPulls.set(key, request)
  return request
}

async function pullSavedViewsNow(collectionPaths: readonly string[], scope: string) {
  const revisions = new Map(viewCacheRevisions)
  try {
    const byPath = new Map<string, Map<string, SavedView>>()
    let offset = 0
    let total: number | undefined
    do {
      if (viewsKey('') !== scope) return false
      const page = await listCollection({
        path: '/views', limit: 200, offset, sortField: 'id', requestScope: scope,
        columns: ['title', 'tablePath', 'viewId', 'revision', 'mode', 'sortField', 'sortDir',
          'sorts', 'query', 'groupBy', 'columns', 'filters', 'filterTree', 'tree', 'wrap',
          'truncate', 'pageSize', 'columnWidths'],
      })
      if (viewsKey('') !== scope) return false
      if (!Number.isSafeInteger(page.total) || page.total < 0 || page.total > 100_000
        || (total !== undefined && total !== page.total)) return false
      total = page.total
      if (!page.items.length && offset < total) return false
      for (const row of page.items) {
        const tablePath = String(row.tablePath ?? '').trim()
        const view = savedViewFromRecord(row)
        if (!tablePath || !view) continue
        const list = byPath.get(tablePath) ?? new Map<string, SavedView>()
        if (list.has(view.id)) return false
        list.set(view.id, view)
        byPath.set(tablePath, list)
      }
      offset += page.items.length
    } while (offset < total)
    const paths = new Set([...collectionPaths, ...byPath.keys()])
    pruneForeignViewCaches()
    let complete = true
    for (const path of paths) {
      const key = viewsKey(path)
      if ((viewCacheRevisions.get(key) ?? 0) !== (revisions.get(key) ?? 0)) {
        complete = false
        continue
      }
      const views = [...(byPath.get(path)?.values() ?? [])]
      rememberViews(path, views)
      if (!saveQueues.has(key)) confirmViews(key, views)
      try {
        if (views.length) localStorage.setItem(key, JSON.stringify(views))
        else localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }
    return complete
  } catch {
    return false
  }
}

export function upsertSavedView(collectionPath: string, view: SavedView) {
  const next = normalizeSavedView({ ...view, builtin: false })
  const stored = loadViews(collectionPath).filter((item) => item.id !== next.id && !item.builtin)
  stored.push(next)
  rememberViews(collectionPath, stored)
  try {
    localStorage.setItem(viewsKey(collectionPath), JSON.stringify(stored))
  } catch {
    /* ignore */
  }
}

export function isViewStarred(items: StarredView[], path: string, viewId: string) {
  return items.some((item) => item.path === path && item.viewId === viewId)
}

export function toggleStarredView(items: StarredView[], path: string, viewId: string): StarredView[] {
  if (isViewStarred(items, path, viewId)) return items.filter((item) => item.path !== path || item.viewId !== viewId)
  return [...items, { path, viewId }]
}

export type StarredRecord = { path: string; recordId: string; label?: string; emoji?: string }

const STARRED_RECORDS_KEY = 'fsdb.starredRecords'

export function loadStarredRecords(): StarredRecord[] {
  try {
    const raw = localStorage.getItem(STARRED_RECORDS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const rec = item as Record<string, unknown>
      const path = String(rec.path ?? '').trim()
      const recordId = String(rec.recordId ?? '').trim()
      if (!path || !recordId) return []
      const label = String(rec.label ?? '').trim()
      const emoji = String(rec.emoji ?? '').trim()
      return [{ path, recordId, ...(label ? { label } : {}), ...(emoji ? { emoji } : {}) }]
    })
  } catch {
    return []
  }
}

let starredRecords = loadStarredRecords()
let starredRecordsVersion = 0
const starredRecordListeners = new Set<() => void>()

export function getStarredRecords() {
  return starredRecords
}

export function subscribeStarredRecords(fn: () => void) {
  starredRecordListeners.add(fn)
  return () => {
    starredRecordListeners.delete(fn)
  }
}

export function getStarredRecordsVersion() {
  return starredRecordsVersion
}

export function persistStarredRecords(items: StarredRecord[]) {
  starredRecords = items
  starredRecordsVersion += 1
  localStorage.setItem(STARRED_RECORDS_KEY, JSON.stringify(items))
  for (const fn of starredRecordListeners) fn()
}

export function isRecordStarred(items: StarredRecord[], path: string, recordId: string) {
  return items.some((item) => item.path === path && item.recordId === recordId)
}

export function toggleStarredRecord(
  items: StarredRecord[],
  path: string,
  recordId: string,
  meta?: { label?: string; emoji?: string },
): StarredRecord[] {
  if (isRecordStarred(items, path, recordId)) return items.filter((item) => item.path !== path || item.recordId !== recordId)
  const label = String(meta?.label ?? '').trim()
  const emoji = String(meta?.emoji ?? '').trim()
  return [...items, { path, recordId, ...(label ? { label } : {}), ...(emoji ? { emoji } : {}) }]
}

export function starredRecordLabel(item: StarredRecord) {
  const peeked = peekRecord(item.path, item.recordId)
  const label = String(peeked?.label ?? item.label ?? '').trim()
  return label && label !== item.recordId ? label : label || item.recordId
}

export function starredRecordEmoji(item: StarredRecord) {
  return String(peekRecord(item.path, item.recordId)?.emoji ?? item.emoji ?? '').trim()
}

const DISPLAY_KEYS = [
  'mode',
  'sortField',
  'sortDir',
  'sorts',
  'columns',
  'groupBy',
  'tree',
  'wrap',
  'truncate',
  'query',
  'pageSize',
  'columnWidths',
  'filterTree',
] as const

export type ViewDisplayPatch = Partial<Pick<SavedView, (typeof DISPLAY_KEYS)[number]>>

export function viewDisplayKey(collectionPath: string, viewId: string) {
  return `fsdb.viewDisplay:${workspaceViewScope()}:${collectionPath}:${viewId}`
}

function pickDisplay(patch: Partial<SavedView>): ViewDisplayPatch {
  const next: ViewDisplayPatch = {}
  for (const key of DISPLAY_KEYS) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key]
  }
  return next
}

export function loadViewDisplay(collectionPath: string, viewId: string): ViewDisplayPatch {
  try {
    const raw = localStorage.getItem(viewDisplayKey(collectionPath, viewId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    return pickDisplay(parsed)
  } catch {
    return {}
  }
}

export function persistViewDisplay(collectionPath: string, viewId: string, patch: Partial<SavedView>) {
  try {
    const next = { ...loadViewDisplay(collectionPath, viewId), ...pickDisplay(patch) }
    localStorage.setItem(viewDisplayKey(collectionPath, viewId), JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/** 内置「全部 xx」不能当用户视图存整份，显示项（换行等）单独记。索引表没有分享，全部视图不按分享分组。 */
export function withViewDisplay(collectionPath: string, view: SavedView): SavedView {
  const overlay = loadViewDisplay(collectionPath, view.id)
  const painted = Object.keys(overlay).length
    ? {
        ...view,
        ...overlay,
        id: view.id,
        name: view.name,
        builtin: view.builtin,
        filters: view.filters,
        filterTree: view.builtin ? overlay.filterTree ?? view.filterTree : view.filterTree,
      }
    : view
  return normalizeSavedView({
    ...painted,
    ...(isIndexCollection(collectionPath) && isBuiltinAllViewId(view.id) ? { groupBy: '' } : {}),
  })
}
