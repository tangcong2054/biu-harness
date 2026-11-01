import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { SavedViewMutation } from '@biu/host-plugin-loader/metadata-runtime'
import { MysqlFileSystemMetadataRepository } from './mysql-runtime-repositories.ts'

type Share = { workspaceId: string; collection: string; id: string; kind: string; token: string }
const keyOf = (workspace: unknown, collection: unknown, id: unknown) => JSON.stringify([workspace, collection, id])
const create = (id: string, name = id): SavedViewMutation => ({ type: 'create', collection: '/pages', id, view: { name } })
const update = (id: string, expectedRevision: number, name = id): SavedViewMutation => ({ type: 'update', collection: '/pages', id, expectedRevision, view: { name } })
const remove = (id: string, expectedRevision: number): SavedViewMutation => ({ type: 'delete', collection: '/pages', id, expectedRevision })

function fixture() {
  const state = {
    rows: new Map<string, string>(), shares: [] as Share[], members: new Set(['ws/owner', 'ws/other', 'elsewhere/owner']),
    failShares: false, sqlError: '', workspace: 'ws',
  }
  let backup: { rows: Map<string, string>; shares: Share[] }
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM `test`.workspace_members')) {
      expect(sql).toContain('WHERE workspace_id = ? AND account_id = ? FOR UPDATE')
      return [state.members.has(`${params[0]}/${params[1]}`) ? [{ account_id: params[1] }] : []]
    }
    if (sql.startsWith('SELECT payload_json')) {
      expect(sql).toContain('WHERE workspace_id = ? AND collection = ? AND view_id = ? FOR UPDATE')
      const payload = state.rows.get(keyOf(...params as [unknown, unknown, unknown]))
      return [payload === undefined ? [] : [{ payload_json: payload }]]
    }
    if (state.sqlError) throw Object.assign(new Error('database write failed'), { code: state.sqlError })
    if (sql.startsWith('INSERT INTO `test`.saved_views')) {
      expect(sql).not.toContain('ON DUPLICATE KEY UPDATE')
      const key = keyOf(params[0], params[1], params[2])
      if (state.rows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      state.rows.set(key, String(params[3]))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE `test`.saved_views')) {
      expect(sql).toContain('WHERE workspace_id = ? AND collection = ? AND view_id = ?')
      const key = keyOf(params[2], params[3], params[4])
      expect(state.rows.has(key)).toBe(true)
      state.rows.set(key, String(params[0]))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('DELETE FROM `test`.shares')) {
      expect(sql).toContain("WHERE workspace_id = ? AND kind = 'view' AND collection = ? AND view_id = ?")
      if (state.failShares) throw new Error('share delete failed')
      state.shares = state.shares.filter((row) => row.workspaceId !== params[0]
        || row.collection !== params[1] || row.id !== params[2] || row.kind !== 'view')
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const connection = {
    query,
    beginTransaction: vi.fn(async () => { backup = { rows: new Map(state.rows), shares: [...state.shares] } }),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => { state.rows = backup.rows; state.shares = backup.shares }),
    release: vi.fn(),
    destroy: vi.fn(),
  }
  const pool = { getConnection: vi.fn(async () => connection) }
  const repository = new MysqlFileSystemMetadataRepository(pool as unknown as Pool, 'test', () => state.workspace)
  const save = (mutations: SavedViewMutation[], actor = 'owner') => repository.mutateSavedViews(actor, mutations)
  const read = (id: string, workspace = 'ws', collection = '/pages') => {
    const payload = state.rows.get(keyOf(workspace, collection, id))
    return payload === undefined ? undefined : JSON.parse(payload)
  }
  const seed = (id: string, view: Record<string, unknown>, workspace = 'ws', collection = '/pages') => {
    state.rows.set(keyOf(workspace, collection, id), JSON.stringify({ id, ...view }))
  }
  return { state, pool, connection, repository, save, read, seed }
}

describe('MySQL saved view mutation transaction', () => {
  it('changes only submitted views and returns authoritative owners and revisions', async () => {
    const f = fixture()
    f.seed('untouched', { name: 'new in another window', createdBy: 'owner', revision: 7 })
    const original = f.read('untouched')
    const first = await f.save([{ ...create('a'), view: { name: 'first', createdBy: 'other', revision: 500 } } as SavedViewMutation])
    expect(first[0]?.view).toEqual({ id: 'a', name: 'first', createdBy: 'owner', revision: 1 })
    await f.save([create('b')])
    await f.save([update('a', 1, 'second')])
    expect(f.read('a')).toMatchObject({ name: 'second', revision: 2 })
    expect(f.read('b')).toMatchObject({ name: 'b', revision: 1 })
    expect(f.read('untouched')).toEqual(original)
    expect(f.connection.commit).toHaveBeenCalledTimes(3)
  })

  it('rejects stale updates and stale deletes without disclosing the stored view', async () => {
    const f = fixture()
    f.seed('a', { name: 'newer content', createdBy: 'owner', revision: 2 })
    for (const mutation of [update('a', 1), remove('a', 1)]) {
      await expect(f.save([mutation])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT', status: 409 })
    }
    expect(f.read('a')).toMatchObject({ name: 'newer content', revision: 2 })
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.connection.rollback).toHaveBeenCalledTimes(2)
    expect(f.connection.release).toHaveBeenCalledTimes(2)
  })

  it('retains a minimal tombstone and cannot recreate or update a deleted id', async () => {
    const f = fixture()
    f.seed('a', { name: 'private name', filters: { secret: 'value' }, createdBy: 'owner', revision: 4 })
    await f.save([remove('a', 4)])
    expect(f.read('a')).toEqual({ id: 'a', createdBy: 'owner', revision: 5, deletedAt: expect.any(Number) })
    for (const mutation of [create('a'), update('a', 4), update('a', 5), remove('a', 5)]) {
      await expect(f.save([mutation])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT', status: 409 })
    }
  })

  it('revokes only the target view shares in the same transaction', async () => {
    const f = fixture()
    f.seed('a', { name: 'a', createdBy: 'owner', revision: 1 })
    const target: Share = { workspaceId: 'ws', collection: '/pages', id: 'a', kind: 'view', token: 'target' }
    const others = [
      { ...target, workspaceId: 'elsewhere', token: 'workspace' },
      { ...target, collection: '/tasks', token: 'collection' },
      { ...target, id: 'b', token: 'view' },
      { ...target, kind: 'record', token: 'record' },
    ]
    f.state.shares = [target, ...others, ...['personal', 'workspace', 'shared'].map((scope) => ({
      ...target, id: `builtin-scope:${scope}:a`, token: scope,
    }))]
    await f.save([remove('a', 1)])
    expect(f.state.shares).toEqual(others)
    expect(f.connection.commit).toHaveBeenCalledOnce()
  })

  it('rolls back the whole batch and share revocation if a later mutation conflicts', async () => {
    const f = fixture()
    f.seed('a', { name: 'a', createdBy: 'owner', revision: 1 })
    f.seed('z', { name: 'z', createdBy: 'owner', revision: 2 })
    f.state.shares = [{ workspaceId: 'ws', collection: '/pages', id: 'a', kind: 'view', token: 'a' }]
    await expect(f.save([remove('a', 1), create('b'), update('z', 1)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    expect(f.read('a')).toMatchObject({ name: 'a', revision: 1 })
    expect(f.read('b')).toBeUndefined()
    expect(f.state.shares).toHaveLength(1)
    expect(f.connection.commit).not.toHaveBeenCalled()
  })

  it('rolls back deletion when share revocation fails', async () => {
    const f = fixture()
    f.seed('a', { name: 'a', createdBy: 'owner', revision: 1 })
    f.state.failShares = true
    await expect(f.save([remove('a', 1)])).rejects.toThrow('share delete failed')
    expect(f.read('a')).toEqual({ id: 'a', name: 'a', createdBy: 'owner', revision: 1 })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
  })

  it('denies another account even if the supplied payload forges ownership', async () => {
    const f = fixture()
    f.seed('a', { name: 'private', createdBy: 'other', revision: 1 })
    for (const mutation of [create('a'), update('a', 1), remove('a', 1)]) {
      await expect(f.save([mutation])).rejects.toMatchObject({ code: 'SAVED_VIEW_DENIED', status: 403 })
    }
    expect(f.read('a')).toMatchObject({ name: 'private', createdBy: 'other', revision: 1 })
  })

  it('denies non-members and missing account identity', async () => {
    const f = fixture()
    await expect(f.save([create('a')], '')).rejects.toMatchObject({ code: 'SAVED_VIEW_DENIED' })
    expect(f.pool.getConnection).not.toHaveBeenCalled()
    await expect(f.save([create('a')], 'outsider')).rejects.toMatchObject({ code: 'SAVED_VIEW_DENIED' })
    expect(f.state.rows.size).toBe(0)
    expect(f.connection.query).toHaveBeenCalledTimes(1)
  })

  it('claims legacy ownerless rows with explicit revision zero, but not missing rows', async () => {
    const f = fixture()
    f.seed('legacy', { name: 'legacy' })
    await f.save([update('legacy', 0, 'claimed')])
    expect(f.read('legacy')).toMatchObject({ name: 'claimed', createdBy: 'owner', revision: 1 })
    await expect(f.save([update('missing', 0)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    await expect(f.save([remove('missing', 0)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
  })

  it('isolates workspaces and collections while binding ids as SQL parameters', async () => {
    const f = fixture()
    const id = "a' OR 1=1 --"
    f.seed(id, { name: 'other workspace', createdBy: 'other', revision: 2 }, 'elsewhere')
    f.seed(id, { name: 'other collection', createdBy: 'other', revision: 2 }, 'ws', '/tasks')
    await f.save([create(id)])
    expect(f.read(id)).toMatchObject({ createdBy: 'owner', revision: 1 })
    expect(f.read(id, 'elsewhere')).toMatchObject({ name: 'other workspace', revision: 2 })
    expect(f.read(id, 'ws', '/tasks')).toMatchObject({ name: 'other collection', revision: 2 })
    for (const [sql] of f.connection.query.mock.calls) expect(sql).not.toContain(id)
  })

  it('captures workspace and nested payload before acquiring the connection', async () => {
    const f = fixture()
    const view = { name: 'captured', filters: { title: 'before' } }
    const mutations: SavedViewMutation[] = [{ type: 'create', collection: '/pages', id: 'a', view }]
    const pending = f.save(mutations)
    f.state.workspace = 'elsewhere'
    view.filters.title = 'after'
    mutations.push(create('b'))
    await pending
    expect(f.read('a')).toMatchObject({ filters: { title: 'before' } })
    expect(f.read('a', 'elsewhere')).toBeUndefined()
    expect(f.read('b')).toBeUndefined()
  })

  it('locks rows in stable order but preserves response order', async () => {
    const f = fixture()
    const result = await f.save([create('z'), create('a')])
    expect(result.map((row) => row.id)).toEqual(['z', 'a'])
    const reads = f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT payload_json'))
    expect(reads.map(([, params]) => params[2])).toEqual(['a', 'z'])
  })

  it.each(['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])('maps %s to a conflict after rollback', async (code) => {
    const f = fixture()
    f.state.sqlError = code
    await expect(f.save([create('a')])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT', status: 409 })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
  })

  it('discards a connection when rollback fails and preserves both errors', async () => {
    const f = fixture()
    f.state.sqlError = 'ER_LOCK_DEADLOCK'
    const rollbackError = new Error('connection lost during rollback')
    f.connection.rollback.mockRejectedValueOnce(rollbackError)
    await expect(f.save([create('a')])).rejects.toMatchObject({
      message: 'Saved view transaction rollback failed',
      errors: [expect.objectContaining({ code: 'ER_LOCK_DEADLOCK' }), rollbackError],
    })
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect(f.connection.release).not.toHaveBeenCalled()
  })

  it.each([null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stored revision %s', async (revision) => {
    const f = fixture()
    f.seed('a', { name: 'a', createdBy: 'owner', revision })
    await expect(f.save([update('a', 0)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    expect(f.read('a').revision).toBe(revision)
  })

  it('never increments beyond the safe integer revision limit', async () => {
    const f = fixture()
    f.seed('a', { name: 'a', createdBy: 'owner', revision: Number.MAX_SAFE_INTEGER - 1 })
    await f.save([update('a', Number.MAX_SAFE_INTEGER - 1)])
    expect(f.read('a').revision).toBe(Number.MAX_SAFE_INTEGER)
    await expect(f.save([update('a', Number.MAX_SAFE_INTEGER)])).rejects.toMatchObject({ code: 'SAVED_VIEW_INVALID' })
    expect(f.read('a').revision).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each(['null', '[]', 'broken', '{"id":"a","revision":"1"}', '{"id":"different"}'])('refuses malformed persisted payload %s', async (payload) => {
    const f = fixture()
    f.state.rows.set(keyOf('ws', '/pages', 'a'), payload)
    await expect(f.save([update('a', 1)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
    expect(f.state.rows.get(keyOf('ws', '/pages', 'a'))).toBe(payload)
  })

  it.each([
    [{ ...update('a', 0), expectedRevision: -1 }],
    [{ ...update('a', 0), expectedRevision: '0' }],
    [{ ...update('a', 0), expectedRevision: Number.MAX_SAFE_INTEGER }],
    [{ ...update('a', 0), expectedRevision: 0.5 }],
    [{ ...create('a'), collection: '/' }],
    [{ ...create('a'), collection: '/views' }],
    [{ ...create('a'), collection: '/pages/../tasks' }],
    [create('builtin-all:/pages')],
    [create('a'), remove('a', 0)],
    [{ ...create('a'), view: { name: 'a', id: 'b' } }],
    [{ ...create('a'), view: { name: 'a', builtin: true } }],
    [{ ...create('a'), view: { name: 'a', deletedAt: 123 } }],
    [{ ...create('a'), view: { name: '' } }],
    [{ ...create('a'), view: { name: 'a', data: 'x'.repeat(1_048_576) } }],
    Array.from({ length: 201 }, (_, index) => create(String(index))),
  ])('rejects invalid mutation batch %# before opening a transaction', async (...batch) => {
    const f = fixture()
    await expect(f.save(batch as SavedViewMutation[])).rejects.toMatchObject({ code: 'SAVED_VIEW_INVALID', status: 400 })
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })

  it('skips empty changes without a transaction', async () => {
    const f = fixture()
    await expect(f.save([])).resolves.toEqual([])
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })
})
