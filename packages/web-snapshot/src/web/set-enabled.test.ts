import { afterEach, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { SnapshotService } from './index.ts'

/** 回归点：插件开关不检查 res.ok，把 `{ error }` 响应体当快照合并进状态，界面静默不变。 */

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('biu.account.token')
})

it('setEnabled throws on a rejected toggle and leaves the snapshot untouched', async () => {
  localStorage.removeItem('biu.account.token')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '核心层不能卸载' }), { status: 400 })))
  const service = new SnapshotService(new Context())
  const before = service.get()
  await expect(service.setEnabled('core-chat', false)).rejects.toThrow('核心层不能卸载')
  expect(service.get()).toEqual(before)
  expect((service.get() as unknown as { error?: unknown }).error).toBeUndefined()
})
