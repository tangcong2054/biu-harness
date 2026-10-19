import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { inspectSqliteReadOnly } from './sqlite-inventory.ts'
import { createSqliteSnapshot } from './sqlite-snapshot.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('creates an intact snapshot without migrating the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-cloud-snapshot-'))
  dirs.push(dir)
  const source = join(dir, 'source.sqlite')
  const destination = join(dir, 'snapshots', 'copy.sqlite')
  const db = new DatabaseSync(source)
  db.exec(`
    PRAGMA user_version = 7;
    CREATE TABLE pages (id TEXT PRIMARY KEY);
    INSERT INTO pages (id) VALUES ('one'), ('two');
  `)
  db.close()

  await createSqliteSnapshot(source, destination)

  expect(inspectSqliteReadOnly(source).userVersion).toBe(7)
  expect(inspectSqliteReadOnly(destination)).toMatchObject({
    userVersion: 7,
    tables: [{ name: 'pages', rows: 2 }],
  })
})
