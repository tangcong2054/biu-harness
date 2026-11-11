import { useCallback, useEffect, useRef, useState } from 'react'
import type { UserMessageFile } from '@biu/type-session'
import { validateMessageFiles } from '@biu/web-session-view'

export type PendingAttachment = {
  id: string
  file: File
  previewUrl?: string
  uploaded?: UserMessageFile
  sessionId?: string
}

export type AttachmentDraft = {
  files: PendingAttachment[]
  sending: boolean
  error?: string
  progress?: string
  retry?: { key: string; clientMessageId: string }
}

export function addDraftFiles(draft: AttachmentDraft, files: File[]) {
  validateMessageFiles(files, draft.files.length)
  draft.files.push(...files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {}),
  })))
}

export function removeDraftFile(draft: AttachmentDraft, id: string) {
  const item = draft.files.find((file) => file.id === id)
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  draft.files = draft.files.filter((file) => file.id !== id)
}

export async function uploadDraftFiles(
  draft: AttachmentDraft,
  sessionId: string,
  service: { get(): { sessionId: string | null }; uploadFile(file: File, sessionId: string): Promise<UserMessageFile> },
  notify: () => void,
) {
  validateMessageFiles(draft.files.map((item) => item.file))
  const result: UserMessageFile[] = []
  for (const [index, item] of draft.files.entries()) {
    if (service.get().sessionId !== sessionId) throw new Error('会话已切换，附件草稿已保留，请返回原会话重试')
    draft.progress = `上传中 ${index + 1}/${draft.files.length}`
    notify()
    if (!item.uploaded || item.sessionId !== sessionId) {
      item.uploaded = await service.uploadFile(item.file, sessionId)
      item.sessionId = sessionId
      notify()
    }
    result.push(item.uploaded)
  }
  if (service.get().sessionId !== sessionId) throw new Error('会话已切换，附件草稿已保留，请返回原会话重试')
  return result
}

export function useAttachmentDrafts() {
  const drafts = useRef(new Map<string | null, AttachmentDraft>())
  const [, update] = useState(0)
  const notify = useCallback(() => update((version) => version + 1), [])
  const getDraft = useCallback((sessionId: string | null) => {
    let draft = drafts.current.get(sessionId)
    if (!draft) {
      draft = { files: [], sending: false }
      drafts.current.set(sessionId, draft)
    }
    return draft
  }, [])
  const claimDraft = useCallback((draft: AttachmentDraft, sessionId: string) => {
    if (drafts.current.get(null) === draft) drafts.current.delete(null)
    drafts.current.set(sessionId, draft)
    notify()
  }, [notify])
  useEffect(() => () => {
    for (const draft of drafts.current.values()) {
      for (const item of draft.files) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
  }, [])
  return { getDraft, claimDraft, notify }
}
