import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadViews, pullSavedViews, pushSavedViews, rememberViews, savedViewMutations, SavedViewSaveError } from './view-storage.ts'
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
  sessionStorage.setItem('biu.workspaceId', `save-test-${++sequence}`)
})
afterEach(() => { vi.unstubAllGlobals() })

const view = (id: string, extra: Partial<SavedView> = {}) => normalizeSavedView({
  id, name: id, mode: 'table', sortField: 'title', sortDir: 'asc', filters: {}, columns: [], ...extra,
} as SavedView)
const ok = (views: unknown[]) => new Response(JSON.stringify({ ok: true, views }), { status: 200 })
const fail = (status: number, code = '') => new Response(JSON.stringify({ code, error: 'x' }), { status })
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as { path: string; mutations: Array<Record<string, unknown>> }

describe('incremental saved view diff', () => {
  it('emits only creates, real changes and explicit deletes against the confirmed base', () => {
    const base = new Map([['a', view('a', { revision: 3 })], ['b', view('b', { revision: 1 })], ['c', view('c', { revision: 2 })]])
    const out = savedViewMutations('/pages', base, [view('a', { revision: 99 }), view('b', { name: 'renamed' }), view('d'), view('builtin-all:/pages', { builtin: true })])
    expect(out.map((m) => [m.type, m.id, 'expectedRevision' in m ? m.expectedRevision : undefined])).toEqual([
      ['update', 'b', 1], ['create', 'd', undefined], ['delete', 'c', 2],
    ])
    for (const m of out) if ('view' in m) expect(m.view).not.toHaveProperty('revision')
  })

  it('treats a missing base revision as legacy version zero', () => {
    const out = savedViewMutations('/pages', new Map([['old', view('old')]]), [])
    expect(out).toEqual([{ type: 'delete', collection: '/pages', id: 'old', expectedRevision: 0 }])
  })
})

describe('incremental saved view push', () => {
  it('does not send unchanged lists and never sends a full view list', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await pushSavedViews('/pages', [view('a', { revision: 1 })], [view('a', { revision: 1 })])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serializes saves and uses the confirmed revision for the next change', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const fetch = vi.fn()
      .mockImplementationOnce(async () => { await gate; return ok([{ id: 'a', revision: 2 }]) })
      .mockResolvedValueOnce(ok([{ id: 'a', revision: 3 }]))
    vi.stubGlobal('fetch', fetch)
    const before = [view('a', { revision: 1 })]
    const first = pushSavedViews('/pages', [view('a', { name: 'one' })], before)
    const second = pushSavedViews('/pages', [view('a', { name: 'two' })], [view('a', { name: 'one' })])
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(bodyOf(fetch.mock.calls[0]!).mutations[0]).toMatchObject({ type: 'update', expectedRevision: 1 })
    expect(bodyOf(fetch.mock.calls[1]!).mutations[0]).toMatchObject({ type: 'update', expectedRevision: 2 })
  })

  it('keeps another window\'s new view: deletes are explicit, absence on a stale list is not a delete', async () => {
    rememberViews('/pages', [view('mine', { revision: 1 })])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [
        { id: 'pages::mine', viewId: 'mine', revision: 1, title: 'mine', tablePath: '/pages' },
        { id: 'pages::other', viewId: 'other', revision: 1, title: 'other', tablePath: '/pages' },
      ], total: 2,
    }))).mockResolvedValueOnce(ok([{ id: 'new', revision: 1 }])))
    await pullSavedViews(['/pages'], true)
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>
    await pushSavedViews('/pages', [...loadViews('/pages'), view('new')], loadViews('/pages'))
    expect(bodyOf(fetch.mock.calls[1]!).mutations).toEqual([expect.objectContaining({ type: 'create', id: 'new' })])
  })

  it('writes confirmed revisions back to the cache', async () => {
    rememberViews('/pages', [view('a', { name: 'edited' })])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok([{ id: 'a', revision: 5 }])))
    await pushSavedViews('/pages', [view('a', { name: 'edited' })], [view('a', { revision: 4 })])
    expect(loadViews('/pages')[0]?.revision).toBe(5)
  })

  it('reports conflicts and drops the stale baseline so the next save uses fresh server data', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(fail(409, 'SAVED_VIEW_CONFLICT')).mockResolvedValueOnce(ok([{ id: 'a', revision: 8 }]))
    vi.stubGlobal('fetch', fetch)
    const error = await pushSavedViews('/pages', [view('a', { name: 'x' })], [view('a', { revision: 1 })]).catch((e) => e)
    expect(error).toBeInstanceOf(SavedViewSaveError)
    expect(error).toMatchObject({ conflict: true, code: 'SAVED_VIEW_CONFLICT' })
    await pushSavedViews('/pages', [view('a', { name: 'y' })], [view('a', { revision: 7 })])
    expect(bodyOf(fetch.mock.calls[1]!).mutations[0]).toMatchObject({ expectedRevision: 7 })
  })

  it('continues the queue after a failed request', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok([{ id: 'b', revision: 1 }]))
    vi.stubGlobal('fetch', fetch)
    const a = pushSavedViews('/pages', [view('a')], [])
    const b = pushSavedViews('/pages', [view('b')], [])
    await expect(a).rejects.toThrow('offline')
    await b
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refuses to send a queued save after the workspace changed', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const fetch = vi.fn().mockImplementationOnce(async () => { await gate; return ok([{ id: 'a', revision: 1 }]) })
    vi.stubGlobal('fetch', fetch)
    const first = pushSavedViews('/pages', [view('a')], [])
    const second = pushSavedViews('/pages', [view('a'), view('b')], [view('a')])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    sessionStorage.setItem('biu.workspaceId', 'switched')
    release()
    await first
    await expect(second).rejects.toMatchObject({ code: 'SAVED_VIEW_SCOPE' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
