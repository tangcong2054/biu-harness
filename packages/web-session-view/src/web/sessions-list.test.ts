import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import {
  getSessionTurns,
  getSessionsList,
  resetSessionsListGet,
  seedSessionFetches,
  SESSION_LOAD_TURNS,
} from './sessions-list.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetSessionsListGet()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

test('getSessionsList shares one in-flight GET in the same account and workspace', async () => {
  localStorage.setItem('biu.account.token', 'tok')
  localStorage.setItem('biu.workspaceId', 'ws1')
  let hits = 0
  globalThis.fetch = (async () => {
    hits += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ sessions: [{ id: 's1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const [a, b] = await Promise.all([getSessionsList(), getSessionsList()])
  assert.equal(hits, 1)
  assert.equal(a?.[0]?.id, 's1')
  assert.equal(b?.[0]?.id, 's1')
})

test('getSessionsList does not reuse a request across workspaces', async () => {
  localStorage.setItem('biu.account.token', 'tok')
  sessionStorage.setItem('biu.workspaceId', 'ws1')
  let hits = 0
  globalThis.fetch = (async () => {
    hits += 1
    return new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  await getSessionsList()
  sessionStorage.setItem('biu.workspaceId', 'ws2')
  await getSessionsList()
  assert.equal(hits, 2)
})

test('getSessionTurns shares one in-flight GET', async () => {
  localStorage.setItem('biu.account.token', 'tok')
  let hits = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hits += 1
    assert.match(String(input), new RegExp(`turns=${SESSION_LOAD_TURNS}`))
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ id: 's1', events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const [a, b] = await Promise.all([getSessionTurns('s1'), getSessionTurns('s1')])
  assert.equal(hits, 1)
  assert.equal(a?.status, 200)
  assert.equal((b?.body as { id?: string }).id, 's1')
})

test('seedSessionFetches preloads turns only on chat routes', async () => {
  localStorage.setItem('biu.account.token', 'tok')
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/api/sessions')) {
      return new Response(JSON.stringify({ sessions: [{ id: 'new', updatedAt: 9 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ id: 'new', events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  window.history.replaceState({}, '', '/database')
  seedSessionFetches()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(calls, ['/api/sessions'])

  resetSessionsListGet()
  calls.length = 0
  window.history.replaceState({}, '', '/s/direct')
  seedSessionFetches()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.some((url) => url.includes(`/api/sessions/direct?turns=${SESSION_LOAD_TURNS}`)), true)
})
