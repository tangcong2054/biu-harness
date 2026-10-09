import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { UiActionsObservability } from './observability.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'biu-ui-observe-'))
  dirs.push(dir)
  return dir
}

test('writes redacted metadata-only JSONL and exposes counters', async () => {
  const dir = tempDir()
  const observer = new UiActionsObservability({
    env: { BIU_UI_ACTION_LOG_DIR: dir },
    now: () => Date.parse('2026-10-08T12:00:00.000Z'),
    flushMs: 60_000,
  })
  observer.record({
    event: 'started',
    command: 'action',
    sessionId: 's1',
    clientId: 'c1',
    plugin: 'websql',
    ref: 'ui:websql:main',
    actions: ['execute'],
    risks: ['submit'],
  })
  observer.record({
    event: 'succeeded',
    command: 'action',
    sessionId: 's1',
    clientId: 'c1',
    plugin: 'websql',
    ref: 'ui:websql:main',
    actions: ['execute'],
    durationMs: 25,
    resultBytes: 120,
  })
  await observer.flush()
  const file = join(dir, 'ui-actions-2026-10-08.jsonl')
  const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 2)
  assert.equal(records[1]?.durationMs, 25)
  assert.doesNotMatch(JSON.stringify(records), /"(args|result|password|secret)"/i)
  const metrics = observer.snapshot()
  assert.equal(metrics.byEvent.started, 1)
  assert.equal(metrics.byEvent.succeeded, 1)
  assert.equal(metrics.duration.averageMs, 25)
})

test('rotates files, prunes old logs, and bounds the in-memory queue', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'ui-actions-2026-09-01.jsonl'), '{}\n')
  const observer = new UiActionsObservability({
    env: {
      BIU_UI_ACTION_LOG_DIR: dir,
      BIU_UI_ACTION_LOG_MAX_BYTES: '1',
      BIU_UI_ACTION_LOG_RETENTION_DAYS: '7',
    },
    now: () => Date.parse('2026-10-08T12:00:00.000Z'),
    flushMs: 60_000,
    queueMax: 2,
  })
  observer.record({ event: 'started', command: 'inspect' })
  observer.record({ event: 'cache_miss', command: 'inspect', cacheHit: false })
  observer.record({ event: 'succeeded', command: 'inspect' })
  assert.equal(observer.snapshot().dropped, 1)
  await observer.flush()
  observer.record({ event: 'cache_hit', command: 'inspect', cacheHit: true })
  await observer.flush()
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, [
    'ui-actions-2026-10-08-1.jsonl',
    'ui-actions-2026-10-08.jsonl',
  ])
  assert.equal(observer.snapshot().cache.hits, 1)
  assert.equal(observer.snapshot().cache.misses, 1)
})

test('logging failures never throw into the action path', async () => {
  const dir = tempDir()
  const file = join(dir, 'not-a-directory')
  writeFileSync(file, 'occupied')
  const observer = new UiActionsObservability({
    env: { BIU_UI_ACTION_LOG_DIR: file },
    flushMs: 60_000,
  })
  assert.doesNotThrow(() => observer.record({ event: 'failed', command: 'action' }))
  await assert.doesNotReject(() => observer.flush())
})
