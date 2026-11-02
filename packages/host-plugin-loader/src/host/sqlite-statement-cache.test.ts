import { expect, test } from 'vitest'
import { cacheSqliteStatements, openSqlite, SQLITE_STATEMENT_CACHE_LIMIT } from './sqlite-open.ts'

test('openSqlite reuses compiled statements and they stay correct across runs', () => {
  const db = openSqlite(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const insert = db.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
  expect(db.prepare('INSERT INTO t (id, v) VALUES (?, ?)')).toBe(insert)
  insert.run(1, 'a')
  insert.run(2, 'b')
  const read = db.prepare('SELECT v FROM t WHERE id = ?')
  expect(read.get(1)).toEqual({ v: 'a' })
  expect(db.prepare('SELECT v FROM t WHERE id = ?').get(2)).toEqual({ v: 'b' })
  expect(db.prepare('SELECT v FROM t WHERE id = ?').get(3)).toBeUndefined()
  // 表结构变化后复用的语句仍按新结构执行。
  db.exec('ALTER TABLE t ADD COLUMN w TEXT')
  db.prepare('UPDATE t SET w = ? WHERE id = ?').run('x', 1)
  expect(db.prepare('SELECT v, w FROM t WHERE id = ?').get(1)).toEqual({ v: 'a', w: 'x' })
  expect(read.get(1)).toEqual({ v: 'a' })
  db.close()
})

test('the statement cache is bounded and idempotent', () => {
  const db = openSqlite(':memory:')
  cacheSqliteStatements(db)
  db.exec('CREATE TABLE t (id INTEGER)')
  const first = db.prepare('SELECT 0 AS n FROM t')
  for (let i = 1; i <= SQLITE_STATEMENT_CACHE_LIMIT + 5; i++) db.prepare(`SELECT ${i} AS n FROM t`)
  // 最早的语句已被淘汰，再取会重新编译成新对象；最近的仍命中。
  expect(db.prepare('SELECT 0 AS n FROM t')).not.toBe(first)
  const recent = db.prepare(`SELECT ${SQLITE_STATEMENT_CACHE_LIMIT + 5} AS n FROM t`)
  expect(db.prepare(`SELECT ${SQLITE_STATEMENT_CACHE_LIMIT + 5} AS n FROM t`)).toBe(recent)
  db.close()
})
