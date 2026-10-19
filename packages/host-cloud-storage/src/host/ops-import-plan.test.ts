import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { planOperationsMerge } from './ops-import-plan.ts'

const dirs: string[] = []
const UPDATED = ['ops_accounts', 'ops_workspaces', 'ops_usage_daily', 'ops_devices', 'ops_sync_health']
const CREATED = ['ops_security_events', 'ops_audit_logs']

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(path: string, source: 'online' | 'operations') {
  const db = new DatabaseSync(path)
  for (const table of UPDATED) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run('shared', source, source === 'online' ? 2 : 1)
    db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run(`${source}-only`, source, 1)
  }
  for (const table of CREATED) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, value TEXT, created_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run('shared', source, source === 'online' ? 2 : 1)
    db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run(`${source}-only`, source, 1)
  }
  db.close()
}

test('plans a union and chooses the newest conflicting row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-ops-plan-'))
  dirs.push(dir)
  const online = join(dir, 'online.sqlite')
  const operations = join(dir, 'operations.sqlite')
  fixture(online, 'online')
  fixture(operations, 'operations')

  const plan = planOperationsMerge([
    { name: 'online', path: online },
    { name: 'operations', path: operations },
  ])

  expect(plan.tables).toHaveLength(7)
  expect(plan.tables[0]).toMatchObject({
    sourceCounts: { online: 2, operations: 2 },
    uniqueRows: 3,
    duplicateIds: 1,
    conflicts: 1,
    selectedBySource: { online: 2, operations: 1 },
  })
})
