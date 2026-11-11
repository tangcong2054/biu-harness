import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { dataHome } from '@biu/host-plugin-loader/data-dir'
import type { UserMessageFile } from '@biu/type-session'
import {
  artifactsDir, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS,
  openArtifactFile, readArtifactFile, safeArtifactDirectory,
} from './artifacts.ts'

export { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS }
export const MAX_SESSION_ATTACHMENT_BYTES = 200 * 1024 * 1024
export const MAX_SESSION_ATTACHMENT_FILES = 256
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\.[a-z0-9]{1,10})?$/
const locks = new Map<string, Promise<void>>()

export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function attachmentUrl(sessionId: string, id: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}`
}

export function attachmentImageMime(bytes: Uint8Array) {
  const data = Buffer.from(bytes)
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function displayName(raw: string) {
  const name = basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return Array.from(name || 'attachment').slice(0, 180).join('')
}

async function metadataDir(sessionId: string, baseDir: string, create = false) {
  const dir = join(await safeArtifactDirectory(sessionId, baseDir, create), '_meta')
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AttachmentError('附件目录不可用')
  return dir
}

async function withSessionLock<T>(key: string, run: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => gate)
  locks.set(key, queued)
  await previous
  try { return await run() } finally {
    release()
    if (locks.get(key) === queued) locks.delete(key)
  }
}

export async function uploadSessionFile(
  sessionId: string,
  originalName: string,
  source: Readable,
  options: { baseDir?: string; contentLength?: number } = {},
): Promise<UserMessageFile> {
  return storeSessionFile(sessionId, originalName, source, options)
}

async function storeSessionFile(
  sessionId: string,
  originalName: string,
  source: Readable,
  options: { baseDir?: string; contentLength?: number; clonedId?: string },
): Promise<UserMessageFile> {
  const baseDir = options.baseDir ?? dataHome()
  if (options.clonedId !== undefined && !ID_PATTERN.test(options.clonedId)) throw new AttachmentError('无效的附件引用')
  if (options.contentLength != null && (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0)) {
    throw new AttachmentError('无效的文件大小')
  }
  if ((options.contentLength ?? 0) > MAX_ATTACHMENT_BYTES) throw new AttachmentError('单个附件不能超过 20 MiB', 413)
  return withSessionLock(artifactsDir(sessionId, baseDir), async () => {
    const dir = await safeArtifactDirectory(sessionId, baseDir, true)
    const metaDir = await metadataDir(sessionId, baseDir, true)
    let used = 0
    let count = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '_meta') continue
      const info = await lstat(join(dir, entry.name))
      if (info.isFile()) { used += info.size; count++ }
    }
    if (count >= MAX_SESSION_ATTACHMENT_FILES) throw new AttachmentError('会话附件数量已达上限', 413)
    const temporary = join(dir, `${randomUUID()}.part`)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    let finalPath: string | undefined
    let finalMetadata: string | undefined
    let completed = false
    try {
      let size = 0
      let prefix = Buffer.alloc(0)
      // iterator 不销毁请求 socket，让路由在超限时仍能返回 413。
      for await (const raw of source.iterator({ destroyOnReturn: false })) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        size += chunk.length
        if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('单个附件不能超过 20 MiB', 413)
        if (used + size > MAX_SESSION_ATTACHMENT_BYTES) throw new AttachmentError('会话附件总大小不能超过 200 MiB', 413)
        if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)])
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) throw new AttachmentError('附件写入失败', 500)
          offset += bytesWritten
        }
      }
      if (options.contentLength != null && size !== options.contentLength) throw new AttachmentError('文件上传不完整')
      const mime = attachmentImageMime(prefix) ?? 'application/octet-stream'
      const imageExtension: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
      const name = displayName(originalName)
      const extension = imageExtension[mime] ?? (/^\.[a-z0-9]{1,10}$/i.test(extname(name)) ? extname(name).toLowerCase() : '')
      const id = options.clonedId ?? `${randomUUID()}${extension}`
      const file: UserMessageFile = { id, name, mime, size, url: attachmentUrl(sessionId, id) }
      await handle.close()
      const destination = join(dir, id)
      await link(temporary, destination)
      finalPath = destination
      await unlink(temporary)
      const metadata = join(metaDir, `${id}.json`)
      const metaHandle = await open(metadata, 'wx', 0o600)
      finalMetadata = metadata
      try { await metaHandle.writeFile(JSON.stringify(file)) } finally { await metaHandle.close() }
      completed = true
      return file
    } finally {
      await handle.close().catch(() => {})
      if (!completed) {
        await unlink(temporary).catch(() => {})
        if (finalPath) await unlink(finalPath).catch(() => {})
        if (finalMetadata) await unlink(finalMetadata).catch(() => {})
      }
    }
  })
}

export async function getSessionFile(sessionId: string, id: string, baseDir = dataHome()): Promise<UserMessageFile> {
  if (!ID_PATTERN.test(id)) throw new AttachmentError('无效的附件引用')
  try {
    const dir = await metadataDir(sessionId, baseDir)
    const handle = await open(join(dir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let value: UserMessageFile
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 4096) throw new Error('invalid metadata')
      const buffer = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 4096) throw new Error('invalid metadata')
      value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as UserMessageFile
    } finally { await handle.close() }
    if (value.id !== id || value.url !== attachmentUrl(sessionId, id) || typeof value.name !== 'string' || typeof value.mime !== 'string'
      || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_ATTACHMENT_BYTES) throw new Error('invalid metadata')
    const file = await openArtifactFile(sessionId, id, baseDir)
    if (!file) throw new Error('missing file')
    await file.handle.close()
    if (file.size !== value.size) throw new Error('changed file')
    return value
  } catch {
    throw new AttachmentError('附件不存在或不属于此会话', 404)
  }
}

export async function resolveSessionFiles(sessionId: string, ids: unknown, baseDir = dataHome()) {
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.length > MAX_MESSAGE_ATTACHMENTS || ids.some((id) => typeof id !== 'string')) {
    throw new AttachmentError('每条消息最多 6 个附件，附件引用必须是文件 ID')
  }
  return Promise.all([...new Set(ids as string[])].map((id) => getSessionFile(sessionId, id, baseDir)))
}

export async function discardSessionFiles(sessionId: string, ids: string[], baseDir = dataHome()) {
  if (!ids.length) return
  if (ids.some((id) => !ID_PATTERN.test(id))) throw new AttachmentError('无效的附件引用')
  await withSessionLock(artifactsDir(sessionId, baseDir), async () => {
    const dir = await safeArtifactDirectory(sessionId, baseDir)
    const meta = await metadataDir(sessionId, baseDir)
    for (const id of ids) {
      for (const path of [join(meta, `${id}.json`), join(dir, id)]) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
    }
  })
}

export function validateLegacyMessageImages(images: unknown) {
  if (images === undefined) return []
  if (!Array.isArray(images) || images.length > MAX_MESSAGE_ATTACHMENTS) throw new AttachmentError('每条消息最多 6 个附件')
  return images.map((image) => {
    if (!image || typeof image.url !== 'string') throw new AttachmentError('无效的图片')
    const match = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image.url)
    if (!match) throw new AttachmentError('旧版图片必须为 data URL')
    if (match[1]!.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new AttachmentError('单个附件不能超过 20 MiB', 413)
    const bytes = Buffer.from(match[1]!, 'base64')
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError('单个附件不能超过 20 MiB', 413)
    if (!attachmentImageMime(bytes)) throw new AttachmentError('图片内容无效')
    return { name: typeof image.name === 'string' ? image.name : 'image', bytes }
  })
}

export async function persistLegacyMessageImages(sessionId: string, images: unknown, baseDir = dataHome()) {
  const validated = validateLegacyMessageImages(images)
  const out: UserMessageFile[] = []
  try {
    for (const { name, bytes } of validated) {
      out.push(await uploadSessionFile(sessionId, name, Readable.from([bytes]), { baseDir, contentLength: bytes.length }))
    }
    return out
  } catch (error) {
    await discardSessionFiles(sessionId, out.map((file) => file.id), baseDir)
    throw error
  }
}

export async function readSessionFileText(sessionId: string, id: string, offset = 0, limit = 32 * 1024, baseDir = dataHome()): Promise<UserMessageFile & {
  binary: boolean; text?: string; message?: string; offset?: number; nextOffset?: number; truncated?: boolean
}> {
  const meta = await getSessionFile(sessionId, id, baseDir)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > meta.size || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024) {
    throw new AttachmentError('offset 为字节偏移，limit 须在 1 到 65536 之间')
  }
  const file = await openArtifactFile(sessionId, id, baseDir)
  if (!file) throw new AttachmentError('附件不可读取', 404)
  try {
    const buffer = Buffer.alloc(Math.min(limit, meta.size - offset))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.handle.read(buffer, length, buffer.length - length, offset + length)
      if (!bytesRead) break
      length += bytesRead
    }
    const data = buffer.subarray(0, length)
    const binary = /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|7z|rar|exe|bin)$/i.test(meta.name) || data.includes(0) || meta.mime.startsWith('image/')
    if (binary) return { ...meta, binary: true, message: '二进制附件已保存；请使用对应格式的解析器，不要当作文本读取。' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: offset + length < meta.size })
    } catch {
      return { ...meta, binary: true, message: '附件不是有效的 UTF-8 文本，请使用对应格式或编码的解析器。' }
    }
    const consumed = Buffer.byteLength(text, 'utf8')
    if (length && !consumed) throw new AttachmentError('limit 太小，无法读取完整 UTF-8 字符，请增大 limit')
    const nextOffset = offset + consumed
    return { ...meta, binary: false, text, offset, nextOffset, truncated: nextOffset < meta.size }
  } finally { await file.handle.close() }
}

type AttachmentEvent = { type?: string; images?: Array<{ url: string; name: string; id?: string }>; files?: UserMessageFile[] }

function sessionAttachmentIds(sourceId: string, events: unknown[]) {
  const ids = new Set<string>()
  const prefix = `/api/sessions/${encodeURIComponent(sourceId)}/artifacts/`
  for (const event of events as AttachmentEvent[]) {
    if (event.type !== 'user/message') continue
    for (const ref of [...(event.images ?? []), ...(event.files ?? [])]) {
      if (ref.url.startsWith('data:image/')) continue
      const id = ref.url.startsWith(prefix) ? ref.url.slice(prefix.length) : ''
      if (!ID_PATTERN.test(id) || (ref.id !== undefined && ref.id !== id)) throw new AttachmentError('分叉失败：附件引用无效')
      ids.add(id)
    }
  }
  return ids
}

export async function assertSessionAttachments(sourceId: string, events: unknown[], baseDir = dataHome()) {
  for (const id of sessionAttachmentIds(sourceId, events)) {
    try { await getSessionFile(sourceId, id, baseDir) } catch {
      throw new AttachmentError('分叉失败：本机缺少原会话附件，请在拥有完整附件的设备或云端分叉', 409)
    }
  }
}

export async function cloneSessionAttachments<T>(sourceId: string, targetId: string, events: T[], baseDir = dataHome()): Promise<T[]> {
  const ids = sessionAttachmentIds(sourceId, events)
  await assertSessionAttachments(sourceId, events, baseDir)
  const files = new Map<string, UserMessageFile>()
  try {
    for (const id of ids) {
      const meta = await getSessionFile(sourceId, id, baseDir)
      const file = await readArtifactFile(sourceId, id, baseDir)
      if (!file) throw new AttachmentError('分叉失败：原会话附件不可读取', 404)
      const cloned = await storeSessionFile(targetId, meta.name, Readable.from([file.data]), { baseDir, contentLength: file.data.length, clonedId: id })
      files.set(id, cloned)
    }
    return events.map((event) => {
      const copy = structuredClone(event) as T & AttachmentEvent
      if (copy.type === 'user/message') {
        for (const field of ['images', 'files'] as const) {
          const list = copy[field]
          if (!list) continue
          for (let index = 0; index < list.length; index++) {
            const ref = list[index]!
            if (ref.url.startsWith('data:image/')) continue
            const id = ref.url.slice(`/api/sessions/${encodeURIComponent(sourceId)}/artifacts/`.length)
            list[index] = { ...ref, ...files.get(id)! }
          }
        }
      }
      return copy
    })
  } catch (error) {
    await discardSessionFiles(targetId, [...files.keys()], baseDir)
    throw error
  }
}
