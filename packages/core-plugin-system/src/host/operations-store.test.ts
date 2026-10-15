/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { openSqlite } from '@biu/host-plugin-loader/data-dir'
import { OperationsStore } from './operations-store.ts'

test('operations metadata stays separate and rejects secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-ops-'))
  try {
    const store = new OperationsStore(openSqlite(join(dir, 'ops.sqlite')))
    store.upsert('account', {
      id: 'acc_1',
      email: 'ada@example.com',
      name: 'Ada',
      password: 'secret',
      token: 'tok',
      workspaceCount: 2,
    })
    const account = store.list('account')[0]
    assert.equal(account?.email, 'ada@example.com')
    assert.equal(JSON.stringify(account).includes('secret'), false)
    assert.equal(store.setAccountStatus('acc_1', 'suspended', 'acc_operations_admin')?.status, 'suspended')
    assert.equal(store.audits()[0]?.action, 'suspend-account')
    assert.equal(store.counts().accounts, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
