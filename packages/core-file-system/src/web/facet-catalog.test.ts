import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FACETS_SAVE_FAILED_EVENT, loadFacets, persistFacets } from './facet-catalog.ts'

/** 回归点：分面保存先写内存再 `.catch(() => undefined)` 吞掉失败，界面停在服务端没有的配置上。 */

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  await persistFacets([{ id: 'base', label: '基线', fields: [] }])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('rolls facets back and announces the failure when the save is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '没有权限' }), { status: 403 })))
  const failures: string[] = []
  const onFailed = (event: Event) => failures.push(String((event as CustomEvent<{ error?: string }>).detail?.error))
  window.addEventListener(FACETS_SAVE_FAILED_EVENT, onFailed)
  try {
    const pending = persistFacets([{ id: 'base', label: '基线', fields: [] }, { id: 'extra', label: '新增', fields: [] }])
    expect(loadFacets().map((item) => item.id)).toEqual(['base', 'extra'])
    expect(await pending).toBe(false)
    expect(loadFacets().map((item) => item.id)).toEqual(['base'])
    expect(failures).toEqual(['没有权限'])
  } finally {
    window.removeEventListener(FACETS_SAVE_FAILED_EVENT, onFailed)
  }
})

it('keeps the new facets when the save succeeds', async () => {
  expect(await persistFacets([{ id: 'base', label: '基线', fields: [] }, { id: 'ok', label: '成功', fields: [] }])).toBe(true)
  expect(loadFacets().map((item) => item.id)).toEqual(['base', 'ok'])
})
