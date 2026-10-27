/** @vitest-environment node */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { forkTurnFromBody } from './index.ts'

test('fork 请求体解析：没有请求体时回落成整段复制', () => {
  // 旧前端发的是不带 body 的 POST，json() 会得到 null / undefined；
  // 这里必须返回 undefined，不能抛错（之前就是读 null.untilTurn 导致 400）。
  assert.equal(forkTurnFromBody(null), undefined)
  assert.equal(forkTurnFromBody(undefined), undefined)
  assert.equal(forkTurnFromBody({}), undefined)
  assert.equal(forkTurnFromBody(''), undefined)
  assert.equal(forkTurnFromBody([]), undefined)
  assert.equal(forkTurnFromBody('null'), undefined)
})

test('fork 请求体解析：只接受正整数的 untilTurn', () => {
  assert.equal(forkTurnFromBody({ untilTurn: 3 }), 3)
  assert.equal(forkTurnFromBody({ untilTurn: '2' }), 2)
  assert.equal(forkTurnFromBody({ untilTurn: 0 }), undefined)
  assert.equal(forkTurnFromBody({ untilTurn: -1 }), undefined)
  assert.equal(forkTurnFromBody({ untilTurn: null }), undefined)
  assert.equal(forkTurnFromBody({ untilTurn: 'abc' }), undefined)
  assert.equal(forkTurnFromBody({ untilTurn: Number.NaN }), undefined)
})
