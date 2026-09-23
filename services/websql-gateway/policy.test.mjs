import test from 'node:test'
import assert from 'node:assert/strict'
import { validateReadOnlySql } from './policy.mjs'

test('允许只读查询', () => {
  for (const sql of [
    'SELECT * FROM users LIMIT 20',
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM users',
    'WITH recent AS (SELECT * FROM logs LIMIT 10) SELECT * FROM recent',
    "SELECT 'DELETE FROM users' AS example",
  ]) {
    assert.equal(validateReadOnlySql(sql).ok, true, sql)
  }
})

test('拒绝写操作、多语句、锁和客户端命令', () => {
  for (const sql of [
    'INSERT INTO users(name) VALUES ("x")',
    'UPDATE users SET name = "x"',
    'DELETE FROM users',
    'DROP TABLE users',
    'SELECT * FROM users; DELETE FROM users',
    'EXPLAIN UPDATE users SET name = "x"',
    'SELECT * FROM users FOR UPDATE',
    "SELECT 1 INTO OUTFILE '/tmp/result'",
    'SELECT GET_LOCK("demo", 1)',
    'SELECT SLEEP(10)',
    '\\! rm -rf /tmp/demo',
    'SELECT 1 /*!50000 ; DROP TABLE users */',
  ]) {
    assert.equal(validateReadOnlySql(sql).ok, false, sql)
  }
})
