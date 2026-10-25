import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { persistWorkspaceProfile, readWorkspaceProfile, writeWorkspaceProfile } from './workspace-profile.ts'

/** 回归点：资料保存不检查 res.ok，失败时界面显示已保存，下次登录被服务端旧值覆盖。 */

beforeEach(() => {
  localStorage.setItem('biu.account.token', 'tok')
  writeWorkspaceProfile({ name: '旧名字', avatar: '' })
})

afterEach(() => {
  localStorage.removeItem('biu.account.token')
  vi.unstubAllGlobals()
})

it('rolls back and throws when the server rejects the save', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '会话已过期' }), { status: 401 })))
  const pending = persistWorkspaceProfile({ name: '新名字', avatar: '' })
  expect(readWorkspaceProfile().name).toBe('新名字')
  await expect(pending).rejects.toThrow('会话已过期')
  expect(readWorkspaceProfile().name).toBe('旧名字')
})

it('rolls back on network errors too', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('Failed to fetch')
  }))
  await expect(persistWorkspaceProfile({ name: '新名字', avatar: '' })).rejects.toThrow('Failed to fetch')
  expect(readWorkspaceProfile().name).toBe('旧名字')
})

it('keeps the new profile when the save succeeds', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  await persistWorkspaceProfile({ name: '新名字', avatar: '' })
  expect(readWorkspaceProfile().name).toBe('新名字')
})

it('a stale failure does not undo a newer successful save', async () => {
  let rejectFirst: (error: Error) => void = () => {}
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    }))
    .mockImplementationOnce(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const first = persistWorkspaceProfile({ name: '第一次', avatar: '' })
  await persistWorkspaceProfile({ name: '第二次', avatar: '' })
  rejectFirst(new Error('late failure'))
  await expect(first).rejects.toThrow('late failure')
  expect(readWorkspaceProfile().name).toBe('第二次')
})
