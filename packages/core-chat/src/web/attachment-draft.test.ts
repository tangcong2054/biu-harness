import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserMessageFile } from '@biu/type-session'
import { addDraftFiles, removeDraftFile, uploadDraftFiles, type AttachmentDraft } from './attachment-draft.ts'

const stored = (name: string): UserMessageFile => ({ id: `${name}.txt`, name, mime: 'text/plain', size: 3, url: `/api/sessions/s1/artifacts/${name}.txt` })
const draft = (): AttachmentDraft => ({ files: [], sending: false })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('attachment drafts', () => {
  it('counts images and arbitrary files together and rejects oversized files atomically', () => {
    const state = draft()
    addDraftFiles(state, Array.from({ length: 6 }, (_, i) => new File(['abc'], `${i}.txt`)))
    expect(() => addDraftFiles(state, [new File(['x'], 'extra.png', { type: 'image/png' })])).toThrow('6')
    expect(state.files).toHaveLength(6)
    const tooLarge = new File(['x'], 'large.bin')
    Object.defineProperty(tooLarge, 'size', { value: 20 * 1024 * 1024 + 1 })
    expect(() => addDraftFiles(draft(), [tooLarge])).toThrow('20 MiB')
  })

  it('keeps every draft file on failure and reuses successful uploads on retry', async () => {
    const state = draft()
    addDraftFiles(state, [new File(['abc'], 'one.txt'), new File(['abc'], 'two.txt')])
    const uploadFile = vi.fn().mockResolvedValueOnce(stored('one')).mockRejectedValueOnce(new Error('quota'))
    const service = { get: () => ({ sessionId: 's1' }), uploadFile }
    await expect(uploadDraftFiles(state, 's1', service, vi.fn())).rejects.toThrow('quota')
    expect(state.files).toHaveLength(2)
    expect(state.files[0]?.uploaded?.name).toBe('one')
    expect(state.files[1]?.uploaded).toBeUndefined()
    uploadFile.mockResolvedValueOnce(stored('two'))
    await expect(uploadDraftFiles(state, 's1', service, vi.fn())).resolves.toHaveLength(2)
    expect(uploadFile).toHaveBeenCalledTimes(3)
  })

  it('uploads sequentially and stops without sending to a switched session', async () => {
    const state = draft()
    addDraftFiles(state, [new File(['abc'], 'one.txt'), new File(['abc'], 'two.txt')])
    let sessionId = 's1'
    let resolve!: (value: UserMessageFile) => void
    const uploadFile = vi.fn(() => new Promise<UserMessageFile>((done) => { resolve = done }))
    const task = uploadDraftFiles(state, 's1', { get: () => ({ sessionId }), uploadFile }, vi.fn())
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(state.progress).toBe('上传中 1/2')
    sessionId = 's2'
    resolve(stored('one'))
    await expect(task).rejects.toThrow('会话已切换')
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(state.files[0]?.sessionId).toBe('s1')
    expect(state.files).toHaveLength(2)
  })

  it('releases local image previews when removed', () => {
    const create = vi.fn(() => 'blob:preview')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const state = draft()
    addDraftFiles(state, [new File(['abc'], 'pic.png', { type: 'image/png' })])
    removeDraftFile(state, state.files[0]!.id)
    expect(revoke).toHaveBeenCalledWith('blob:preview')
    expect(state.files).toHaveLength(0)
  })
})
