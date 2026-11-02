/** @vitest-environment node */
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { test } from 'vitest'
import { syncMysqlOperations } from './mysql-operations-projection.ts'
import { MysqlOperationsStore } from './mysql-operations-store.ts'
import { syncOperationsFromPlatform } from '../../../core-plugin-system/src/host/operations-collections.ts'
import type { OperationsRepository } from '../../../core-plugin-system/src/host/operations-repository.ts'

test('MySQL projection reads the selected product database and preserves governance', async () => {
  const sqls: string[] = []
  const writes: Array<{ kind: string; row: Record<string, unknown> }> = []
  const query = async (sql: string) => {
    sqls.push(sql)
    if (sql.includes('`accounts`')) return [[{ id: 'acc1', name: 'Ada', email: 'ada@example.com', created_at: 1 }]]
    if (sql.includes('`workspaces`')) return [[{ id: 'ws1', name: 'Work', owner_id: 'acc1', created_at: 1 }]]
    if (sql.includes('`workspace_members`')) return [[{ workspace_id: 'ws1', account_id: 'acc1' }]]
    if (sql.includes('`attachments`')) return [[{ bytes: 500 }]]
    if (sql.includes('`events`')) return [[{ day: '2026-10-29', requests: 2, tokens: 25, max_ts: 2 }]]
    return [[]]
  }
  const store = {
    list: async () => [{ id: 'ws1', status: 'suspended' }],
    upsert: async (kind: string, row: Record<string, unknown>) => { writes.push({ kind, row }); return null },
    upsertAudit: async () => {},
  }
  await syncMysqlOperations({ query } as unknown as Pool, 'product_test', store as unknown as Parameters<typeof syncMysqlOperations>[2])
  assert.ok(sqls.every(sql => sql.includes('`product_test`.')))
  assert.equal(writes.find(w => w.kind === 'account')?.row.workspaceCount, 1)
  assert.equal(Object.hasOwn(writes.find(w => w.kind === 'account')!.row, 'status'), false)
  assert.equal(writes.find(w => w.kind === 'workspace')?.row.status, 'suspended')
  assert.equal(writes.find(w => w.kind === 'workspace')?.row.ownerId, 'acc1')
  assert.equal(writes.find(w => w.kind === 'usage')?.row.tokens, 25)
  assert.equal(writes.find(w => w.kind === 'usage')?.row.accountId, '')
  assert.equal(writes.some(w => w.kind === 'sync'), false)
})

test('MySQL refresh bypasses SQLite paths and propagates errors', async () => {
  let calls = 0
  const store = { syncFromPlatform: async (force: boolean) => { calls++; assert.equal(force, true); throw new Error('mysql unavailable') } }
  await assert.rejects(syncOperationsFromPlatform(store as unknown as OperationsRepository, '/must/not/open/sqlite', true), /mysql unavailable/)
  assert.equal(calls, 1)
})

test('MySQL refresh requires a valid explicit product database', async () => {
  assert.throws(() => new MysqlOperationsStore({} as Pool, 'ops_test', 'bad;db'), /unsafe/)
  await assert.rejects(new MysqlOperationsStore({} as Pool, 'ops_test').syncFromPlatform(), /explicit product/)
})

test('failed MySQL refresh is retryable and concurrent requests are coalesced', async () => {
  let calls = 0
  const query = async () => { calls++; throw new Error('database unavailable') }
  const store = new MysqlOperationsStore({ query } as unknown as Pool, 'ops_test', 'product_test')
  const results = await Promise.allSettled([store.syncFromPlatform(), store.syncFromPlatform()])
  assert.ok(results.every(r => r.status === 'rejected'))
  assert.equal(calls, 1)
  await assert.rejects(store.syncFromPlatform(), /database unavailable/)
  assert.equal(calls, 2)
})
