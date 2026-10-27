import assert from 'node:assert/strict'
import { test } from 'vitest'
import { apply, SESSION_GONE_CODE, type Socket } from './host/index.ts'

function fakeHost() {
  let wsHandler: ((socket: Socket, request: { url?: string }) => void) | undefined
  const ctx = {
    sandbox: { wrap: () => ({ cwd: process.cwd(), env: {} }) },
    http: {
      ws: (_path: string, listener: typeof wsHandler) => {
        wsHandler = listener
      },
      route: () => {},
    },
    effect: () => {},
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  const connect = (query: string) => {
    const closed: Array<{ code?: number; reason?: string }> = []
    const socket: Socket = {
      readyState: 1,
      OPEN: 1,
      send: () => {},
      close: (code, reason) => closed.push({ code, reason }),
      on: () => {},
    }
    wsHandler!(socket, { url: `/ws/page-terminal?${query}` })
    return closed
  }
  return { connect }
}

test('attach=1 to a missing session closes with SESSION_GONE_CODE and does not spawn', () => {
  const { connect } = fakeHost()
  const closed = connect('session=nope&attach=1&cols=80&rows=20')
  assert.deepEqual(closed, [{ code: SESSION_GONE_CODE, reason: 'session gone' }])
})
