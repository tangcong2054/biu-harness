/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Context } from 'cordis'
import type { SlotProps } from '@biu/web-slots'
import { bindSessionView, resetSessionsListGet, SessionViewService } from '@biu/web-session-view'
import { ChatComposer } from './composer.tsx'

vi.mock('./model-config-dialog.tsx', () => ({ ModelConfigDialog: () => null }))
vi.mock('./composer-model-menu.tsx', () => ({ ComposerModelMenu: () => null }))
vi.mock('./image-thumbs.tsx', () => ({ ImageThumbs: () => null }))

const file = { id: '12345678-1234-4234-8234-123456789abc.txt', name: 'notes.txt', mime: 'text/plain', size: 3, url: '/api/sessions/s1/artifacts/12345678-1234-4234-8234-123456789abc.txt' }
let ctx: Context
let view: SessionViewService

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('chat.draft', JSON.stringify({ s1: 'keep this draft' }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    return Response.json(url === '/api/sessions' ? { sessions: [{ id: 's1', title: 'one', eventCount: 1, updatedAt: 1 }, { id: 's2', title: 'two', eventCount: 1, updatedAt: 1 }] } : {})
  }))
  ctx = new Context()
  view = new SessionViewService(ctx)
  view.ingest('s1', { type: 'session/open', version: 1, seq: 0, ts: 1 })
})

afterEach(async () => {
  cleanup()
  await ctx.fiber.dispose()
  resetSessionsListGet()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount() {
  const props = { sessionView: view, useSessionView: bindSessionView(view) } as unknown as SlotProps
  return render(<MemoryRouter initialEntries={['/s/s1']}><ChatComposer {...props} /></MemoryRouter>)
}

it('file selection waits for Send, retains text/files after failure, and retries without reuploading', async () => {
  const upload = vi.spyOn(view, 'uploadFile').mockResolvedValue(file)
  const send = vi.spyOn(view, 'send').mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(undefined)
  const ui = mount()
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: [new File(['abc'], 'notes.txt')] } })
  expect(upload).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('network failed'))
  expect(ui.getByRole('textbox').textContent).toContain('keep this draft')
  expect(ui.getByLabelText('待发送附件').textContent).toContain('notes.txt')
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(ui.queryByLabelText('待发送附件')).toBeNull())
  expect(upload).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[0]?.[3]).toEqual([])
  expect(send.mock.calls[0]?.[4]).toEqual([file])
  expect(send.mock.calls[0]?.[5]?.clientMessageId).toBe(send.mock.calls[1]?.[5]?.clientMessageId)
  expect(ui.getByRole('textbox').textContent).toBe('')
})

it('prevents document drops from navigating and reports count/size limits without uploading', () => {
  const upload = vi.spyOn(view, 'uploadFile')
  const ui = mount()
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['abc'], 'notes.txt')], types: ['Files'] } })
  fireEvent(ui.container.querySelector('form')!, drop)
  expect(drop.defaultPrevented).toBe(true)
  expect(ui.getByLabelText('待发送附件').textContent).toContain('notes.txt')
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: Array.from({ length: 6 }, (_, i) => new File(['abc'], `${i}.bin`)) } })
  expect(ui.getByRole('alert').textContent).toContain('6')
  const large = new File(['abc'], 'large.bin')
  Object.defineProperty(large, 'size', { value: 20 * 1024 * 1024 + 1 })
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: [large] } })
  expect(ui.getByRole('alert').textContent).toContain('20 MiB')
  expect(upload).not.toHaveBeenCalled()
})

it('does not send a finished upload to a newly selected session and restores the original draft', async () => {
  let resolve!: (value: typeof file) => void
  vi.spyOn(view, 'uploadFile').mockImplementation(() => new Promise((done) => { resolve = done }))
  const send = vi.spyOn(view, 'send')
  const ui = mount()
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: [new File(['abc'], 'notes.txt')] } })
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(ui.getByRole('status').textContent).toContain('上传中 1/1'))
  await act(async () => { await view.load('s2') })
  await act(async () => { resolve(file) })
  expect(send).not.toHaveBeenCalled()
  expect(ui.queryByLabelText('待发送附件')).toBeNull()
  await act(async () => { await view.load('s1') })
  await waitFor(() => expect(ui.getByLabelText('待发送附件').textContent).toContain('notes.txt'))
  expect(ui.getByRole('textbox').textContent).toContain('keep this draft')
  expect(ui.getByRole('alert').textContent).toContain('会话已切换')
})

it('claims attachment drafts for a newly created session and keeps them after upload failure', async () => {
  await ctx.fiber.dispose()
  ctx = new Context()
  view = new SessionViewService(ctx)
  vi.mocked(fetch).mockImplementation(async (_input, init) => Response.json(init?.method === 'POST' ? { id: 's1' } : {}))
  vi.spyOn(view, 'uploadFile').mockRejectedValueOnce(new Error('upload interrupted')).mockResolvedValueOnce(file)
  const send = vi.spyOn(view, 'send').mockResolvedValue(undefined)
  const ui = mount()
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: [new File(['abc'], 'notes.txt')] } })
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('upload interrupted'))
  expect(view.get().sessionId).toBe('s1')
  expect(ui.getByLabelText('待发送附件').textContent).toContain('notes.txt')
  expect(send).not.toHaveBeenCalled()
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(send.mock.calls[0]?.[5]?.sessionId).toBe('s1')
})

it.each([
  { attachmentType: 'files', files: [file] },
  { attachmentType: 'images', images: [{ name: 'picture.png', mime: 'image/png', url: 'data:image/png;base64,YWJj' }] },
])('disables editing queued $attachmentType without dropping the message but still allows deletion', ({ attachmentType: _, ...attachments }) => {
  view.setInbox([{ id: 'queued-1', kind: 'wake', text: 'queued attachment', ...attachments }])
  const drop = vi.spyOn(view, 'dropInboxItem').mockResolvedValue(true)
  const ui = mount()
  const edit = ui.getByLabelText('编辑排队消息') as HTMLButtonElement
  expect(edit.disabled).toBe(true)
  expect(edit.title).toBe('含附件消息暂不支持编辑')
  fireEvent.click(edit)
  expect(drop).not.toHaveBeenCalled()
  expect(ui.getByRole('textbox').textContent).toContain('keep this draft')
  const remove = ui.getByLabelText('删除排队消息') as HTMLButtonElement
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  expect(drop).toHaveBeenCalledWith('queued-1')
})

it('still edits queued plain text with empty attachment lists', async () => {
  view.setInbox([{ id: 'queued-text', kind: 'wake', text: 'edit queued text', images: [], files: [] }])
  const drop = vi.spyOn(view, 'dropInboxItem').mockResolvedValue(true)
  const ui = mount()
  const edit = ui.getByLabelText('编辑排队消息') as HTMLButtonElement
  expect(edit.disabled).toBe(false)
  fireEvent.click(edit)
  await waitFor(() => expect(ui.getByRole('textbox').textContent).toBe('edit queued text'))
  expect(drop).toHaveBeenCalledWith('queued-text')
})

it('disables queued text editing while attachments upload without replacing the current draft', async () => {
  view.setInbox([{ id: 'queued-text', kind: 'wake', text: 'queued text' }])
  let resolve!: (value: typeof file) => void
  vi.spyOn(view, 'uploadFile').mockImplementation(() => new Promise((done) => { resolve = done }))
  vi.spyOn(view, 'send').mockResolvedValue(undefined)
  const drop = vi.spyOn(view, 'dropInboxItem').mockResolvedValue(true)
  const ui = mount()
  fireEvent.change(ui.getByLabelText('选择附件'), { target: { files: [new File(['abc'], 'notes.txt')] } })
  fireEvent.submit(ui.container.querySelector('form')!)
  await waitFor(() => expect(ui.getByRole('status').textContent).toContain('上传中 1/1'))
  const edit = ui.getByLabelText('编辑排队消息') as HTMLButtonElement
  expect(edit.disabled).toBe(true)
  expect(edit.title).toBe('发送中暂不支持编辑')
  fireEvent.click(edit)
  expect(drop).not.toHaveBeenCalled()
  expect(ui.getByRole('textbox').textContent).toContain('keep this draft')
  await act(async () => { resolve(file) })
  await waitFor(() => expect(edit.disabled).toBe(false))
})

it('retains attachment metadata and client identity in the local inbox while sending', async () => {
  view.setAgentStatus('running')
  const image = { name: 'picture.png', mime: 'image/png', url: 'data:image/png;base64,YWJj' }
  let resolve!: (value: Response) => void
  vi.mocked(fetch).mockImplementation(() => new Promise((done) => { resolve = done }))
  const sending = view.send('queued attachments', 'wake', [], [image], [file], { clientMessageId: 'client-queued-1' })
  expect(view.get().inbox).toEqual([{
    id: expect.stringMatching(/^local-/),
    kind: 'wake',
    text: 'queued attachments',
    images: [image],
    files: [file],
    clientMessageId: 'client-queued-1',
  }])
  resolve(Response.json({}))
  await sending
})
