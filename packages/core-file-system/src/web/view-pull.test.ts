import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadViews, pullSavedViews, rememberViews, savedViewFromRecord, viewsKey } from './view-storage.ts'
import { normalizeSavedView, type SavedView } from './saved-view.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
let sequence = 0
beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  sessionStorage.setItem('biu.workspaceId', `pull-test-${++sequence}`)
})
afterEach(() => { vi.unstubAllGlobals() })
const row = (viewId: string, revision = 1) => ({ id: `pages::${viewId}`, viewId, revision, title: viewId, tablePath: '/pages' })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const snapshot = (items: ReturnType<typeof row>[]) => json({ items, total: items.length, snapshot: true })
const page = (items: ReturnType<typeof row>[], total = items.length) => json({ items, total })
const view = (id: string) => normalizeSavedView({ id, name: id, mode: 'table', sortField: 'title', sortDir: 'asc', filters: {}, columns: [] })
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
type Handler = () => Response | Promise<Response>
/** 按 URL 分发：快照接口与分页接口各自按顺序返回。 */
function router(routes: { snapshot?: Handler[]; list?: Handler[] }) {
  const calls: string[] = []
  const fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const queue = url.startsWith('/api/db/saved-views') ? routes.snapshot : routes.list
    const next = queue?.shift()
    if (!next) throw new Error(`unexpected request ${url}`)
    return next()
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, calls }
}
const unsupported = () => json({ error: 'not found' }, 404)

describe('saved view snapshot pulls', () => {
  it('reads every view in one consistent snapshot, beyond 200 rows, with revisions', async () => {
    const items = Array.from({ length: 450 }, (_, i) => row(`v${i}`, i % 7))
    const { calls } = router({ snapshot: [() => snapshot(items)] })
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')).toHaveLength(450)
    expect(loadViews('/pages').find((v) => v.id === 'v13')?.revision).toBe(6)
    expect(calls).toEqual(['/api/db/saved-views'])
  })

  it('does not publish a malformed or mismatched snapshot', async () => {
    rememberViews('/pages', [view('local')])
    for (const bad of [
      () => json({ items: [row('a')], total: 2, snapshot: true }),
      () => json({ items: [row('a'), row('a')], total: 2, snapshot: true }),
      () => json({ items: [row('a')], total: 1 }),
      () => json({ items: 'nope', total: 1, snapshot: true }),
      () => json({ error: 'denied' }, 403),
    ]) {
      router({ snapshot: [bad] })
      await pullSavedViews(['/pages'], true)
      expect(loadViews('/pages').map((v) => v.id)).toEqual(['local'])
    }
  })

  it('does not fall back to paging when the snapshot fails for reasons other than an old server', async () => {
    const { calls } = router({ snapshot: [() => json({ error: 'x' }, 500)] })
    await pullSavedViews(['/pages'])
    expect(calls).toEqual(['/api/db/saved-views'])
  })

  it('shares an in-flight request and only applies ttl after success', async () => {
    const pending = gate<Response>()
    const { fetch } = router({ snapshot: [() => pending.promise, () => snapshot([row('b')])] })
    const a = pullSavedViews(['/pages'])
    const b = pullSavedViews(['/pages'])
    pending.resolve(snapshot([row('a')]))
    await Promise.all([a, b])
    expect(fetch).toHaveBeenCalledTimes(1)
    await pullSavedViews(['/pages'])
    expect(fetch).toHaveBeenCalledTimes(1)
    await pullSavedViews(['/pages'], true)
    expect(loadViews('/pages')[0]?.id).toBe('b')
  })

  it('retries immediately after a network failure without wiping local data', async () => {
    rememberViews('/pages', [view('local')])
    const { fetch } = router({ snapshot: [() => { throw new Error('offline') }, () => snapshot([row('server')])] })
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('local')
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('server')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('discards a previous account response after switching accounts', async () => {
    const old = gate<Response>()
    router({ snapshot: [() => old.promise, () => snapshot([row('bob')])] })
    localStorage.setItem('biu.account.token', 'ada')
    const adaKey = viewsKey('/pages')
    const a = pullSavedViews(['/pages'])
    localStorage.setItem('biu.account.token', 'bob')
    await pullSavedViews(['/pages'])
    old.resolve(snapshot([row('ada')]))
    await a
    expect(loadViews('/pages').map((v) => v.id)).toEqual(['bob'])
    expect(localStorage.getItem(adaKey)).toBeNull()
  })

  it('discards previous workspace responses', async () => {
    const old = gate<Response>()
    router({ snapshot: [() => old.promise, () => snapshot([row('other')])] })
    const a = pullSavedViews(['/pages'])
    sessionStorage.setItem('biu.workspaceId', `other-${sequence}`)
    await pullSavedViews(['/pages'])
    old.resolve(snapshot([row('old')]))
    await a
    expect(loadViews('/pages')[0]?.id).toBe('other')
  })

  it('does not overwrite edits made while the request was pending', async () => {
    const pending = gate<Response>()
    router({ snapshot: [() => pending.promise, () => snapshot([row('confirmed')])] })
    const request = pullSavedViews(['/pages'])
    rememberViews('/pages', [view('editing')])
    pending.resolve(snapshot([row('stale')]))
    await request
    expect(loadViews('/pages')[0]?.id).toBe('editing')
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('confirmed')
  })

  it('clears an explicitly requested empty collection without reusing another collection ttl', async () => {
    router({ snapshot: [() => snapshot([]), () => snapshot([])] })
    await pullSavedViews(['/pages'])
    rememberViews('/tasks', [view('old')])
    await pullSavedViews(['/tasks'])
    expect(loadViews('/tasks')).toEqual([])
  })
})

describe('fallback paging for servers without the snapshot endpoint', () => {
  it('pages beyond 200 rows when the snapshot endpoint is missing', async () => {
    const first = Array.from({ length: 200 }, (_, i) => row(String(i), 7))
    const { calls } = router({ snapshot: [unsupported], list: [() => page(first, 201), () => page([row('last', 8)], 201)] })
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')).toHaveLength(201)
    expect(loadViews('/pages').find((v) => v.id === 'last')?.revision).toBe(8)
    const params = calls.slice(1).map((url) => new URL(url, 'http://localhost').searchParams)
    expect(params.map((p) => p.get('offset'))).toEqual(['0', '200'])
    expect(params[0]?.get('columns')?.split(',')).toContain('revision')
    expect(params[0]?.get('sort')).toBe('id')
  })

  it('does not publish partial data if a later page fails', async () => {
    rememberViews('/pages', [view('local')])
    router({ snapshot: [unsupported], list: [() => page([row('partial')], 2), () => { throw new Error('offline') }] })
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages').map((v) => v.id)).toEqual(['local'])
  })

  it.each(['changed-total', 'empty-page', 'duplicate'])('discards inconsistent pagination: %s', async (kind) => {
    rememberViews('/pages', [view('local')])
    const second = kind === 'changed-total' ? page([row('b')], 3)
      : kind === 'empty-page' ? page([], 2) : page([row('a')], 2)
    router({ snapshot: [unsupported], list: [() => page([row('a')], 2), () => second] })
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('local')
  })
})

describe('saved view rows', () => {
  it('keeps version zero but does not invent versions for missing or invalid values', () => {
    expect(savedViewFromRecord(row('legacy', 0))?.revision).toBe(0)
    for (const revision of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(savedViewFromRecord({ ...row('bad'), revision })?.revision).toBeUndefined()
    }
    expect(normalizeSavedView({ ...view('v'), revision: 8 } as SavedView).revision).toBe(8)
  })
})
