/** @vitest-environment node */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { forkOptionsFromBody } from './index.ts'

test('fork 仅无请求体时沿用全量复制', () => {
  assert.equal(forkOptionsFromBody(null), undefined)
  assert.equal(forkOptionsFromBody(undefined), undefined)
  for (const body of [{}, '', [], 'null', { untilSeq: null }, { untilSeq: -1 }, { untilTurn: 99.5 }]) {
    assert.throws(() => forkOptionsFromBody(body), /fork/)
  }
})

test('fork 按回复事件序号定位（允许首条事件 seq=0），兼容旧回合号', () => {
  assert.deepEqual(forkOptionsFromBody({ untilSeq: 0 }), { untilSeq: 0 })
  assert.deepEqual(forkOptionsFromBody({ untilSeq: 10 }), { untilSeq: 10 })
  assert.deepEqual(forkOptionsFromBody({ untilTurn: 2 }), { untilTurn: 2 })
  assert.throws(() => forkOptionsFromBody({ untilTurn: 0 }), /invalid fork turn/)
})
