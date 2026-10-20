/**
 * 根的登记处（同一页面里的页面块、右侧栏共用）+ IndexedDB 持久化。
 * 句柄根和只读文件副本写进 IndexedDB，刷新后可恢复；服务器页面快照仅缓存在内存中。
 * 草稿（未保存的修改）也存在 IndexedDB，刷新不丢。
 */
import { HandleRoot, SnapshotRoot, newRootId, type EntryKind, type FsRoot } from './fs.ts'

const DB_NAME = 'biu-local-files'
const DB_VERSION = 2
const ROOTS = 'roots'
const DRAFTS = 'drafts'
/** v2：只读副本每个文件单独一条，key = rootId\npath；根记录只存目录结构。 */
const FILES = 'files'

/** v1 旧格式：内容随根记录一起存。读取兼容，不再写入。 */
type StoredFile = { path: string; blob?: Blob; name?: string; type?: string; lastModified?: number }
type StoredEntry = { path: string; file?: true }
type StoredBlob = { blob: Blob; name: string; type: string; lastModified: number }
type StoredRoot = {
  id: string
  name: string
  kind: EntryKind
  handle?: unknown
  files?: StoredFile[]
  entries?: StoredEntry[]
  addedAt: number
}

function fileKey(rootId: string, path: string) {
  return `${rootId}\n${path}`
}

async function loadStoredFile(rootId: string, path: string): Promise<File> {
  const item = (await run(FILES, 'readonly', (s) => s.get(fileKey(rootId, path)))) as StoredBlob | undefined
  if (!item?.blob) throw new Error(`文件副本已丢失：${path}（请重新选择该文件夹）`)
  return new File([item.blob], item.name, { type: item.type, lastModified: item.lastModified })
}

function restoreRoot(item: StoredRoot): FsRoot | undefined {
  if (item.handle) return new HandleRoot(item.id, item.handle)
  if (item.entries) {
    return new SnapshotRoot(item.id, item.name, item.kind, item.entries, (path) => loadStoredFile(item.id, path))
  }
  if (!item.files) return undefined
  return new SnapshotRoot(item.id, item.name, item.kind, item.files.map((entry) => ({
    path: entry.path,
    ...(entry.blob ? { file: new File([entry.blob], entry.name ?? entry.path, {
      type: entry.type ?? '', lastModified: entry.lastModified ?? 0,
    }) } : {}),
  })))
}
export type Draft = { text: string; baseModified: number; savedAt: number }

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('浏览器不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ROOTS)) db.createObjectStore(ROOTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS)
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES)
    }
    req.onsuccess = () => {
      const db = req.result
      // 新版插件升级数据库时让出连接，避免另一个标签页一直卡住。
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onblocked = () => reject(new Error('其他标签页正在使用旧版本地文件插件，请关闭或刷新那些标签页后重试'))
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务未提交'))
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'))
  })
}

async function storedRoots(): Promise<StoredRoot[]> {
  try {
    return ((await run(ROOTS, 'readonly', (s) => s.getAll())) as StoredRoot[]) ?? []
  } catch {
    return []
  }
}

/* ---------------- 草稿 ---------------- */

const draftCache = new Map<string, Draft | null>()
const freshSnapshotIds = new Set<string>()

function draftKey(rootId: string, path: string) {
  return `${rootId}\n${path}`
}

export async function loadDraft(rootId: string, path: string): Promise<Draft | null> {
  const key = draftKey(rootId, path)
  if (draftCache.has(key)) return draftCache.get(key) ?? null
  if (freshSnapshotIds.has(rootId)) return null
  try {
    const draft = ((await run(DRAFTS, 'readonly', (s) => s.get(key))) as Draft | undefined) ?? null
    if (!draftCache.has(key)) draftCache.set(key, draft)
    return draftCache.get(key) ?? null
  } catch {
    return null
  }
}

export async function saveDraft(rootId: string, path: string, draft: Draft) {
  draftCache.set(draftKey(rootId, path), draft)
  try {
    await run(DRAFTS, 'readwrite', (s) => s.put(draft, draftKey(rootId, path)))
  } catch {
    /* 草稿只是兜底，失败不打断编辑 */
  }
}

export async function deleteDraft(rootId: string, path: string) {
  draftCache.set(draftKey(rootId, path), null)
  try {
    await run(DRAFTS, 'readwrite', (s) => s.delete(draftKey(rootId, path)))
  } catch {
    /* ignore */
  }
}

/* ---------------- 根登记 ---------------- */

const live = new Map<string, FsRoot>()
const listeners = new Set<() => void>()
let version = 0

function bump() {
  version += 1
  for (const fn of listeners) fn()
}

export function subscribeRoots(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function rootsVersion() {
  return version
}

/** 内存里的根（快照根、页面快照）。 */
export function addMemoryRoot(root: FsRoot) {
  live.set(root.id, root)
  bump()
  return root.id
}

export type SnapshotPersistence = {
  state: 'pending' | 'saved' | 'error'
  completed: number
  total: number
  error?: string
}

const persistence = new Map<string, SnapshotPersistence>()
const persistenceListeners = new Set<() => void>()
const saving = new Map<string, Promise<void>>()
const SAVE_START_DELAY_MS = 300
const SAVE_BATCH_FILES = 24
let saveQueue: Promise<void> = Promise.resolve()

export function snapshotPersistence(id: string) {
  return persistence.get(id)
}

export function subscribePersistence(fn: () => void) {
  persistenceListeners.add(fn)
  return () => { persistenceListeners.delete(fn) }
}

function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}

function updatePersistence(id: string, status?: SnapshotPersistence) {
  if (status) persistence.set(id, status)
  else persistence.delete(id)
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', warnBeforeUnload)
    if ([...persistence.values()].some((item) => item.state !== 'saved')) {
      window.addEventListener('beforeunload', warnBeforeUnload)
    }
  }
  for (const fn of persistenceListeners) fn()
}

/**
 * 逐个文件写入 FILES（每个文件一个小事务），最后写只含目录结构的根记录。
 * 这样不会把整个文件夹同时读进内存，也不会用一个大事务长时间锁住数据库；
 * 根记录最后才写，中途中断不会留下「看似可恢复、实则缺文件」的根。
 */
async function persistSnapshot(root: SnapshotRoot, progress?: (completed: number, total: number) => void, cancelled?: () => boolean) {
  try {
    const entries = root.entries()
    const total = entries.filter((entry) => entry.file || entry.stored).length
    let completed = 0
    const stored: StoredEntry[] = []
    for (const { path, file, stored: already } of entries) {
      if (cancelled?.()) return
      if (!file && !already) {
        stored.push({ path })
        continue
      }
      if (file) {
        const record: StoredBlob = {
          blob: new Blob([await file.arrayBuffer()], { type: file.type }),
          name: file.name, type: file.type, lastModified: file.lastModified,
        }
        if (cancelled?.()) return
        await run(FILES, 'readwrite', (s) => s.put(record, fileKey(root.id, path)))
      }
      stored.push({ path, file: true })
      completed += 1
      if (completed % 10 === 0 || completed === total) progress?.(completed, total)
      // 每个文件之后让出一次，前台打开文件的读取可以插队。
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (cancelled?.()) return
    await run(ROOTS, 'readwrite', (s) => s.put({
      id: root.id, name: root.name, kind: root.kind, entries: stored, addedAt: Date.now(),
    } satisfies StoredRoot))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`本地文件副本保存失败（请检查浏览器存储空间或隐私模式）：${reason}`)
  }
}

async function deleteStoredFiles(id: string) {
  const db = await openDb().catch(() => null)
  if (!db) return
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    try {
      const req = db.transaction(FILES, 'readonly').objectStore(FILES).getAllKeys()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  const mine = keys.filter((key) => typeof key === 'string' && key.startsWith(`${id}\n`))
  if (!mine.length) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(FILES, 'readwrite')
      const store = tx.objectStore(FILES)
      for (const key of mine) store.delete(key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function addSnapshotRoot(root: SnapshotRoot): Promise<string> {
  await persistSnapshot(root)
  return addMemoryRoot(root)
}

/** 先开放浏览，再在后台串行保存副本；保存失败不影响当前文件的读取。 */
export function openSnapshotRoot(root: SnapshotRoot): string {
  if (saving.has(root.id)) return root.id
  if (!live.has(root.id)) freshSnapshotIds.add(root.id)
  const total = root.entries().filter((entry) => entry.file || entry.stored).length
  updatePersistence(root.id, { state: 'pending', completed: 0, total })
  addMemoryRoot(root)
  const cancelled = () => live.get(root.id) !== root
  const task = saveQueue.then(async () => {
    // 先让界面展开目录、打开第一个文件，再开始占用磁盘读取。
    await new Promise((resolve) => setTimeout(resolve, SAVE_START_DELAY_MS))
    try {
      if (cancelled()) return
      await persistSnapshot(root, (completed, count) => {
        if (!cancelled()) updatePersistence(root.id, { state: 'pending', completed, total: count })
      }, cancelled)
      if (cancelled()) await deleteStoredFiles(root.id)
      else updatePersistence(root.id, { state: 'saved', completed: total, total })
    } catch (error) {
      if (!cancelled()) updatePersistence(root.id, {
        state: 'error', completed: persistence.get(root.id)?.completed ?? 0, total,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      saving.delete(root.id)
    }
  })
  saving.set(root.id, task)
  saveQueue = task
  return root.id
}

export async function waitForSnapshot(id: string) {
  await saving.get(id)
  const status = persistence.get(id)
  if (status?.state === 'error') throw new Error(status.error)
}

export function liveRoots() {
  return [...live.values()].filter((root) => !root.id.startsWith('snap:'))
}

/** 同一个文件夹拖两次复用同一个根，避免列表里堆重复项。 */
export async function addHandleRoot(handle: any): Promise<string> {
  for (const root of live.values()) {
    if (root instanceof HandleRoot) {
      try {
        if (await root.handle.isSameEntry(handle)) return root.id
      } catch {
        /* ignore */
      }
    }
  }
  for (const item of await storedRoots()) {
    try {
      if (await (item.handle as any).isSameEntry(handle)) {
        if (!live.has(item.id)) live.set(item.id, new HandleRoot(item.id, item.handle))
        bump()
        return item.id
      }
    } catch {
      /* ignore */
    }
  }
  const id = newRootId()
  const root = new HandleRoot(id, handle)
  live.set(id, root)
  try {
    await run(ROOTS, 'readwrite', (s) => s.put({ id, name: root.name, kind: root.kind, handle, addedAt: Date.now() } satisfies StoredRoot))
  } catch {
    /* 存不进去也能用，只是刷新后找不回 */
  }
  bump()
  return id
}

/* ---------------- 独立窗口借用原窗口的根 ---------------- */

/**
 * 「在独立窗口打开」会新开一个同源窗口（?popout=page-block），那里没有原窗口内存里的只读副本，
 * 句柄也还没授权。原窗口把自己的根登记到 window 上，新窗口通过 window.opener 直接借用：
 * 读写走原窗口已授权的句柄 / 已选中的文件，不需要再次授权，也不用等后台副本保存完。
 * 只在同源窗口之间可见；同源脚本本来就能读 IndexedDB 里的同一批数据，不扩大暴露面。
 */
const BRIDGE_KEY = '__biuLocalFilesRoots'
type RootBridge = { get: (id: string) => FsRoot | undefined }

if (typeof window !== 'undefined') {
  Object.defineProperty(window, BRIDGE_KEY, {
    configurable: true,
    value: { get: (id: string) => live.get(id) } satisfies RootBridge,
  })
}

function openerWindow(): Window | null {
  if (typeof window === 'undefined') return null
  try {
    const opener = window.opener as Window | null
    if (!opener || opener === window || opener.closed) return null
    // 跨源时读 origin 会抛错，直接放弃。
    if (opener.location.origin !== window.location.origin) return null
    return opener
  } catch {
    return null
  }
}

function borrowFromOpener(id: string): FsRoot | undefined {
  const opener = openerWindow()
  if (!opener) return undefined
  try {
    const bridge = (opener as unknown as Record<string, RootBridge | undefined>)[BRIDGE_KEY]
    const remote = bridge?.get(id)
    return remote ? new BorrowedRoot(remote, opener, () => storedRootById(id)) : undefined
  } catch {
    return undefined
  }
}

/** 原窗口关闭或刷新后，自动退回本窗口从 IndexedDB 恢复的副本。 */
class BorrowedRoot implements FsRoot {
  readonly id: string
  readonly name: string
  readonly kind: EntryKind
  readonly mode: FsRoot['mode']
  readonly source: FsRoot['source']
  write?: FsRoot['write']
  createFile?: FsRoot['createFile']
  createDir?: FsRoot['createDir']
  remove?: FsRoot['remove']
  private fallback: FsRoot | undefined

  constructor(private remote: FsRoot, private readonly opener: Window, private readonly restore: () => Promise<FsRoot | undefined>) {
    this.id = remote.id
    this.name = remote.name
    this.kind = remote.kind
    this.mode = remote.mode
    this.source = remote.source
    if (remote.write) this.write = (path, data) => this.call((root) => root.write!(path, data))
    if (remote.createFile) this.createFile = (dir, name) => this.call((root) => root.createFile!(dir, name))
    if (remote.createDir) this.createDir = (dir, name) => this.call((root) => root.createDir!(dir, name))
    if (remote.remove) this.remove = (path) => this.call((root) => root.remove!(path))
  }

  private alive() {
    try {
      return !this.opener.closed && Boolean(this.remote.id)
    } catch {
      return false
    }
  }

  private async call<T>(fn: (root: FsRoot) => Promise<T>): Promise<T> {
    if (!this.fallback && this.alive()) {
      try {
        return await fn(this.remote)
      } catch (error) {
        if (this.alive()) throw error
      }
    }
    this.fallback ??= await this.restore()
    if (!this.fallback) throw new Error(`原窗口已关闭，「${this.name}」在本窗口没有可用的副本，请在原页面重新打开`)
    return fn(this.fallback)
  }

  list(path: string) {
    return this.call((root) => root.list(path))
  }

  file(path: string) {
    return this.call((root) => root.file(path))
  }

  permission(write?: boolean) {
    return this.call((root) => root.permission(write))
  }

  requestPermission(write?: boolean) {
    return this.call((root) => root.requestPermission(write))
  }
}

async function storedRootById(id: string): Promise<FsRoot | undefined> {
  try {
    const item = (await run(ROOTS, 'readonly', (s) => s.get(id))) as StoredRoot | undefined
    if (!item) return undefined
    const root = restoreRoot(item)
    if (!root) return undefined
    // 旧格式（内容跟着根记录一起存）在后台改成「每文件一条」，并删掉那份大记录。
    if (item.files && root instanceof SnapshotRoot) void upgradeRoot(root)
    return root
  } catch {
    return undefined
  }
}

export async function rootById(id: string): Promise<FsRoot | undefined> {
  if (!id) return undefined
  const hit = live.get(id)
  if (hit) return hit
  const borrowed = borrowFromOpener(id)
  if (borrowed) {
    live.set(id, borrowed)
    return borrowed
  }
  const root = await storedRootById(id)
  if (!root) return undefined
  // 并发的两次查询只保留先到的那个实例。
  const existing = live.get(id)
  if (existing) return existing
  live.set(id, root)
  return root
}

async function upgradeRoot(root: SnapshotRoot) {
  if (saving.has(root.id)) return
  const task = saveQueue.then(async () => {
    await deleteStoredFiles(root.id)
    await persistSnapshot(root)
    if (live.get(root.id) === root) updatePersistence(root.id, { state: 'saved', completed: 0, total: 0 })
  }).catch(() => undefined)
  saveQueue = task
}

/** 本浏览器里所有能找到的根：内存 + IndexedDB。 */
export async function allRoots(): Promise<FsRoot[]> {
  try {
    const ids = await run(ROOTS, 'readonly', (s) => s.getAllKeys())
    for (const id of ids) {
      if (typeof id === 'string' && !live.has(id)) await rootById(id)
    }
  } catch {
    /* 存储不可用时仍允许浏览已打开的文件。 */
  }
  return liveRoots()
}

export async function forgetRoot(id: string) {
  live.delete(id)
  updatePersistence(id)
  try {
    await run(ROOTS, 'readwrite', (s) => s.delete(id))
  } catch {
    /* ignore */
  }
  await deleteStoredFiles(id)
  bump()
}
