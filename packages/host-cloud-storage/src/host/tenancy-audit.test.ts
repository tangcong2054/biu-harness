import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { auditSqliteTenancy, collectOwnerlessRecords } from './tenancy-audit.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('reports records that cannot receive a workspace primary key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-tenancy-audit-'))
  dirs.push(dir)
  const path = join(dir, 'source.sqlite')
  const db = new DatabaseSync(path)
  for (const table of ['pages', 'tasks', 'sessions', 'facets']) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`)
  }
  db.exec(`
    CREATE TABLE plugin_packages (id TEXT, version TEXT, PRIMARY KEY (id, version));
    CREATE TABLE editor_content (collection TEXT, record_id TEXT, PRIMARY KEY (collection, record_id));
    CREATE TABLE record_owners (
      workspace_id TEXT, collection TEXT, record_id TEXT,
      PRIMARY KEY (workspace_id, collection, record_id)
    );
    INSERT INTO pages VALUES ('owned'), ('missing');
    INSERT INTO editor_content VALUES ('/pages', 'owned'), ('/pages', 'missing');
    INSERT INTO record_owners VALUES ('ws', '/pages', 'owned');
  `)
  db.close()

  const audit = auditSqliteTenancy(path)
  expect(audit.collections.find((item) => item.collection === '/pages')).toMatchObject({
    records: 2,
    owned: 1,
    ownerless: 1,
  })
  expect(audit.editorContent.ownerless).toBe(1)
  expect(audit.canUseWorkspacePrimaryKeys).toBe(false)
  expect(collectOwnerlessRecords(path)).toEqual([{ collection: '/pages', recordId: 'missing' }])
})
