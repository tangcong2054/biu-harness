import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAndMigrateBiu, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { SavedViewMutation } from '@biu/host-plugin-loader/metadata-runtime'
import { SavedViewsStore } from './saved-views.ts'
import { SharesStore } from './shares-store.ts'

const dirs: string[] = []
const connections: Array<ReturnType<typeof openAndMigrateBiu>> = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'saved-view-mutations-'))
  dirs.push(dir)
  const file = join(dir, 'biu.sqlite')
  const first = new SavedViewsStore().open(file)
  const second = new SavedViewsStore().open(file)
  const shares = new SharesStore().open(file)
  const db = openAndMigrateBiu(file, { foreignKeys: false })
  connections.push(db)
  return { first, second, shares, db, file }
}
const create = (id: string, name = id): SavedViewMutation => ({ type: 'create', collection: '/pages', id, view: { name } })
const update = (id: string, expectedRevision: number, name = id): SavedViewMutation => ({ type: 'update', collection: '/pages', id, expectedRevision, view: { name } })
const remove = (id: string, expectedRevision: number): SavedViewMutation => ({ type: 'delete', collection: '/pages', id, expectedRevision })

describe('saved view store incremental SQLite persistence', () => {
  it('keeps changes from another connection even when its cached list is stale', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    expect(f.second.viewsFor('/pages')).toEqual([])
    await f.second.mutate('owner', [create('b')])
    await f.first.mutate('owner', [update('a', 1, 'renamed')])
    await f.second.prepare()
    expect(f.second.viewsFor('/pages')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', name: 'renamed', revision: 2 }),
      expect.objectContaining({ id: 'b', revision: 1 }),
    ]))
    expect(f.second.viewsFor('/pages')).toHaveLength(2)
  })

  it('rejects a stale update and leaves both the database and cache unchanged', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    await f.second.prepare()
    await f.first.mutate('owner', [update('a', 1, 'latest')])
    await expect(f.second.mutate('owner', [create('b'), update('a', 1, 'stale')]))
      .rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT', status: 409 })
    expect(f.second.viewsFor('/pages')).toEqual([expect.objectContaining({ id: 'a', name: 'a', revision: 1 })])
    await f.second.prepare()
    expect(f.second.viewsFor('/pages')).toEqual([expect.objectContaining({ id: 'a', name: 'latest', revision: 2 })])
    await f.second.mutate('owner', [update('a', 2, 'retry')])
    expect(f.second.viewsFor('/pages')[0]).toMatchObject({ name: 'retry', revision: 3 })
  })

  it('keeps tombstones across reopen while hiding them from every store read', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    await f.first.mutate('owner', [remove('a', 1)])
    const reopened = new SavedViewsStore().open(f.file)
    expect(reopened.viewsFor('/pages')).toEqual([])
    expect(reopened.rows([], 'owner')).toEqual([])
    const row = f.db.prepare('SELECT payload_json FROM saved_views WHERE view_id = ?').get('a') as { payload_json: string }
    expect(JSON.parse(row.payload_json)).toEqual({ id: 'a', createdBy: 'owner', revision: 2, deletedAt: expect.any(Number) })
    for (const mutation of [create('a'), update('a', 1), update('a', 2)]) {
      await expect(reopened.mutate('owner', [mutation])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    }
  })

  it('atomically revokes local view links while preserving record links and unrelated views', async () => {
    const f = fixture()
    await f.first.mutate('', [create('a'), create('b')])
    const target = f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'a' })
    const record = f.shares.upsert({ kind: 'record', collection: '/pages', viewId: 'a', recordId: 'record' })
    const other = f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'b' })
    await f.first.mutate('', [remove('a', 1)])
    expect(f.shares.get(target.token)).toBeNull()
    expect(f.shares.get(record.token)).not.toBeNull()
    expect(f.shares.get(other.token)).not.toBeNull()
  })

  it('rolls back both tables when share deletion fails', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    const share = f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'a' })
    f.db.exec("CREATE TRIGGER reject_share_delete BEFORE DELETE ON shares BEGIN SELECT RAISE(ABORT, 'share locked'); END")
    await expect(f.first.mutate('owner', [create('b'), remove('a', 1)])).rejects.toThrow('share locked')
    expect(f.first.viewsFor('/pages')).toEqual([expect.objectContaining({ id: 'a', revision: 1 })])
    await f.second.prepare()
    expect(f.second.viewsFor('/pages')).toEqual([expect.objectContaining({ id: 'a', revision: 1 })])
    expect(f.shares.get(share.token)).not.toBeNull()
  })

  it('uses workspace-scoped view keys and denies foreign owners and anonymous scoped writes', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws-a', () => f.first.mutate('owner', [create('same', 'A')]))
    await runWithRequestWorkspace('ws-b', () => f.first.mutate('other', [create('same', 'B')]))
    await runWithRequestWorkspace('ws-a', async () => {
      await expect(f.first.mutate('other', [update('same', 1)])).rejects.toMatchObject({ code: 'SAVED_VIEW_DENIED' })
      await expect(f.first.mutate('', [create('anonymous')])).rejects.toMatchObject({ code: 'SAVED_VIEW_DENIED' })
      expect(f.first.viewsFor('/pages', 'owner')[0]?.name).toBe('A')
    })
    await runWithRequestWorkspace('ws-b', async () => {
      expect(f.first.viewsFor('/pages', 'other')[0]?.name).toBe('B')
      await f.first.mutate('other', [remove('same', 1)])
      expect(f.first.viewsFor('/pages')).toEqual([])
    })
  })

  it('scopes local view links by workspace and also clears legacy unscoped links', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws-a', () => f.first.mutate('owner', [create('a')]))
    const own = await runWithRequestWorkspace('ws-a', () => f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'a' }))
    const other = await runWithRequestWorkspace('ws-b', () => f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'a' }))
    const scoped = await runWithRequestWorkspace('ws-a', () => f.shares.upsert({ kind: 'view', collection: '/pages', viewId: 'builtin-scope:shared:a' }))
    f.db.prepare("INSERT INTO shares (token, workspace_id, kind, collection, view_id, created_at, updated_at) VALUES ('legacy', '', 'view', '/pages', 'a', 1, 1)").run()
    expect(own.token).not.toBe(other.token)
    await runWithRequestWorkspace('ws-a', () => f.first.mutate('owner', [remove('a', 1)]))
    expect(f.shares.get(own.token)).toBeNull()
    expect(f.shares.get(scoped.token)).toBeNull()
    expect(f.shares.get('legacy')).toBeNull()
    expect(f.shares.get(other.token)).not.toBeNull()
  })

  it('keeps share lookups, lists and revocation inside the request workspace', async () => {
    const f = fixture()
    const a = await runWithRequestWorkspace('ws-a', () => f.shares.upsert({ kind: 'record', collection: '/pages', recordId: 'p1' }))
    const b = await runWithRequestWorkspace('ws-b', () => f.shares.upsert({ kind: 'record', collection: '/pages', recordId: 'p1' }))
    expect(a.token).not.toBe(b.token)
    await runWithRequestWorkspace('ws-a', async () => {
      expect(f.shares.findRecord('/pages', 'p1')?.token).toBe(a.token)
      expect(f.shares.list().map((row) => row.token)).toEqual([a.token])
      f.shares.revokeRecord('/pages', 'p1')
      f.shares.revoke(b.token)
    })
    expect(f.shares.get(a.token)).toBeNull()
    // 公开访问按 token 读取，不受空间限制；但别的空间撤销不了它。
    expect(f.shares.get(b.token)).not.toBeNull()
    await runWithRequestWorkspace('ws-b', async () => {
      expect(f.shares.recordIds('/pages')).toEqual(new Set(['p1']))
    })
  })

  it('blocks legacy full writes before changing memory, including after reopening', async () => {
    const f = fixture()
    const pending = f.first.mutate('owner', [create('a')])
    expect(() => f.first.replace('/pages', [])).toThrow('incremental')
    await pending
    const reopened = new SavedViewsStore().open(f.file)
    const before = reopened.viewsFor('/pages')
    for (const write of [
      () => reopened.replace('/pages', []),
      () => reopened.replaceOwned('/pages', [], 'owner'),
    ]) expect(write).toThrow('incremental')
    expect(reopened.viewsFor('/pages')).toEqual(before)
  })

  it('uses incremental create/update/remove APIs after versions already exist', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    const tables = [{ id: 'pages', path: '/pages', kind: 'collection' as const, label: 'Pages', view: null }]
    const [created] = await f.first.createMany([{ tablePath: '/pages', viewId: 'b', title: 'B' }], tables, 'owner')
    expect(created).toMatchObject({ id: 'pages::b', revision: 1 })
    const changed = await f.first.write('pages::a', { name: 'updated', expectedRevision: 1 }, 'owner')
    expect(changed).toMatchObject({ title: 'updated', revision: 2 })
    await expect(f.first.write('pages::a', { name: 'stale', expectedRevision: 1 }, 'owner'))
      .rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    await f.first.removeMany(['pages::b'], 'owner')
    expect(f.first.viewsFor('/pages')).toEqual([expect.objectContaining({ id: 'a', name: 'updated', revision: 2 })])
    await f.second.prepare()
    expect(f.second.viewsFor('/pages')).toEqual(f.first.viewsFor('/pages'))
  })

  it('rejects stale snapshot updates and deletes through the collection adapters', async () => {
    const f = fixture()
    await f.first.mutate('owner', [create('a')])
    await f.second.prepare()
    await f.first.write('pages::a', { name: 'latest' }, 'owner')
    await expect(f.second.write('pages::a', { name: 'stale' }, 'owner')).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    await expect(f.second.removeMany(['pages::a'], 'owner')).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    await f.second.prepare()
    expect(f.second.viewsFor('/pages')[0]).toMatchObject({ name: 'latest', revision: 2 })
  })

  it('allocates distinct ids for simultaneous automatic creates at the same timestamp', async () => {
    const f = fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const tables = [{ id: 'pages', path: '/pages', kind: 'collection' as const, label: 'Pages', view: null }]
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        f.first.createMany([{ tablePath: '/pages', title: 'Concurrent' }], tables, 'owner')))
      expect(new Set(results.map(([row]) => row?.viewId)).size).toBe(10)
      expect(f.first.viewsFor('/pages')).toHaveLength(10)
    } finally {
      clock.mockRestore()
    }
  })

  it('claims ownerless legacy data with revision zero and supports local anonymous creation', async () => {
    const f = fixture()
    f.first.replace('/pages', [{ id: 'old', name: 'legacy' }])
    const results = await f.first.mutate('', [update('old', 0, 'claimed'), create('new')])
    expect(results.map((row) => row.view.revision)).toEqual([1, 1])
    expect(results.map((row) => row.view.createdBy)).toEqual(['', ''])
  })
})
