import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAccessReader, type AccessMatchers } from './mysql-access-reader.ts'
import { MysqlAccountRepository } from './mysql-account-repositories.ts'

type Row = Record<string, unknown>
function fixture() {
  const member: Row = { role: 'member', member_kind: 'member', name: 'Bob' }
  const policy = (extra: Row = {}) => ({ owner_account_id: 'ada', ownership: 'personal', access_mode: 'private', ...extra })
  const policies: Record<string, Row> = { '/pages/p1': policy() }
  const grants: Record<string, Row[]> = {}
  const viewGrants: Record<string, Row[]> = {}
  const views: Record<string, Row[]> = {}
  let inGroup = false
  let membership = true
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    expect(sql).toContain('workspace_id')
    expect(args[0]).toBe('ws')
    if (sql.includes('JOIN `test`.accounts a ON a.id = m.account_id')) return [membership ? [member] : []]
    if (sql.includes('`test`.resource_policies')) return [[policies[`${args[1]}/${args[2]}`]].filter(Boolean)]
    if (sql.includes('`test`.record_owners')) return [[]]
    if (sql.includes('`test`.record_grants')) return [grants[`${args[1]}/${args[2]}`] ?? []]
    if (sql.includes('`test`.workspace_group_members')) return [inGroup ? [{ ok: 1 }] : []]
    if (sql.includes('`test`.view_grants')) return [viewGrants[String(args[1])] ?? []]
    if (sql.includes('`test`.saved_views')) return [views[String(args[1])] ?? []]
    throw new Error(`unexpected query: ${sql}`)
  })
  const pool = { query } as unknown as Pool
  const matchers: AccessMatchers = {
    readRecord: vi.fn(async () => ({ id: 'p1', status: 'done' })),
    memberView: (id, row, list) => list.some((view) => view.id === id && view.filters?.role === row.role),
    recordView: (id, row, list) => list.some((view) => view.id === id && view.filters?.status === row.status),
  }
  return {
    member, policy, policies, grants, viewGrants, views, pool, query, matchers,
    setGroup: (value: boolean) => { inGroup = value },
    setMember: (value: boolean) => { membership = value },
    read: (actor = 'bob') => new MysqlAccessReader(pool, 'test', 'ws', actor, matchers).record('/pages', 'p1'),
  }
}
const grant = (subject_type: string, subject_id: string, extra: Row = {}): Row => ({ subject_type, subject_id, role: 'viewer', ...extra })
const denied = { code: 'ACCESS_DETAILS_DENIED', status: 403 }

describe('MySQL access detail record authorization', () => {
  it('ignores a data view grant from someone who cannot see the private record', async () => {
    const f = fixture()
    f.viewGrants['/pages'] = [grant('account', 'bob', { view_id: 'done', granted_by: 'carol' })]
    f.views['/pages'] = [{ view_id: 'done', payload_json: { filters: { status: 'done' } } }]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.viewGrants['/pages'] = [grant('account', 'bob', { view_id: 'done', granted_by: 'ada' })]
    await expect(f.read()).resolves.toHaveLength(1)
    f.policies['/pages/p1'] = f.policy({ ownership: 'workspace', access_mode: 'members' })
    f.member.member_kind = 'external'
    f.viewGrants['/pages'] = [grant('account', 'bob', { view_id: 'done', granted_by: 'carol' })]
    await expect(f.read()).resolves.toHaveLength(1)
  })
  it('rejects ordinary members, admins and workspace owners without record permission', async () => {
    const f = fixture()
    for (const role of ['member', 'admin', 'owner']) {
      f.member.role = role
      await expect(f.read()).rejects.toMatchObject(denied)
    }
    await expect(f.read('ada')).resolves.toEqual([])
  })
  it('rejects missing membership, unknown records and missing identities', async () => {
    const f = fixture()
    f.setMember(false)
    await expect(f.read('ada')).rejects.toMatchObject(denied)
    f.setMember(true)
    delete f.policies['/pages/p1']
    await expect(f.read()).rejects.toMatchObject(denied)
    await expect(new MysqlAccessReader(f.pool, 'test', '', 'bob').record('/pages', 'p1')).rejects.toMatchObject(denied)
    await expect(new MysqlAccessReader(f.pool, 'test', 'ws', '').record('/pages', 'p1')).rejects.toMatchObject(denied)
  })
  it('checks direct account, group and workspace-role grants, including revocation', async () => {
    const f = fixture()
    f.grants['/pages/p1'] = [grant('account', 'bob')]
    await expect(f.read()).resolves.toEqual([])
    f.grants['/pages/p1'] = []
    await expect(f.read()).rejects.toMatchObject(denied)
    f.grants['/pages/p1'] = [grant('group', 'team')]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.setGroup(true)
    await expect(f.read()).resolves.toEqual([])
    f.grants['/pages/p1'] = [grant('workspace_role', 'member')]
    await expect(f.read()).resolves.toEqual([])
    f.grants['/pages/p1'] = [grant('account', 'bob', { role: 'invalid' })]
    await expect(f.read()).rejects.toMatchObject(denied)
  })
  it('validates dynamic member views instead of trusting the existence of a grant', async () => {
    const f = fixture()
    f.grants['/pages/p1'] = [grant('member_view', 'editors')]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.views['/workspace-members'] = [{ view_id: 'editors', payload_json: JSON.stringify({ filters: { role: 'member' } }) }]
    await expect(f.read()).resolves.toEqual([])
    f.grants['/pages/p1'] = [grant('member_view', 'builtin-member:external')]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.member.member_kind = 'external'
    await expect(f.read()).resolves.toEqual([])
  })
  it('does not grant external members access to members-mode records', async () => {
    const f = fixture()
    f.policies['/pages/p1'] = f.policy({ access_mode: 'members' })
    await expect(f.read()).resolves.toEqual([])
    f.member.member_kind = 'external'
    await expect(f.read()).rejects.toMatchObject(denied)
  })
  it('follows cross-collection inheritance and rejects missing parents and cycles', async () => {
    const f = fixture()
    f.policies['/pages/p1'] = f.policy({ access_mode: 'inherit', parent_collection: '/tasks', parent_record_id: 't1' })
    await expect(f.read()).rejects.toMatchObject(denied)
    f.policies['/tasks/t1'] = f.policy({ access_mode: 'members' })
    await expect(f.read()).resolves.toEqual([])
    f.policies['/tasks/t1'] = f.policy({ access_mode: 'inherit', parent_collection: '/pages', parent_record_id: 'p1' })
    await expect(f.read()).rejects.toMatchObject(denied)
  })
  it('checks all-view grant ownership and custom view record filters', async () => {
    const f = fixture()
    const all = grant('account', 'bob', { view_id: 'builtin-all:/pages', granted_by: 'other' })
    f.viewGrants['/pages'] = [all]
    await expect(f.read()).rejects.toMatchObject(denied)
    all.granted_by = 'ada'
    await expect(f.read()).resolves.toEqual([all])
    const custom = grant('account', 'bob', { view_id: 'done', granted_by: 'ada' })
    f.viewGrants['/pages'] = [custom]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.views['/pages'] = [{ view_id: 'done', payload_json: JSON.stringify({ filters: { status: 'done' } }) }]
    await expect(f.read()).resolves.toEqual([custom])
    f.views['/pages'][0].payload_json = JSON.stringify({ filters: { status: 'todo' } })
    await expect(f.read()).rejects.toMatchObject(denied)
    await expect(f.read('ada')).resolves.toEqual([])
  })
  it.each([0, 123])('does not authorize through member or data view tombstones (%s)', async (deletedAt) => {
    const f = fixture()
    f.grants['/pages/p1'] = [grant('member_view', 'editors')]
    f.views['/workspace-members'] = [{ view_id: 'editors', payload_json: JSON.stringify({ filters: { role: 'member' }, deletedAt }) }]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.grants['/pages/p1'] = []
    f.viewGrants['/pages'] = [grant('account', 'bob', { view_id: 'done', granted_by: 'ada' })]
    f.views['/pages'] = [{ view_id: 'done', payload_json: { filters: { status: 'done' }, deletedAt } }]
    await expect(f.read()).rejects.toMatchObject(denied)
    f.views['/pages'][0].payload_json = { filters: { status: 'done' } }
    await expect(f.read()).resolves.toEqual(f.viewGrants['/pages'])
  })
  it('rejects through the repository before querying collaborator names or emails', async () => {
    const f = fixture()
    const repo = new MysqlAccountRepository(f.pool, 'test')
    await expect(repo.recordAccess('bob', 'ws', '/pages', 'p1')).rejects.toMatchObject(denied)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('group_name'))).toBe(false)
  })
})
