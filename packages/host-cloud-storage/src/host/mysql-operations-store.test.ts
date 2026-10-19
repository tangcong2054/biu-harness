/** @vitest-environment node */
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { test } from 'vitest'
import { MysqlOperationsStore } from './mysql-operations-store.ts'

test('MysqlOperationsStore implements the operations SQL contract', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let account = {
    id: 'acc_1',
    email: 'ada@example.com',
    name: 'Ada',
    status: 'active',
    workspace_count: 2,
    plan: '',
    last_seen_at: 10,
    created_at: 10,
    updated_at: 10,
  }
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('UPDATE') && sql.includes('ops_accounts')) {
      account = { ...account, status: String(values?.[0]), updated_at: Number(values?.[1]) }
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('COUNT(*)')) return [[{ n: '1' }], []]
    if (sql.includes('SELECT *') && sql.includes('ops_accounts')) return [[account], []]
    if (sql.includes('SELECT *') && sql.includes('ops_audit_logs')) {
      return [[{
        id: 'audit_1',
        actor_id: 'operator',
        action: 'suspend-account',
        target: 'acc_1',
        summary: '暂停用户',
        created_at: 20,
      }], []]
    }
    return [{ affectedRows: 1 }, []]
  }
  const store = new MysqlOperationsStore({ query } as unknown as Pool, 'biu_ops_test')

  const inserted = await store.upsert('account', {
    id: 'acc_1',
    email: 'ada@example.com',
    name: 'Ada',
    password: 'do-not-write',
    workspaceCount: 2,
  }, 10)
  assert.equal(inserted?.email, 'ada@example.com')
  assert.equal(calls.some((call) => call.values?.includes('do-not-write')), false)

  assert.equal((await store.list('account', 'ada'))[0]?.id, 'acc_1')
  assert.equal((await store.audits('suspend'))[0]?.action, 'suspend-account')
  assert.deepEqual(await store.counts(), {
    accounts: 1,
    workspaces: 1,
    usage: 1,
    devices: 1,
    sync: 1,
    security: 1,
    audits: 1,
  })

  assert.equal((await store.setAccountStatus('acc_1', 'suspended', 'operator', 20))?.status, 'suspended')
  await store.audit('operator', 'manual', 'acc_1', 'manual audit', 21)
  await store.upsertAudit('audit_external', 'operator', 'sync', 'acc_1', 'imported', 22)
  await store.removePlaceholderIdentity()

  assert.equal(calls.every((call) => !call.sql.includes('`biu_ops`')), true)
  assert.equal(calls.some((call) => call.sql.includes('`biu_ops_test`.`ops_accounts`')), true)
  assert.equal(calls.some((call) => call.sql.includes('ON DUPLICATE KEY UPDATE')), true)
  assert.equal(calls.filter((call) => call.sql.includes('DELETE FROM')).length, 2)
})

test('MysqlOperationsStore rejects unsafe database identifiers', () => {
  assert.throws(
    () => new MysqlOperationsStore({} as Pool, 'biu_ops; DROP DATABASE biu'),
    /unsafe MySQL database name/,
  )
})
