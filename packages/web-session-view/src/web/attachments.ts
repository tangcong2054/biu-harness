import { parseSessionArtifactUrl, type UserMessageFile } from '@biu/type-session'

export const MAX_MESSAGE_FILES = 6
export const MAX_MESSAGE_FILE_BYTES = 20 * 1024 * 1024

export function validateMessageFiles(files: ReadonlyArray<{ name: string; size: number }>, existing = 0) {
  if (existing + files.length > MAX_MESSAGE_FILES) throw new Error('每条消息最多添加 6 个附件（含图片）')
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_MESSAGE_FILE_BYTES) {
      throw new Error(`附件「${file.name}」超过单个 20 MiB 限制`)
    }
  }
}

export function attachmentUrl(file: Pick<UserMessageFile, 'id' | 'url'>, sessionId?: string | null) {
  if (!sessionId) return undefined
  const parsed = parseSessionArtifactUrl(file.url, sessionId)
  return parsed?.id === file.id ? file.url : undefined
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
