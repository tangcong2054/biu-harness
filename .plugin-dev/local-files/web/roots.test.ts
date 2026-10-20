// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { SnapshotRoot } from './fs.ts'

afterEach(() => {
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

test('storage unavailable fails explicitly instead of returning an unpersisted root id', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const store = await freshStore()
  const root = new SnapshotRoot('lf-fail', 'a.md', 'file', [{ path: 'a.md', file: new File(['hello'], 'a.md') }])
  await expect(store.addSnapshotRoot(root)).rejects.toThrow('本地文件副本保存失败')
  expect(await store.rootById(root.id)).toBeUndefined()
})
