import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DbRecord } from '@biu/type-file-system'
import { ScriptPane } from './detail-panes.tsx'

/** 回归点：自动触发开关保存失败时，界面停在「已开启」，服务端仍是关闭，且没有任何提示。 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const record = { id: 't1', updatedAt: 1, trigger: { enabled: false } } as unknown as DbRecord

it('rolls the trigger switch back and explains why when saving fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '没有编辑权限' }), { status: 403 })))
  render(<ScriptPane record={record} />)
  const toggle = screen.getByRole('checkbox') as HTMLInputElement
  expect(toggle.checked).toBe(false)
  fireEvent.click(toggle)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('没有编辑权限'))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})

it('keeps the optimistic state when saving succeeds', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  render(<ScriptPane record={record} />)
  fireEvent.click(screen.getByRole('checkbox'))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
})
