import assert from 'node:assert/strict'
import { test } from 'vitest'
import { activeSocketAfterDetach, broadcastSockets, buildMysqlArgs, isUnsafeMysqlSql, type Socket } from './host.ts'

function socket(sent: string[]): Socket {
  return {
    readyState: 1,
    OPEN: 1,
    send: (data) => sent.push(data),
    close: () => undefined,
    on: () => undefined,
  }
}

test('mysql batch arguments keep credentials out of argv', () => {
  const args = buildMysqlArgs('select 1', {
    host: 'db.internal',
    port: 3307,
    user: 'reader',
    password: 'secret',
    database: 'analytics',
  })

  assert.deepEqual(args, [
    '-h',
    'db.internal',
    '-P',
    '3307',
    '-u',
    'reader',
    '--connect-timeout=8',
    '--batch',
    '--raw',
    '--default-character-set=utf8mb4',
    '-D',
    'analytics',
    '-e',
    'select 1',
  ])
  assert.doesNotMatch(args.join(' '), /secret/)
})

test('mysql batch rejects client-side shell escape commands', () => {
  assert.equal(isUnsafeMysqlSql('select 1'), false)
  assert.equal(isUnsafeMysqlSql('\\! rm -rf /'), true)
  assert.equal(isUnsafeMysqlSql('SYSTEM uname -a'), true)
  assert.equal(isUnsafeMysqlSql('source secrets.sql'), true)
})

test('terminal output is broadcast to every attached window', () => {
  const first: string[] = []
  const second: string[] = []
  broadcastSockets(new Set([socket(first), socket(second)]), 'hello')
  assert.deepEqual(first, ['hello'])
  assert.deepEqual(second, ['hello'])
})

test('active terminal falls back to another window after detach', () => {
  const first = socket([])
  const second = socket([])
  const sockets = new Set([second])
  assert.equal(activeSocketAfterDetach(sockets, first, first), second)
  assert.equal(activeSocketAfterDetach(sockets, second, first), second)
})
