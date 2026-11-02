import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { runWithRequestMemo } from '@biu/host-plugin-loader/data-dir'
import { MysqlAccountRepository } from './mysql-account-repositories.ts'

/** 同一请求里入口鉴权与路由鉴权重复解析身份时，只应各查一次库。 */
function fixture(role = 'member') {
  const connection = {
    query: vi.fn(async () => [[]]),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  }
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.includes('auth_sessions s JOIN')) return [[{
      id: 'acc_a', name: 'Ada', email: 'ada@example.test', password_hash: 'hash',
      active_workspace_id: 'ws', must_change_password: 0, created_at: 1,
      session_id: 'sess', last_seen_at: 1,
    }]]
    if (sql.includes('ops_account_governance')) return [[{ status: 'active' }]]
    if (sql.includes('FROM `test`.workspace_members')) return [[{ role, member_kind: 'member' }]]
    if (sql.includes('FROM `test`.accounts WHERE normalized_email')) return [[{
      id: 'acc_b', name: 'Bob', email: 'bob@example.test', password_hash: 'hash2',
      active_workspace_id: 'ws', must_change_password: 0, created_at: 2,
    }]]
    if (sql.includes('JOIN `test`.accounts a ON a.id = m.account_id')) return [[]]
    if (sql.includes('UPDATE `test`.auth_sessions SET last_seen_at')) return [{ affectedRows: 1 }]
    throw new Error(`unexpected query: ${sql}`)
  })
  const getConnection = vi.fn(async () => connection)
  const pool = { query, getConnection } as unknown as Pool
  return { query, getConnection, connection, repo: new MysqlAccountRepository(pool, 'test', 'ops_test') }
}

const count = (mock: { mock: { calls: unknown[][] } }, needle: string) =>
  mock.mock.calls.filter(([sql]) => String(sql).includes(needle)).length

it('deduplicates token, suspension and membership reads within one request without a transaction', async () => {
  const f = fixture()
  const result = await runWithRequestMemo(async () => {
    const [a, b] = await Promise.all([
      f.repo.accountByTokenHash('hash-1', 120_000),
      f.repo.accountByTokenHash('hash-1', 120_000),
    ])
    const [s1, s2] = await Promise.all([f.repo.isSuspended('acc_a'), f.repo.isSuspended('acc_a')])
    const [m1, m2] = await Promise.all([f.repo.membership('acc_a', 'ws'), f.repo.membership('acc_a', 'ws')])
    return { a, b, s1, s2, m1, m2 }
  })
  expect(result.a).toEqual(result.b)
  expect(result.a?.id).toBe('acc_a')
  expect(result.s1).toBe(false)
  expect(result.s2).toBe(false)
  expect(result.m1).toEqual({ role: 'member', memberKind: 'member' })
  expect(result.m2).toEqual(result.m1)
  // token 解析本身不再开事务；这里没有任何写事务。
  expect(f.getConnection).not.toHaveBeenCalled()
  expect(count(f.query, 'auth_sessions s JOIN')).toBe(1)
  expect(count(f.query, 'ops_account_governance')).toBe(1)
  expect(count(f.query, 'FROM `test`.workspace_members')).toBe(1)
  expect(count(f.query, 'UPDATE `test`.auth_sessions SET last_seen_at')).toBe(1)
})

it('does not reuse identity reads outside or across requests, and throttles last_seen_at', async () => {
  const f = fixture()
  await runWithRequestMemo(() => f.repo.accountByTokenHash('hash-1', 120_000))
  await runWithRequestMemo(() => f.repo.accountByTokenHash('hash-1', 120_000))
  expect(count(f.query, 'auth_sessions s JOIN')).toBe(2)

  const g = fixture()
  await g.repo.accountByTokenHash('hash-1', 1_000)
  expect(count(g.query, 'UPDATE `test`.auth_sessions SET last_seen_at')).toBe(0)
})

it('forgets membership results after a change in the same request', async () => {
  const f = fixture('owner')
  await runWithRequestMemo(async () => {
    expect(await f.repo.membership('acc_a', 'ws')).toEqual({ role: 'owner', memberKind: 'member' })
    const before = count(f.query, 'FROM `test`.workspace_members')
    await f.repo.addMemberByEmail('acc_a', 'ws', 'bob@example.test', 1)
    const after = count(f.query, 'FROM `test`.workspace_members')
    // 写入成员后递增了授权版本，本请求内清掉成员缓存，之后的读取重新查库。
    expect(after).toBeGreaterThan(before)
    expect(f.connection.commit).toHaveBeenCalled()
  })
})
