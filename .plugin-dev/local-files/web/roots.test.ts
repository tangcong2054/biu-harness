// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { SnapshotRoot } from './fs.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function freshStore() {
  vi.resetModules()
  return import('./roots.ts')
}

test('readonly folder and Markdown bytes survive a module reload with the same root id', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const root = new SnapshotRoot('lf-folder', 'project', 'directory', [
    { path: 'empty' },
    { path: 'docs/readme.md', file: new File(['# 标题\n正文'], 'readme.md', { type: 'text/markdown', lastModified: 123456 }) },
    { path: 'logo.png', file: new File([new Uint8Array([0, 255, 127])], 'logo.png', { type: 'image/png', lastModified: 321 }) },
  ])
  expect(await store.addSnapshotRoot(root)).toBe('lf-folder')
  await store.saveDraft(root.id, 'docs/readme.md', { text: '# 未保存', baseModified: 123456, savedAt: 999 })
  const reloaded = await freshStore()
  const restored = await reloaded.rootById(root.id)
  expect(restored?.source).toBe('snapshot')
  expect(restored?.mode).toBe('readonly')
  expect(await restored!.list('empty')).toEqual([])
  expect((await restored!.list('')).map((entry) => entry.name)).toEqual(['docs', 'empty', 'logo.png'])
  const file = await restored!.file('docs/readme.md')
  expect(await file.text()).toBe('# 标题\n正文')
  expect(file.name).toBe('readme.md')
  expect(file.type).toBe('text/markdown')
  expect(file.lastModified).toBe(123456)
  expect([...new Uint8Array(await (await restored!.file('logo.png')).arrayBuffer())]).toEqual([0, 255, 127])
  expect(await reloaded.loadDraft(root.id, 'docs/readme.md')).toEqual({ text: '# 未保存', baseModified: 123456, savedAt: 999 })
})

test('standalone file appears in sidebar after reload; forgetting it removes the persisted copy', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const root = new SnapshotRoot('lf-single', 'a.md', 'file', [{ path: 'a.md', file: new File(['hello'], 'a.md') }])
  await store.addSnapshotRoot(root)
  const reloaded = await freshStore()
  expect((await reloaded.allRoots()).map((item) => item.id)).toEqual(['lf-single'])
  expect(await (await (await reloaded.rootById('lf-single'))!.file('a.md')).text()).toBe('hello')
  await reloaded.forgetRoot('lf-single')
  const again = await freshStore()
  expect(await again.rootById('lf-single')).toBeUndefined()
  expect(await again.allRoots()).toEqual([])
})

test('server page snapshots stay memory-only', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  store.addMemoryRoot(new SnapshotRoot('snap:/api/db/file/a.md', 'a.md', 'file', [{ path: 'a.md', file: new File(['page'], 'a.md') }]))
  expect(await store.allRoots()).toEqual([])
  const reloaded = await freshStore()
  expect(await reloaded.rootById('snap:/api/db/file/a.md')).toBeUndefined()
})

test('snapshot persistence reads bytes without relying on the original disk-backed slice', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const file = new File(['disk content'], 'a.md')
  const slice = vi.spyOn(file, 'slice').mockImplementation(() => { throw new Error('disk-backed slice unavailable') })
  await store.addSnapshotRoot(new SnapshotRoot('lf-bytes', 'a.md', 'file', [{ path: 'a.md', file }]))
  expect(slice).not.toHaveBeenCalled()
  const reloaded = await freshStore()
  expect(await (await (await reloaded.rootById('lf-bytes'))!.file('a.md')).text()).toBe('disk content')
})

test('file read errors are surfaced and do not register an unpersisted root', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const file = new File(['hello'], 'a.md')
  vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('file access lost'))
  await expect(store.addSnapshotRoot(new SnapshotRoot('lf-read-fail', 'a.md', 'file', [{ path: 'a.md', file }]))).rejects.toThrow('file access lost')
  expect(await store.rootById('lf-read-fail')).toBeUndefined()
})

test('opening a slow file returns immediately, warns on refresh, and preserves bytes after background saving', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  const store = await freshStore()
  let finishRead!: (value: ArrayBuffer) => void
  const file = new File(['slow content'], 'slow.md')
  const read = vi.spyOn(file, 'arrayBuffer').mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
  const root = new SnapshotRoot('lf-slow', 'slow.md', 'file', [{ path: 'slow.md', file }])
  expect(store.openSnapshotRoot(root)).toBe(root.id)
  expect(await store.rootById(root.id)).toBe(root)
  expect(await (await root.file('slow.md')).text()).toBe('slow content')
  expect(store.snapshotPersistence(root.id)?.state).toBe('pending')
  const before = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(before)
  expect(before.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  finishRead(new TextEncoder().encode('slow content').buffer)
  await store.waitForSnapshot(root.id)
  expect(store.snapshotPersistence(root.id)).toEqual({ state: 'saved', completed: 1, total: 1 })
  const after = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(after)
  expect(after.defaultPrevented).toBe(false)
  const reloaded = await freshStore()
  expect(await (await (await reloaded.rootById(root.id))!.file('slow.md')).text()).toBe('slow content')
})

test('background saving failure remains visible without preventing reading and can be retried', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const file = new File(['hello'], 'a.md')
  const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValueOnce(new Error('file access lost'))
  const root = new SnapshotRoot('lf-retry', 'a.md', 'file', [{ path: 'a.md', file }])
  store.openSnapshotRoot(root)
  await expect(store.waitForSnapshot(root.id)).rejects.toThrow('file access lost')
  expect(store.snapshotPersistence(root.id)?.state).toBe('error')
  expect(await (await (await store.rootById(root.id))!.file('a.md')).text()).toBe('hello')
  read.mockRestore()
  store.openSnapshotRoot(root)
  await store.waitForSnapshot(root.id)
  expect(store.snapshotPersistence(root.id)?.state).toBe('saved')
})

test('background saves are serialized and forgotten queued roots are not resurrected', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const firstFile = new File(['first'], 'first.md')
  let finishRead!: (value: ArrayBuffer) => void
  const firstRead = vi.spyOn(firstFile, 'arrayBuffer').mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
  const secondFile = new File(['second'], 'second.md')
  const secondRead = vi.spyOn(secondFile, 'arrayBuffer')
  store.openSnapshotRoot(new SnapshotRoot('lf-first', 'first.md', 'file', [{ path: 'first.md', file: firstFile }]))
  store.openSnapshotRoot(new SnapshotRoot('lf-second', 'second.md', 'file', [{ path: 'second.md', file: secondFile }]))
  await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(1))
  expect(secondRead).not.toHaveBeenCalled()
  await store.forgetRoot('lf-second')
  finishRead(new TextEncoder().encode('first').buffer)
  await store.waitForSnapshot('lf-first')
  await store.waitForSnapshot('lf-second')
  expect(secondRead).not.toHaveBeenCalled()
  expect(store.snapshotPersistence('lf-second')).toBeUndefined()
  const reloaded = await freshStore()
  expect(await reloaded.rootById('lf-second')).toBeUndefined()
})

test('listing roots does not clone all saved file contents again', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  await store.addSnapshotRoot(new SnapshotRoot('lf-list', 'a.md', 'file', [{ path: 'a.md', file: new File(['hello'], 'a.md') }]))
  const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')
  const get = vi.spyOn(IDBObjectStore.prototype, 'get')
  expect((await store.allRoots()).map((root) => root.id)).toEqual(['lf-list'])
  expect((await store.allRoots()).map((root) => root.id)).toEqual(['lf-list'])
  expect(getAll).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
})

test('a newly opened file checks drafts without waiting for browser storage', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const root = new SnapshotRoot('lf-draft-fast', 'a.md', 'file', [{ path: 'a.md', file: new File(['hello'], 'a.md') }])
  store.openSnapshotRoot(root)
  const get = vi.spyOn(IDBObjectStore.prototype, 'get')
  expect(await store.loadDraft(root.id, 'a.md')).toBeNull()
  expect(get).not.toHaveBeenCalled()
  const draft = { text: 'changed', baseModified: 0, savedAt: 123 }
  const savingDraft = store.saveDraft(root.id, 'a.md', draft)
  expect(await store.loadDraft(root.id, 'a.md')).toEqual(draft)
  await savingDraft
  await store.waitForSnapshot(root.id)
  const reloaded = await freshStore()
  expect(await reloaded.loadDraft(root.id, 'a.md')).toEqual(draft)
})

test('storage unavailable fails explicitly instead of returning an unpersisted root id', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const store = await freshStore()
  const root = new SnapshotRoot('lf-fail', 'a.md', 'file', [{ path: 'a.md', file: new File(['hello'], 'a.md') }])
  await expect(store.addSnapshotRoot(root)).rejects.toThrow('本地文件副本保存失败')
  expect(await store.rootById(root.id)).toBeUndefined()
})

function openDb(name = 'biu-local-files', version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = version == null ? indexedDB.open(name) : indexedDB.open(name, version)
    // 只用于构造 v1 旧库：当时只有 roots + drafts。
    req.onupgradeneeded = () => {
      if (version !== 1) return
      req.result.createObjectStore('roots', { keyPath: 'id' })
      req.result.createObjectStore('drafts')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function readAll(db: IDBDatabase, store: string) {
  return new Promise<Array<{ key: unknown; value: unknown }>>((resolve, reject) => {
    const keysReq = db.transaction(store, 'readonly').objectStore(store).getAllKeys()
    keysReq.onsuccess = () => {
      const keys = keysReq.result
      const valuesReq = db.transaction(store, 'readonly').objectStore(store).getAll()
      valuesReq.onsuccess = () => resolve(keys.map((key, i) => ({ key, value: valuesReq.result[i] })))
      valuesReq.onerror = () => reject(valuesReq.error)
    }
    keysReq.onerror = () => reject(keysReq.error)
  })
}

test('restoring a folder does not clone every file, and files load one at a time', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  const root = new SnapshotRoot('lf-lazy', 'project', 'directory', [
    { path: 'a.md', file: new File(['A'], 'a.md') },
    { path: 'b.md', file: new File(['B'], 'b.md') },
    { path: 'sub/c.txt', file: new File(['C'], 'c.txt') },
  ])
  await store.addSnapshotRoot(root)

  // 根记录只留目录结构，内容按 path 分条存在 files 里。
  const db = await openDb()
  const roots = await readAll(db, 'roots')
  expect(roots).toHaveLength(1)
  expect((roots[0].value as { files?: unknown }).files).toBeUndefined()
  const stored = (roots[0].value as { entries: Array<{ path: string; file?: true }> }).entries
  expect(stored.filter((entry) => entry.file).map((entry) => entry.path)).toEqual(['a.md', 'b.md', 'sub/c.txt'])
  expect(stored.find((entry) => entry.path === 'sub')).toEqual({ path: 'sub' })
  expect((await readAll(db, 'files')).map((item) => item.key)).toEqual(['lf-lazy\na.md', 'lf-lazy\nb.md', 'lf-lazy\nsub/c.txt'])
  db.close()

  const reloaded = await freshStore()
  const get = vi.spyOn(IDBObjectStore.prototype, 'get')
  const restored = await reloaded.rootById('lf-lazy')
  // 恢复根只读一条只含目录结构的根记录，不碰任何文件内容。
  expect(get.mock.calls.map((call) => call[0])).toEqual(['lf-lazy'])
  expect((await restored!.list('')).map((entry) => entry.name)).toEqual(['sub', 'a.md', 'b.md'])
  expect(await (await restored!.file('b.md')).text()).toBe('B')
  expect(get.mock.calls.map((call) => call[0])).toEqual(['lf-lazy', 'lf-lazy\nb.md'])
})

test('version 1 roots migrate to per-file storage in the background', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const legacy = await openDb('biu-local-files', 1)
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('roots', 'readwrite')
    tx.objectStore('roots').put({
      id: 'lf-legacy', name: 'old.md', kind: 'file', addedAt: 1,
      files: [{ path: 'old.md', blob: new Blob(['old']), name: 'old.md', type: 'text/markdown', lastModified: 5 }],
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  legacy.close()

  const store = await freshStore()
  expect(await (await (await store.rootById('lf-legacy'))!.file('old.md')).text()).toBe('old')
  await vi.waitFor(async () => {
    const db = await openDb()
    const record = (await readAll(db, 'roots'))[0].value as { files?: unknown; entries?: unknown }
    db.close()
    expect(record.files).toBeUndefined()
    expect(record.entries).toEqual([{ path: 'old.md', file: true }])
  })
  const reloaded = await freshStore()
  expect(await (await (await reloaded.rootById('lf-legacy'))!.file('old.md')).text()).toBe('old')
})

function fakeWindows() {
  const opener = { closed: false, location: { origin: 'https://biu.test' } } as Record<string, unknown> & { closed: boolean }
  const popout = { opener, location: { origin: 'https://biu.test' }, addEventListener() {}, removeEventListener() {} }
  return { opener, popout }
}

test('a popout window borrows the opener window root (no re-pick, no new permission prompt)', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const { opener, popout } = fakeWindows()
  const remote = new SnapshotRoot('lf-pop', 'project', 'directory', [{ path: 'a.md', file: new File(['from opener'], 'a.md') }])
  opener.__biuLocalFilesRoots = { get: (id: string) => (id === remote.id ? remote : undefined) }
  vi.stubGlobal('window', popout)
  const store = await freshStore()
  const root = await store.rootById('lf-pop')
  expect(root).toBeDefined()
  expect(root!.source).toBe('snapshot')
  expect(await root!.permission()).toBe('granted')
  expect((await root!.list('')).map((entry) => entry.name)).toEqual(['a.md'])
  expect(await (await root!.file('a.md')).text()).toBe('from opener')
  expect(await store.rootById('lf-pop')).toBe(root)
})

test('borrowed root falls back to this window copy after the opener window closes', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const saver = await freshStore()
  await saver.addSnapshotRoot(new SnapshotRoot('lf-pop2', 'a.md', 'file', [{ path: 'a.md', file: new File(['saved copy'], 'a.md') }]))
  const { opener, popout } = fakeWindows()
  const remote = new SnapshotRoot('lf-pop2', 'a.md', 'file', [{ path: 'a.md', file: new File(['live'], 'a.md') }])
  opener.__biuLocalFilesRoots = { get: () => remote }
  vi.stubGlobal('window', popout)
  const store = await freshStore()
  const root = await store.rootById('lf-pop2')
  expect(await (await root!.file('a.md')).text()).toBe('live')
  opener.closed = true
  expect(await (await root!.file('a.md')).text()).toBe('saved copy')
})

test('cross-origin or missing opener is ignored and IndexedDB is used', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const { opener, popout } = fakeWindows()
  opener.location = { get origin(): string { throw new Error('cross-origin') } }
  opener.__biuLocalFilesRoots = { get: () => { throw new Error('must not be called') } }
  vi.stubGlobal('window', popout)
  const store = await freshStore()
  expect(await store.rootById('lf-none')).toBeUndefined()
})

test('forgetting a root also deletes its per-file copies', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = await freshStore()
  await store.addSnapshotRoot(new SnapshotRoot('lf-clean', 'p', 'directory', [
    { path: 'a.md', file: new File(['A'], 'a.md') },
    { path: 'b.md', file: new File(['B'], 'b.md') },
  ]))
  await store.forgetRoot('lf-clean')
  const db = await openDb()
  expect(await readAll(db, 'files')).toEqual([])
  db.close()
})
