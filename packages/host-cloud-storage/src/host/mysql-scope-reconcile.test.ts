import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAccountRepository } from './mysql-account-repositories.ts'

type Grant = { subject_type: string; subject_id: string; member_kind: string }
type Share = { workspace_id: string; collection: string; record_id: string; kind: string; view_id?: string; password_hash?: string }
const owner: Grant = { subject_type: 'account', subject_id: 'owner', member_kind: 'member' }
const external: Grant = { subject_type: 'account', subject_id: 'outside', member_kind: 'external' }
const internal: Grant = { subject_type: 'account', subject_id: 'inside', member_kind: 'member' }

function fixture(collection = '/pages', mode = 'restricted') {
  const policy = {
    ownership: 'shared', owner_account_id: 'owner', access_mode: mode,
    parent_collection: '/tasks', parent_record_id: 'parent', member_default_role: 'viewer',
  }
  const state = { grants: [owner, external], shares: [] as Share[], revision: 0, shareFailure: false, authorized: true }
  let backup: { policy: typeof policy; grants: Grant[]; revision: number }
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('DELETE FROM `test`.record_grants')) {
      expect(params.slice(0, 3)).toEqual(['ws', collection, 'record'])
      const before = state.grants.length
      state.grants = state.grants.filter((row) => row.subject_type !== params[3] || row.subject_id !== params[4])
      return [{ affectedRows: before - state.grants.length }]
    }
    if (sql.includes('SELECT member_kind,')) return [[]]
    if (sql.includes('FROM `test`.resource_policies')) {
      expect(sql).toContain('FOR UPDATE')
      expect(params).toEqual(['ws', collection, 'record'])
      return [[{ ...policy }]]
    }
    if (sql.includes('FROM `test`.record_grants g')) {
      expect(params).toEqual(['ws', collection, 'record'])
      return [state.grants]
    }
    if (sql.includes('FROM `test`.shares')) {
      expect(sql).toContain("workspace_id = ? AND kind = 'record' AND collection = ? AND record_id = ?")
      expect(params).toEqual(['ws', collection, 'record'])
      if (state.shareFailure) throw new Error('share lookup unavailable')
      return [state.shares.filter((row) => row.workspace_id === params[0] && row.collection === params[1]
        && row.record_id === params[2] && row.kind === 'record').map(() => ({ shared: 1 }))]
    }
    if (sql.includes('UPDATE `test`.resource_policies')) {
      expect(params.slice(2)).toEqual(['ws', collection, 'record'])
      expect(sql).not.toContain('parent_record_id =')
      expect(sql).not.toContain('member_default_role =')
      policy.ownership = String(params[0])
      policy.access_mode = String(params[1])
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('INSERT INTO `test`.authz_revisions')) {
      state.revision += 1
      return [{ affectedRows: 1 }]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const connection = {
    query,
    beginTransaction: vi.fn(async () => { backup = { policy: { ...policy }, grants: [...state.grants], revision: state.revision } }),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => { Object.assign(policy, backup.policy); state.grants = backup.grants; state.revision = backup.revision }),
    release: vi.fn(),
  }
  const pool = {
    query: vi.fn(async () => [state.authorized ? [{ ok: 1 }] : []]),
    getConnection: vi.fn(async () => connection),
  }
  const repo = new MysqlAccountRepository(pool as unknown as Pool, 'test')
  const revoke = () => repo.revokeRecordGrant({ actorId: 'owner', workspaceId: 'ws', collection, recordId: 'record', subjectType: 'account', subjectId: 'outside' })
  return { policy, state, connection, pool, revoke, collection }
}

describe('scope narrowing after collaborator revocation', () => {
  it.each(['/pages', '/tasks', '/sessions', '/mcp'])('%s narrows to personal after the last collaborator is removed', async (collection) => {
    const f = fixture(collection)
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'personal', access_mode: 'private' })
    expect(f.state.grants).toEqual([owner])
    expect(f.state.revision).toBe(1)
    expect(f.connection.commit).toHaveBeenCalledOnce()
  })
  it('narrows to workspace when an internal collaborator remains', async () => {
    const f = fixture()
    f.state.grants.push(internal)
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'workspace', access_mode: 'restricted' })
  })
  it.each(['external', 'guest'])('stays shared if a %s collaborator remains', async (kind) => {
    const f = fixture()
    f.state.grants.push({ subject_type: 'account', subject_id: 'remaining', member_kind: kind })
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'shared', access_mode: 'restricted' })
  })
  it('group and member-view grants still count as collaborators', async () => {
    for (const type of ['group', 'member_view']) {
      const f = fixture()
      f.state.grants.push({ subject_type: type, subject_id: 'team', member_kind: '' })
      await f.revoke()
      expect(f.policy).toMatchObject({ ownership: 'workspace', access_mode: 'restricted' })
    }
  })
  it('keeps a real public link shared without opening member access', async () => {
    const f = fixture()
    f.state.shares.push({ workspace_id: 'ws', collection: '/pages', record_id: 'record', kind: 'record', view_id: 'board', password_hash: 'protected' })
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'shared', access_mode: 'private' })
    expect(f.state.shares).toHaveLength(1)
  })
  it('ignores links belonging to another workspace, collection, record, or a view', async () => {
    const f = fixture()
    const base: Share = { workspace_id: 'ws', collection: '/pages', record_id: 'record', kind: 'record' }
    f.state.shares.push({ ...base, workspace_id: 'other' }, { ...base, collection: '/tasks' }, { ...base, record_id: 'other' }, { ...base, kind: 'view' })
    await f.revoke()
    expect(f.policy.ownership).toBe('personal')
  })
  it('keeps all-member visibility as workspace rather than mislabelling it personal', async () => {
    const f = fixture('/tasks', 'members')
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'workspace', access_mode: 'members', member_default_role: 'viewer' })
  })
  it('does not detach inheritance or change the parent and default role', async () => {
    const f = fixture('/pages', 'inherit')
    await f.revoke()
    expect(f.policy).toMatchObject({ ownership: 'personal', access_mode: 'inherit', parent_collection: '/tasks', parent_record_id: 'parent', member_default_role: 'viewer' })
  })
  it('rolls back grant removal and does not bump the revision when share lookup fails', async () => {
    const f = fixture()
    f.state.shareFailure = true
    await expect(f.revoke()).rejects.toThrow('share lookup unavailable')
    expect(f.state.grants).toEqual([owner, external])
    expect(f.policy).toMatchObject({ ownership: 'shared', access_mode: 'restricted' })
    expect(f.state.revision).toBe(0)
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
  })
  it('refuses unauthorized changes before starting a transaction', async () => {
    const f = fixture()
    f.state.authorized = false
    await expect(f.revoke()).rejects.toThrow('permission denied')
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })
})
