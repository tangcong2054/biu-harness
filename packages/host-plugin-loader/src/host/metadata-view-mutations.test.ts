import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentRequestWorkspaceId, openAndMigrateBiu, runWithRequestWorkspace } from './data-dir.ts'
import { SqliteMetadataRuntime, type MetadataRepository, type SavedViewMutation } from './metadata-runtime.ts'

const databases: Array<ReturnType<typeof openAndMigrateBiu>> = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function database() {
  const db = openAndMigrateBiu(':memory:', { foreignKeys: false })
  databases.push(db)
  return db
}
const create = (id: string): SavedViewMutation => ({ type: 'create', collection: '/pages', id, view: { name: id } })
const update = (id: string, expectedRevision: number): SavedViewMutation => ({ type: 'update', collection: '/pages', id, expectedRevision, view: { name: `${id}-updated` } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const authority = database()
  const local = database()
  const authoritativeRuntime = new SqliteMetadataRuntime('sqlite', null, () => authority, ['saved_views'])
  const repository = {
    list: vi.fn(async (table: string) => {
      expect(table).toBe('saved_views')
      return authority.prepare('SELECT * FROM saved_views WHERE workspace_id = ?').all(currentRequestWorkspaceId()) as Array<Record<string, unknown>>
    }),
    replaceTable: vi.fn(async () => { throw new Error('Full replacement must not be called') }),
    mutateSavedViews: vi.fn((account: string, mutations: readonly SavedViewMutation[]) => authoritativeRuntime.mutateSavedViews(account, mutations)),
  } satisfies MetadataRepository
  const runtime = new SqliteMetadataRuntime('mysql', repository, () => local, ['saved_views'])
  const read = (db = local, workspaceId = 'ws', id = 'a') => {
    const row = db.prepare('SELECT payload_json FROM saved_views WHERE workspace_id = ? AND view_id = ?').get(workspaceId, id) as { payload_json: string } | undefined
    return row ? JSON.parse(row.payload_json) : null
  }
  return { authority, local, repository, runtime, authoritativeRuntime, read }
}

describe('metadata runtime incremental view channel', () => {
  it('uses the dedicated repository and publishes only committed rows to the overlay', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      await f.runtime.prepare()
      await f.runtime.mutateSavedViews('owner', [create('a')])
      expect(f.read()).toMatchObject({ id: 'a', createdBy: 'owner', revision: 1 })
      expect(f.repository.replaceTable).not.toHaveBeenCalled()
      expect(() => f.runtime.changed('saved_views')).toThrow('incremental')
    })
  })

  it('does not publish failed changes and accepts later writes after a conflict', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      await f.runtime.mutateSavedViews('owner', [create('a')])
      await expect(f.runtime.mutateSavedViews('owner', [update('a', 0)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
      expect(f.read().revision).toBe(1)
      await f.runtime.mutateSavedViews('owner', [update('a', 1)])
      await f.runtime.flush()
      expect(f.read().revision).toBe(2)
    })
  })

  it('serializes pending mutations and snapshots nested input before queuing', async () => {
    const f = fixture()
    const gate = deferred<void>()
    const started = deferred<void>()
    f.repository.mutateSavedViews.mockImplementationOnce(async (account, input) => {
      started.resolve()
      await gate.promise
      return f.authoritativeRuntime.mutateSavedViews(account, input)
    })
    await runWithRequestWorkspace('ws', async () => {
      const mutation = { ...create('a'), view: { name: 'original', filters: { title: 'before' } } } as SavedViewMutation & { view: { name: string; filters: { title: string } } }
      const first = f.runtime.mutateSavedViews('owner', [mutation])
      mutation.view.filters.title = 'after'
      const second = f.runtime.mutateSavedViews('owner', [update('a', 1)])
      await started.promise
      expect(f.repository.mutateSavedViews).toHaveBeenCalledTimes(1)
      expect(f.read()).toBeNull()
      gate.resolve()
      const firstResults = await first
      expect(firstResults[0]?.view.filters).toEqual({ title: 'before' })
      await second
      expect(f.read()).toMatchObject({ name: 'a-updated', revision: 2 })
    })
  })

  it('preserves the workspace for queued requests from different contexts', async () => {
    const f = fixture()
    const a = runWithRequestWorkspace('ws-a', () => f.runtime.mutateSavedViews('owner', [create('a')]))
    const b = runWithRequestWorkspace('ws-b', () => f.runtime.mutateSavedViews('other', [create('a')]))
    await Promise.all([a, b])
    expect(f.read(f.local, 'ws-a')).toMatchObject({ createdBy: 'owner' })
    expect(f.read(f.local, 'ws-b')).toMatchObject({ createdBy: 'other' })
    expect(f.read(f.authority, 'ws-a')).toMatchObject({ createdBy: 'owner' })
    expect(f.read(f.authority, 'ws-b')).toMatchObject({ createdBy: 'other' })
  })

  it('discards a reload snapshot captured before a concurrent mutation committed', async () => {
    const f = fixture()
    const captured = deferred<void>()
    const gate = deferred<void>()
    f.repository.list.mockImplementationOnce(async () => {
      captured.resolve()
      await gate.promise
      return []
    })
    await runWithRequestWorkspace('ws', async () => {
      const reload = f.runtime.prepare()
      await captured.promise
      await f.runtime.mutateSavedViews('owner', [create('a')])
      gate.resolve()
      await reload
      expect(f.read()).toMatchObject({ id: 'a', revision: 1 })
      expect(f.repository.list).toHaveBeenCalledTimes(2)
    })
  })

  it('marks an overlay failure as already committed and allows authoritative reload', async () => {
    const f = fixture()
    f.local.exec("CREATE TRIGGER reject_overlay BEFORE INSERT ON saved_views BEGIN SELECT RAISE(ABORT, 'overlay unavailable'); END")
    await runWithRequestWorkspace('ws', async () => {
      await expect(f.runtime.mutateSavedViews('owner', [create('a')])).rejects.toMatchObject({ code: 'SAVED_VIEW_CACHE_FAILED', committed: true })
      expect(f.read(f.authority)).toMatchObject({ id: 'a', revision: 1 })
      expect(f.read()).toBeNull()
      f.local.exec('DROP TRIGGER reject_overlay')
      await f.runtime.prepare()
      expect(f.read()).toMatchObject({ id: 'a', revision: 1 })
    })
  })

  it('keeps a failed overlay invalid until a full reload, including after unrelated writes', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      await f.runtime.mutateSavedViews('owner', [create('a')])
      f.local.exec("CREATE TRIGGER reject_overlay BEFORE INSERT ON saved_views BEGIN SELECT RAISE(ABORT, 'overlay unavailable'); END")
      await expect(f.runtime.mutateSavedViews('owner', [{ type: 'delete', collection: '/pages', id: 'a', expectedRevision: 1 }]))
        .rejects.toMatchObject({ committed: true })
      expect(f.runtime.savedViewCacheValid).toBe(false)
      await f.runtime.mutateSavedViews('owner', [])
      expect(f.runtime.savedViewCacheValid).toBe(false)
      f.local.exec('DROP TRIGGER reject_overlay')
      await f.runtime.mutateSavedViews('owner', [create('b')])
      expect(f.runtime.savedViewCacheValid).toBe(false)
      await f.runtime.prepare()
      expect(f.runtime.savedViewCacheValid).toBe(true)
      expect(f.read()).toHaveProperty('deletedAt')
    })
  })

  it('reports a database factory failure after commit without hiding that commit', async () => {
    const f = fixture()
    let unavailable = true
    const runtime = new SqliteMetadataRuntime('mysql', f.repository, () => {
      if (unavailable) throw new Error('local database unavailable')
      return f.local
    }, ['saved_views'])
    await runWithRequestWorkspace('ws', async () => {
      await expect(runtime.mutateSavedViews('owner', [create('a')])).rejects.toMatchObject({ code: 'SAVED_VIEW_CACHE_FAILED', committed: true })
      expect(f.read(f.authority)).toMatchObject({ revision: 1 })
      expect(runtime.savedViewCacheValid).toBe(false)
      unavailable = false
      await runtime.prepare()
      expect(runtime.savedViewCacheValid).toBe(true)
      expect(f.read()).toMatchObject({ revision: 1 })
    })
  })

  it('never falls back to a full-table writer if the dedicated repository is unavailable', async () => {
    const local = database()
    const repository = { list: vi.fn(async () => []), replaceTable: vi.fn(async () => {}) }
    const runtime = new SqliteMetadataRuntime('mysql', repository, () => local, ['saved_views'])
    await runWithRequestWorkspace('ws', async () => {
      await expect(runtime.mutateSavedViews('owner', [create('a')])).rejects.toThrow('required')
    })
    expect(repository.replaceTable).not.toHaveBeenCalled()
    expect(local.prepare('SELECT * FROM saved_views').all()).toEqual([])
  })

  it('rejects missing MySQL workspace and does not enable the new channel in shadow mode', async () => {
    const f = fixture()
    await expect(f.runtime.mutateSavedViews('owner', [create('a')])).rejects.toThrow('workspace')
    const shadow = new SqliteMetadataRuntime('shadow', f.repository, () => f.local, ['saved_views'])
    await expect(shadow.mutateSavedViews('owner', [create('a')])).rejects.toThrow('shadow')
    expect(f.repository.mutateSavedViews).not.toHaveBeenCalled()
    expect(f.read()).toBeNull()
  })
})
