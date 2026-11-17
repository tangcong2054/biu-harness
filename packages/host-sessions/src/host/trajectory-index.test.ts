import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { SessionEvent, SessionEventBody } from '@biu/type-session'
import { buildTrajectoryWindow, findEvent, buildRequestMessages } from './trajectory-index.ts'

function ev(partial: SessionEventBody & { seq: number; ts?: number }): SessionEvent {
  return { ...partial, ts: partial.ts ?? partial.seq }
}

test('handoff notices are observable without becoming model instructions or compact boundaries', () => {
  const raw: SessionEvent[] = [
    ev({ type: 'turn/start', turn: 1, seq: 0 }),
    ev({ type: 'user/message', text: 'continue', kind: 'wake', seq: 1 }),
    ev({ type: 'step/start', turn: 1, step: 0, seq: 2 }),
    ev({ type: 'context/handoff', turn: 1, step: 0, kind: 'handoff', messages: 2, seq: 3 }),
    ev({ type: 'assistant/message', text: 'done', seq: 4 }),
  ]
  const messages = buildRequestMessages(raw, 4)
  assert.deepEqual(messages, buildRequestMessages(raw.filter((event) => event.type !== 'context/handoff'), 4))
  const row = buildTrajectoryWindow(raw, 2).rows.find((item) => item.type === 'context/handoff')!
  assert.equal(row.turn, 1)
  assert.equal(row.step, 0)
  assert.match(row.summary, /上下文交接记录.*2.*请求准备/)
})

test('trajectory window returns summary rows without full bodies', () => {
  const raw: SessionEvent[] = [ev({ type: 'session/open', version: 1, seq: 0 })]
  for (let i = 0; i < 3; i++) {
    raw.push(ev({ type: 'user/message', text: `u${i}-${'x'.repeat(200)}`, kind: 'wake', seq: 10 + i * 2 }))
    raw.push(
      ev({
        type: 'assistant/message',
        text: `a${i}-${'y'.repeat(200)}`,
        seq: 11 + i * 2,
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    )
  }
  const window = buildTrajectoryWindow(raw, 2)
  assert.equal(window.hasMore, true)
  assert.ok(window.rows.every((row) => row.summary.length <= 160))
  assert.equal(window.rows.some((row) => row.type === 'assistant/message'), true)
})

test('findEvent and buildRequestMessages for assistant detail', () => {
  const raw: SessionEvent[] = [
    ev({ type: 'session/open', version: 1, seq: 0 }),
    ev({ type: 'system/prompt', text: 'sys', seq: 1 }),
    ev({ type: 'user/message', text: 'hi', kind: 'wake', seq: 2 }),
    ev({ type: 'assistant/message', text: 'yo', seq: 3, usage: { inputTokens: 1, outputTokens: 1 } }),
  ]
  const event = findEvent(raw, 3)
  assert.equal(event?.type, 'assistant/message')
  const messages = buildRequestMessages(raw, 3)
  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages.some((item) => item.role === 'user' && item.content === 'hi'), true)
})
