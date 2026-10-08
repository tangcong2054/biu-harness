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
import {
  appendTencentTokenPlanLog,
  llmLogDirectory,
} from './tencent-token-plan-log.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'biu-llm-log-'))
  dirs.push(dir)
  return dir
}

const entry = {
  event: 'throttled' as const,
  model: 'deepseek/deepseek-v4-flash',
  endpointId: 'token-plan',
  status: 429,
  code: 429003,
  requestId: 'req-1',
  retryAfterMs: 60_000,
  attempt: 1,
  estimatedTokens: 200_000,
  maxOutputTokens: 16_384,
  localWindowTokens: 500_000,
  localCapacity: 2_700_000,
}

test('writes a redacted structured Token Plan JSONL record', () => {
  const dir = tempDir()
  const file = appendTencentTokenPlanLog(entry, {
    env: { BIU_LLM_LOG_DIR: dir },
    now: Date.parse('2026-10-08T05:00:00.000Z'),
  })
  assert.equal(file, join(dir, 'host-llm-2026-10-08.jsonl'))
  const record = JSON.parse(readFileSync(file!, 'utf8')) as Record<string, unknown>
  assert.equal(record.provider, 'tencent-token-plan')
  assert.equal(record.code, 429003)
  assert.equal(record.requestId, 'req-1')
  assert.equal(record.localCapacity, 2_700_000)
  assert.doesNotMatch(JSON.stringify(record), /apiKey|messages|tools|secret/i)
})

test('rotates oversized logs and removes files outside retention', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'host-llm-2026-09-01.jsonl'), '{}\n')
  const options = {
    env: {
      BIU_LLM_LOG_DIR: dir,
      BIU_LLM_LOG_MAX_BYTES: '1',
      BIU_LLM_LOG_RETENTION_DAYS: '7',
    },
    now: Date.parse('2026-10-08T05:00:00.000Z'),
  }
  appendTencentTokenPlanLog(entry, options)
  appendTencentTokenPlanLog({ ...entry, event: 'retry_succeeded' }, options)
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, [
    'host-llm-2026-10-08-1.jsonl',
    'host-llm-2026-10-08.jsonl',
  ])
})

test('default log directory follows BIU_HOME', () => {
  assert.equal(
    llmLogDirectory({ BIU_HOME: '/tmp/biu-home' }, '/repo'),
    '/tmp/biu-home/.biu/logs',
  )
})
