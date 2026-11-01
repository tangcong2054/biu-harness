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
const response = (items: ReturnType<typeof row>[], total = items.length) => new Response(JSON.stringify({ items, total }), { status: 200 })
const view = (id: string) => normalizeSavedView({ id, name: id, mode: 'table', sortField: 'title', sortDir: 'asc', filters: {}, columns: [] })
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('saved view authoritative pulls', () => {
  it('reads beyond the first 200 rows and carries explicit versions', async () => {
    const first = Array.from({ length: 200 }, (_, i) => row(String(i), 7))
    const fetch = vi.fn().mockResolvedValueOnce(response(first, 201)).mockResolvedValueOnce(response([row('last', 8)], 201))
    vi.stubGlobal('fetch', fetch)
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')).toHaveLength(201)
    expect(loadViews('/pages').find((v) => v.id === 'last')?.revision).toBe(8)
    const requests = fetch.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').searchParams)
    expect(requests.map((params) => params.get('offset'))).toEqual(['0', '200'])
    expect(requests[0]?.get('columns')?.split(',')).toContain('revision')
    expect(requests[0]?.get('sort')).toBe('id')
  })

  it('shares an in-flight request and only applies ttl after success', async () => {
    const pending = gate<Response>()
    const fetch = vi.fn().mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetch)
    const a = pullSavedViews(['/pages'])
    const b = pullSavedViews(['/pages'])
    expect(fetch).toHaveBeenCalledTimes(1)
    pending.resolve(response([row('a')]))
    await Promise.all([a, b])
    await pullSavedViews(['/pages'])
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValueOnce(response([row('b')]))
    await pullSavedViews(['/pages'], true)
    expect(loadViews('/pages')[0]?.id).toBe('b')
  })

  it('retries immediately after a network failure without wiping local data', async () => {
    rememberViews('/pages', [view('local')])
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response([row('server')]))
    vi.stubGlobal('fetch', fetch)
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('local')
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('server')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not publish partial data if a later page fails', async () => {
    rememberViews('/pages', [view('local')])
    const fetch = vi.fn().mockResolvedValueOnce(response([row('partial')], 2)).mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages').map((v) => v.id)).toEqual(['local'])
  })

  it.each(['changed-total', 'empty-page', 'duplicate'])('discards inconsistent pagination: %s', async (kind) => {
    rememberViews('/pages', [view('local')])
    const second = kind === 'changed-total' ? response([row('b')], 3)
      : kind === 'empty-page' ? response([], 2) : response([row('a')], 2)
    const fetch = vi.fn().mockResolvedValueOnce(response([row('a')], 2)).mockResolvedValueOnce(second)
    vi.stubGlobal('fetch', fetch)
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('local')
  })

  it('does not share list responses between accounts or publish a previous account response', async () => {
    const old = gate<Response>()
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([row('bob')]))
    vi.stubGlobal('fetch', fetch)
    localStorage.setItem('biu.account.token', 'ada')
    const adaKey = viewsKey('/pages')
    const a = pullSavedViews(['/pages'])
    localStorage.setItem('biu.account.token', 'bob')
    await pullSavedViews(['/pages'])
    expect(fetch).toHaveBeenCalledTimes(2)
    old.resolve(response([row('ada')]))
    await a
    expect(loadViews('/pages').map((v) => v.id)).toEqual(['bob'])
    expect(localStorage.getItem(adaKey)).toBeNull()
  })

  it('discards previous workspace responses', async () => {
    const old = gate<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([row('other')])) )
    const a = pullSavedViews(['/pages'])
    sessionStorage.setItem('biu.workspaceId', `other-${sequence}`)
    await pullSavedViews(['/pages'])
    old.resolve(response([row('old')]))
    await a
    expect(loadViews('/pages')[0]?.id).toBe('other')
  })

  it('does not overwrite edits made while the request was pending', async () => {
    const pending = gate<Response>()
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response([row('confirmed')]))
    vi.stubGlobal('fetch', fetch)
    const request = pullSavedViews(['/pages'])
    rememberViews('/pages', [view('editing')])
    pending.resolve(response([row('stale')]))
    await request
    expect(loadViews('/pages')[0]?.id).toBe('editing')
    await pullSavedViews(['/pages'])
    expect(loadViews('/pages')[0]?.id).toBe('confirmed')
  })

  it('clears an explicitly requested empty collection without reusing another collection ttl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response([])))
    await pullSavedViews(['/pages'])
    rememberViews('/tasks', [view('old')])
    await pullSavedViews(['/tasks'])
    expect(loadViews('/tasks')).toEqual([])
  })

  it('keeps version zero but does not invent versions for missing or invalid values', () => {
    expect(savedViewFromRecord(row('legacy', 0))?.revision).toBe(0)
    for (const revision of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(savedViewFromRecord({ ...row('bad'), revision })?.revision).toBeUndefined()
    }
    expect(normalizeSavedView({ ...view('v'), revision: 8 } as SavedView).revision).toBe(8)
  })
})
