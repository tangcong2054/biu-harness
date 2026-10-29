import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'web/index.tsx'), 'utf8')

test('history and snapshot share one persist path read through a ref', () => {
  // 挂载时捕获的 onHistory 会带旧块数据整块覆盖回去；必须统一走 ref。
  assert.doesNotMatch(source, /onHistory/)
  assert.doesNotMatch(source, /onSnapshot/)
  assert.match(source, /onPersistRef\.current = onPersist/)
  assert.match(source, /onPersistRef\.current\(patch\)/)
})

test('snapshot writes are throttled instead of firing after every quiet output', () => {
  assert.doesNotMatch(source, /SNAPSHOT_SETTLE_MS/)
  assert.match(source, /SNAPSHOT_INTERVAL_MS = 30_000/)
  // 节流：已有定时器就不再重排，持续输出时最多一个间隔写一次。
  assert.match(source, /if \(snapshotTimer\) return\s+snapshotTimer = window\.setTimeout\(persist, SNAPSHOT_INTERVAL_MS\)/)
})

test('enter does not write on its own; the command is persisted once with its output', () => {
  const enter = source.slice(source.indexOf("if (ch === '\\r' || ch === '\\n')"), source.indexOf("if (ch === '\\x7f'"))
  assert.match(enter, /historyDirty = true/)
  assert.doesNotMatch(enter, /persist\(\)/)
  assert.match(source, /if \(historyDirty\) persist\(\)/)
})

test('pending writes are flushed when the page is hidden, closed or the block unmounts', () => {
  assert.match(source, /document\.visibilityState === 'hidden'\) flushPending\(\)/)
  assert.match(source, /window\.addEventListener\('pagehide', flushPending\)/)
  assert.match(source, /window\.removeEventListener\('pagehide', flushPending\)/)
})

test('snapshot stays small because every page save carries it', () => {
  assert.match(source, /const SNAPSHOT_LINES = 80\b/)
  assert.match(source, /const SNAPSHOT_CHARS = 2_000\b/)
})
