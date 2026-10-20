/**
 * 根的登记处（同一页面里的页面块、右侧栏共用）+ IndexedDB 持久化。
 * 句柄根和只读文件副本写进 IndexedDB，刷新后可恢复；服务器页面快照仅缓存在内存中。
 * 草稿（未保存的修改）也存在 IndexedDB，刷新不丢。
 */
import { HandleRoot, SnapshotRoot, newRootId, type EntryKind, type FsRoot } from './fs.ts'

const DB_NAME = 'biu-local-files'
const DB_VERSION = 1
const ROOTS = 'roots'
const DRAFTS = 'drafts'

type StoredFile = { path: string; blob?: Blob; name?: string; type?: string; lastModified?: number }
type StoredRoot = {
  id: string
  name: string
  kind: EntryKind
  handle?: unknown
  files?: StoredFile[]
  addedAt: number
}

function restoreRoot(item: StoredRoot): FsRoot | undefined {
  if (item.handle) return new HandleRoot(item.id, item.handle)
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
    }
    req.onsuccess = () => resolve(req.result)
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

function draftKey(rootId: string, path: string) {
  return `${rootId}\n${path}`
}

export async function loadDraft(rootId: string, path: string): Promise<Draft | null> {
  try {
    return ((await run(DRAFTS, 'readonly', (s) => s.get(draftKey(rootId, path)))) as Draft | undefined) ?? null
  } catch {
    return null
  }
}

export async function saveDraft(rootId: string, path: string, draft: Draft) {
  try {
    await run(DRAFTS, 'readwrite', (s) => s.put(draft, draftKey(rootId, path)))
  } catch {
    /* 草稿只是兜底，失败不打断编辑 */
  }
}

export async function deleteDraft(rootId: string, path: string) {
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

export async function addSnapshotRoot(root: SnapshotRoot): Promise<string> {
  const files = root.entries().map(({ path, file }): StoredFile => ({
    path,
    ...(file ? { blob: file.slice(), name: file.name, type: file.type, lastModified: file.lastModified } : {}),
  }))
  try {
    await run(ROOTS, 'readwrite', (s) => s.put({
      id: root.id, name: root.name, kind: root.kind, files, addedAt: Date.now(),
    } satisfies StoredRoot))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`本地文件副本保存失败（请检查浏览器存储空间或隐私模式）：${reason}`)
  }
  return addMemoryRoot(root)
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

export async function rootById(id: string): Promise<FsRoot | undefined> {
  if (!id) return undefined
  const hit = live.get(id)
  if (hit) return hit
  try {
    const item = (await run(ROOTS, 'readonly', (s) => s.get(id))) as StoredRoot | undefined
    if (!item) return undefined
    const root = restoreRoot(item)
    if (!root) return undefined
    live.set(item.id, root)
    return root
  } catch {
    return undefined
  }
}

/** 本浏览器里所有能找到的根：内存 + IndexedDB。 */
export async function allRoots(): Promise<FsRoot[]> {
  for (const item of await storedRoots()) {
    if (live.has(item.id)) continue
    const root = restoreRoot(item)
    if (root) live.set(item.id, root)
  }
  return [...live.values()].filter((root) => !root.id.startsWith('snap:'))
}

export async function forgetRoot(id: string) {
  live.delete(id)
  try {
    await run(ROOTS, 'readwrite', (s) => s.delete(id))
  } catch {
    /* ignore */
  }
  bump()
}
