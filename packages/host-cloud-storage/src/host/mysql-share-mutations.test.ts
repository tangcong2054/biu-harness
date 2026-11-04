import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlFileSystemMetadataRepository } from './mysql-runtime-repositories.ts'

const columns = ['token', 'kind', 'collection', 'view_id', 'record_id', 'password_salt', 'password_hash', 'share_plugins', 'allow_copy', 'created_at', 'updated_at', 'created_by']
const row = (token = 'token'): Record<string, unknown> => ({ token, kind: 'record', collection: '/pages', view_id: '', record_id: 'p1', password_salt: '', password_hash: '', share_plugins: 0, allow_copy: 1, created_at: 1, updated_at: 2, created_by: '' })
function fixture() {
  const state = { rows: [] as Array<Record<string, unknown>>, workspace: 'ws', view: { id: 'v' } as unknown, writeError: '' }
  let backup: typeof state.rows
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM `test`.saved_views')) {
      expect(sql).toContain('WHERE workspace_id = ? AND collection = ? AND view_id = ? FOR UPDATE')
      expect(params).toEqual(['ws', '/pages', 'v'])
      return [state.view === undefined ? [] : [{ payload_json: JSON.stringify(state.view) }]]
    }
    if (sql.startsWith('SELECT * FROM `test`.shares')) {
      expect(sql).toContain('WHERE workspace_id = ? AND token = ? FOR UPDATE')
      return [state.rows.filter((r) => r.workspace_id === params[0] && r.token === params[1])]
    }
    if (state.writeError) throw Object.assign(new Error('write failed'), { code: state.writeError })
    if (sql.startsWith('INSERT INTO `test`.shares')) {
      expect(sql).not.toContain('ON DUPLICATE KEY')
      if (state.rows.some((r) => r.token === params[1])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      state.rows.push({ workspace_id: params[0], ...Object.fromEntries(columns.map((column, index) => [column, params[index + 1]])) })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE `test`.shares')) {
      expect(sql).toContain('WHERE workspace_id = ? AND token = ?')
      const updates = [...sql.split(' WHERE ')[0]!.matchAll(/`([a-z_]+)` = \?/g)].map((match) => match[1]!)
      const current = state.rows.find((r) => r.workspace_id === params[updates.length] && r.token === params[updates.length + 1])!
      for (const [index, column] of updates.entries()) current[column] = params[index]
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('DELETE FROM `test`.`shares`')) {
      expect(sql).toContain('WHERE workspace_id = ?')
      const keys = [...sql.matchAll(/`([a-z_]+)` = \?/g)].map((match) => match[1]!)
      state.rows = state.rows.filter((r) => r.workspace_id !== params[0] || !keys.every((key, index) => r[key] === params[index + 1]))
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const connection = {
    query,
    beginTransaction: vi.fn(async () => { backup = state.rows.map((r) => ({ ...r })) }),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => { state.rows = backup }),
    release: vi.fn(), destroy: vi.fn(),
  }
  const pool = { query, getConnection: vi.fn(async () => connection) }
  const repository = new MysqlFileSystemMetadataRepository(pool as unknown as Pool, 'test', () => state.workspace)
  return { state, connection, pool, repository }
}

describe('MySQL share row mutations', () => {
  it('fills a legacy creator once without allowing creator replacement', async () => {
    const f = fixture()
    f.state.rows = [{ workspace_id: 'ws', ...row() }]
    await f.repository.saveShare({ ...row(), created_by: 'ada' }, row())
    expect(f.state.rows[0]?.created_by).toBe('ada')
    await expect(f.repository.saveShare({ ...row(), created_by: 'bob' }, { ...row(), created_by: 'ada' })).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.state.rows[0]?.created_by).toBe('ada')
  })

  it('creates one link without changing an unrelated link', async () => {
    const f = fixture()
    f.state.rows = [{ workspace_id: 'ws', ...row('other') }]
    await f.repository.saveShare(row(), null)
    expect(f.state.rows).toHaveLength(2)
    expect(f.state.rows[0]).toEqual({ workspace_id: 'ws', ...row('other') })
  })

  it('updates only when the complete previous value still matches', async () => {
    const f = fixture()
    f.state.rows = [{ workspace_id: 'ws', ...row() }]
    await f.repository.saveShare({ ...row(), allow_copy: 0, updated_at: 3 }, row())
    expect(f.state.rows[0]).toMatchObject({ allow_copy: 0, updated_at: 3 })
    await expect(f.repository.saveShare({ ...row(), password_hash: 'stale', updated_at: 4 }, row()))
      .rejects.toMatchObject({ code: 'SHARE_CONFLICT', status: 409 })
    expect(f.state.rows[0]).toMatchObject({ password_hash: '', allow_copy: 0, updated_at: 3 })
  })

  it('rejects a stale password even when timestamps are identical', async () => {
    const f = fixture()
    f.state.rows = [{ workspace_id: 'ws', ...row(), password_hash: 'new-password' }]
    await expect(f.repository.saveShare({ ...row(), allow_copy: 0 }, row())).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.state.rows[0]?.password_hash).toBe('new-password')
  })

  it('never recreates a revoked token on update', async () => {
    const f = fixture()
    await expect(f.repository.saveShare({ ...row(), allow_copy: 0 }, row())).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.state.rows).toEqual([])
    expect(f.connection.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  })

  it('does not update a token belonging to another workspace', async () => {
    const f = fixture()
    f.state.rows = [{ workspace_id: 'other', ...row() }]
    await expect(f.repository.saveShare({ ...row(), allow_copy: 0 }, row())).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.state.rows[0]?.allow_copy).toBe(1)
  })

  it('captures workspace and row values before acquiring the connection', async () => {
    const f = fixture()
    const next = row()
    const save = f.repository.saveShare(next, null)
    f.state.workspace = 'other'
    next.password_hash = 'changed'
    await save
    expect(f.state.rows[0]).toMatchObject({ workspace_id: 'ws', password_hash: '' })
  })

  it.each([undefined, null, [], { id: 'v', deletedAt: 1 }, { id: 'other' }])('refuses sharing a missing or deleted custom view %#', async (view) => {
    const f = fixture()
    f.state.view = view
    await expect(f.repository.saveShare({ ...row(), kind: 'view', view_id: 'v', record_id: '' }, null)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.state.rows).toEqual([])
  })

  it('locks the view before writing its share', async () => {
    const f = fixture()
    await f.repository.saveShare({ ...row(), kind: 'view', view_id: 'v', record_id: '' }, null)
    expect(f.connection.query.mock.calls[0]?.[0]).toContain('saved_views')
    expect(f.connection.commit).toHaveBeenCalledOnce()
  })

  it('deletes only the scoped record target, including links absent from a local cache', async () => {
    const f = fixture()
    f.state.rows = [
      { workspace_id: 'ws', ...row() },
      { workspace_id: 'ws', ...row('other-view-id'), view_id: 'v' },
      { workspace_id: 'ws', ...row('different-record'), record_id: 'p2' },
      { workspace_id: 'other', ...row('other-workspace') },
      { workspace_id: 'ws', ...row('view'), kind: 'view' },
    ]
    await f.repository.deleteShares({ kind: 'record', collection: '/pages', record_id: 'p1' })
    expect(f.state.rows.map((r) => r.token)).toEqual(['different-record', 'other-workspace', 'view'])
  })

  it('revokes an exact whole-collection share with an empty view id', async () => {
    const f = fixture()
    await f.repository.saveShare({ ...row(), kind: 'view', view_id: '', record_id: '' }, null)
    await f.repository.deleteShares({ kind: 'view', collection: '/pages', view_id: '', record_id: '' })
    expect(f.state.rows).toEqual([])
    await expect(f.repository.deleteShares({ kind: 'view', collection: '/pages', view_id: '' })).rejects.toThrow('target required')
  })

  it.each(['personal', 'workspace', 'shared'])('locks the custom base of a %s scope share', async (scope) => {
    const f = fixture()
    const scoped = { ...row(), kind: 'view', view_id: `builtin-scope:${scope}:v`, record_id: '' }
    await f.repository.saveShare(scoped, null)
    expect(f.connection.query.mock.calls[0]?.[1]).toEqual(['ws', '/pages', 'v'])
    f.state.view = { id: 'v', deletedAt: 1 }
    await expect(f.repository.saveShare(scoped, scoped)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
  })

  it.each(['builtin-scope:shared:%', 'builtin-scope:bad:v', 'builtin-scope:shared:', 'builtin-scope:shared:builtin-scope%3Ashared%3Av'])('rejects malformed scope %s', async (viewId) => {
    const f = fixture()
    await expect(f.repository.saveShare({ ...row(), kind: 'view', view_id: viewId, record_id: '' }, null)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })

  it('scopes token revocation to the workspace and binds token values', async () => {
    const f = fixture()
    const token = "a' OR 1=1 --"
    f.state.rows = [{ workspace_id: 'other', ...row(token) }]
    await f.repository.deleteShares({ token })
    expect(f.state.rows).toHaveLength(1)
    expect(f.pool.query.mock.calls[0]?.[0]).not.toContain(token)
    expect(f.pool.query.mock.calls[0]?.[1]).toEqual(['ws', token])
  })

  it.each([{}, { kind: 'view' }, { token: '' }, { collection: '/pages' }, { kind: 'record', collection: '/pages' }, { password_hash: 'x' }, { token: 'x', injected: 'x' }])('rejects unqualified deletion %#', async (where) => {
    const f = fixture()
    await expect(f.repository.deleteShares(where)).rejects.toThrow()
    expect(f.pool.query).not.toHaveBeenCalled()
  })

  it.each(['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])('rolls back %s as a conflict', async (code) => {
    const f = fixture()
    f.state.writeError = code
    await expect(f.repository.saveShare(row(), null)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
  })

  it('destroys the connection if rollback fails', async () => {
    const f = fixture()
    f.state.writeError = 'ER_LOCK_DEADLOCK'
    f.connection.rollback.mockRejectedValueOnce(new Error('rollback failed'))
    await expect(f.repository.saveShare(row(), null)).rejects.toThrow('Share transaction rollback failed')
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect(f.connection.release).not.toHaveBeenCalled()
  })

  it('rejects changing immutable target identity', async () => {
    const f = fixture()
    await expect(f.repository.saveShare({ ...row(), collection: '/tasks' }, row())).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })
})
