import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { UserMessageFile } from '@biu/type-session'
import { attachmentUrl, MAX_MESSAGE_FILE_BYTES, validateMessageFiles } from './attachments.ts'
import { SessionViewService, resetSessionsListGet, type SessionEvent } from './index.ts'

const id = '12345678-1234-4234-8234-123456789abc.txt'
const file: UserMessageFile = { id, name: 'notes.txt', mime: 'text/plain', size: 3, url: `/api/sessions/s1/artifacts/${id}` }
const image: UserMessageFile = { ...file, id: id.replace('.txt', '.png'), name: 'pic.png', mime: 'image/png', url: `/api/sessions/s1/artifacts/${id.replace('.txt', '.png')}` }
const contexts: Context[] = []

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  localStorage.removeItem('biu.account.token')
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
  vi.stubGlobal('fetch', fetchMock)
  const view = new SessionViewService(ctx)
  view.ingest('s1', { type: 'session/open', version: 1, seq: 0, ts: 1 })
  return { view, fetchMock }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  resetSessionsListGet()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('attachment transport', () => {
  it('uploads raw File, encodes its name, and uses server MIME', async () => {
    const { view, fetchMock } = setup()
    fetchMock.mockResolvedValueOnce(Response.json(file))
    const blob = new File(['abc'], 'notes #文.txt', { type: 'image/png' })
    await expect(view.uploadFile(blob, 's1')).resolves.toEqual(file)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/files/notes%20%23%E6%96%87.txt', expect.objectContaining({ method: 'PUT', body: blob }))
  })

  it('rejects limits before uploading and preserves meaningful server errors', async () => {
    const { view, fetchMock } = setup()
    const large = new File(['x'], 'large.bin')
    Object.defineProperty(large, 'size', { value: MAX_MESSAGE_FILE_BYTES + 1 })
    await expect(view.uploadFile(large)).rejects.toThrow('20 MiB')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(() => validateMessageFiles(Array.from({ length: 7 }, () => file))).toThrow('6')
    fetchMock.mockResolvedValueOnce(Response.json({ error: '会话附件配额已满' }, { status: 413 }))
    await expect(view.uploadFile(new File(['abc'], 'notes.txt'))).rejects.toThrow('会话附件配额已满')
  })

  it('accepts only canonical same-session artifact links', () => {
    expect(attachmentUrl(file, 's1')).toBe(file.url)
    for (const url of ['javascript:alert(1)', `https://evil.test${file.url}`, file.url.replace('/s1/', '/s2/'), `${file.url}?download=1`, '/api/sessions/s1/artifacts/../config']) {
      expect(attachmentUrl({ ...file, url }, 's1')).toBeUndefined()
    }
  })

  it('sends only attachment IDs and reconciles references by clientMessageId, not text', async () => {
    const { view, fetchMock } = setup()
    await view.send('same', 'wake', [], [], [file, image], { clientMessageId: 'first' })
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.files).toEqual([file.id, image.id])
    expect(request.images).toBeUndefined()
    expect(request.clientMessageId).toBe('first')
    expect(view.get().nodes.find((node) => node.kind === 'user')).toMatchObject({ images: [image], files: [file], clientMessageId: 'first' })
    view.setAgentStatus('idle')
    await view.send('same', 'wake', [], [], [file], { clientMessageId: 'second' })
    expect(view.get().events.filter((event) => event.type === 'user/message')).toHaveLength(2)
    const received: SessionEvent = { type: 'user/message', text: 'same', files: [file], images: [image], clientMessageId: 'first', seq: 1, ts: Date.now() }
    view.ingest('s1', received)
    view.ingest('s1', received)
    expect(view.get().events.filter((event) => event.type === 'user/message')).toHaveLength(2)
    expect(view.get().events.filter((event) => event.type === 'user/message' && event.seq < 0)).toMatchObject([{ clientMessageId: 'second' }])
  })

  it('removes only one legacy optimistic match and ignores duplicate delivery', () => {
    const { view } = setup()
    view.ingest('s1', { type: 'user/message', text: 'same', seq: -2, ts: 1 })
    view.ingest('s1', { type: 'user/message', text: 'same', seq: -1, ts: 1 })
    const event: SessionEvent = { type: 'user/message', text: 'same', seq: 2, ts: 2 }
    view.ingest('s1', event)
    view.ingest('s1', event)
    expect(view.get().events.filter((item) => item.type === 'user/message')).toHaveLength(2)
  })

  it('rejects the wrong target and rolls back only the failed outgoing bubble', async () => {
    const { view, fetchMock } = setup()
    await expect(view.send('hello', 'wake', [], [], [file], { sessionId: 's2' })).rejects.toThrow('会话已切换')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'blocked' }, { status: 400 }))
    await expect(view.send('hello', 'wake', [], [], [file])).rejects.toThrow('blocked')
    expect(view.get().nodes.filter((node) => node.kind === 'user')).toHaveLength(0)
  })

  it('does not activate a newly created session after the user has switched elsewhere', async () => {
    localStorage.removeItem('biu.account.token')
    const ctx = new Context()
    contexts.push(ctx)
    const view = new SessionViewService(ctx)
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>((done) => { resolve = done })
      return Response.json({ id: 's2', events: [] })
    }))
    const creating = view.ensureSession()
    await view.load('s2')
    resolve(Response.json({ id: 's3' }))
    await expect(creating).rejects.toThrow('会话已切换')
    expect(view.get().sessionId).toBe('s2')
  })
})
