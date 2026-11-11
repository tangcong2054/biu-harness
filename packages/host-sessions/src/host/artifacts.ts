import { copyFile, mkdir, writeFile, access, readdir, stat, lstat, open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, relative } from 'node:path'
import { constants } from 'node:fs'
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, dataDir, dataHome } from '@biu/host-plugin-loader/data-dir'

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

export type ArtifactMeta = {
  name: string
  mime: string
  url: string
  source?: string
}

export type PastedImage = {
  name: string
  mime: string
  url: string
  path?: string
}

const PATH_CANDIDATE =
  /(?:^|[\s"'=`(,\[{])((?:\/|\.\/|\.\.\/)?[^\s"'`)\]},;]+?\.(?:png|jpe?g|gif|webp|svg))\b/gi

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_MESSAGE_ATTACHMENTS = 6

export function validArtifactSession(sessionId: string) {
  return /^[\w-][\w.-]{0,127}$/.test(sessionId) && !sessionId.includes('..')
}

export function artifactsDir(sessionId: string, baseDir = dataHome()) {
  if (!validArtifactSession(sessionId)) throw new Error('invalid session id')
  return join(dataDir(baseDir), 'artifacts', sessionId)
}

export async function safeArtifactDirectory(sessionId: string, baseDir = dataHome(), create = false) {
  const dir = artifactsDir(sessionId, baseDir)
  const root = dirnameOfArtifact(dir)
  for (const path of [root, dir]) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid artifact directory')
  }
  if (await realpath(dir) !== join(await realpath(root), sessionId)) throw new Error('invalid artifact directory')
  return dir
}

function dirnameOfArtifact(dir: string) {
  return resolve(dir, '..')
}

export function artifactMime(name: string) {
  switch (extname(name).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

export function isImagePath(path: string) {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** 从 bash stdout/stderr/命令行里抠出看起来像图片路径的片段。 */
export function extractImagePathCandidates(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_CANDIDATE)) {
    const raw = match[1]?.trim()
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    found.push(raw)
  }
  return found
}

function safeArtifactName(sourcePath: string, used: Set<string>) {
  const base = basename(sourcePath).replace(/[^\w.\-]+/g, '_') || 'image.png'
  const ext = extname(base) || '.png'
  const stem = basename(base, ext) || 'image'
  let name = `${stem}${ext}`
  let i = 1
  while (used.has(name)) {
    name = `${stem}-${i}${ext}`
    i += 1
  }
  used.add(name)
  return name
}

async function fileExists(path: string) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** 扫工作区浅层目录，找出命令执行期间新写入/改动的图片（截图常不打印路径）。 */
export async function findRecentImageFiles(root: string, sinceMs: number, maxDepth = 2): Promise<string[]> {
  const base = resolve(root)
  const out: string[] = []

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || out.length >= 24) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === DATA_DIR_NAME || entry.name === LEGACY_DATA_DIR_NAME) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !isImagePath(entry.name)) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs >= sinceMs) out.push(full)
      } catch {
        /* ignore */
      }
    }
  }

  await walk(base, 0)
  return out
}

/** 将图片复制到 `.biu/artifacts/<sessionId>/`。工作区内相对路径 + 可读绝对路径均可。 */
export async function ingestSessionImages(options: {
  sessionId: string
  candidates: string[]
  workspaceRoot: string
  baseDir?: string
}): Promise<ArtifactMeta[]> {
  const { sessionId, candidates, workspaceRoot } = options
  const baseDir = options.baseDir ?? dataHome()
  if (!sessionId || candidates.length === 0) return []

  const root = resolve(workspaceRoot)
  const dir = artifactsDir(sessionId, baseDir)
  await mkdir(dir, { recursive: true })

  const used = new Set<string>()
  const seenSource = new Set<string>()
  const out: ArtifactMeta[] = []

  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    if (!isImagePath(full) || seenSource.has(full)) continue
    const rel = relative(root, full)
    const insideWorkspace = !rel.startsWith('..') && !isAbsolute(rel)
    // 相对路径必须在工作区内；绝对路径只要文件存在可读即可（bash 截图常落 /tmp）
    if (!isAbsolute(candidate) && !insideWorkspace) continue
    if (!(await fileExists(full))) continue
    seenSource.add(full)

    const name = safeArtifactName(full, used)
    const dest = join(dir, name)
    await copyFile(full, dest)
    out.push({
      name,
      mime: artifactMime(name),
      url: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(name)}`,
      source: insideWorkspace ? rel || basename(full) : full,
    })
  }

  return out
}

/** 解析并校验 artifact 文件路径；非法或穿越返回 null。 */
export function resolveArtifactFile(sessionId: string, name: string, baseDir = dataHome()) {
  if (!validArtifactSession(sessionId) || !name || name.length > 255) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  if (!/^[\w.\-]+$/.test(name)) return null
  const dir = artifactsDir(sessionId, baseDir)
  const full = join(dir, name)
  if (relative(dir, full).startsWith('..')) return null
  return full
}

const PASTE_DATA_URL = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i

function extForMime(mime: string) {
  const kind = mime.toLowerCase()
  if (kind === 'image/jpeg' || kind === 'image/jpg') return '.jpg'
  if (kind === 'image/gif') return '.gif'
  if (kind === 'image/webp') return '.webp'
  return '.png'
}

function decodePastedDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = PASTE_DATA_URL.exec(String(url ?? '').trim())
  if (!match) return null
  try {
    const mime = match[1]!.toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1]!.toLowerCase()
    const data = Buffer.from(match[2]!, 'base64')
    if (!data.length) return null
    return { mime, data }
  } catch {
    return null
  }
}

/** 把对话里粘贴的 data URL 写到 `.biu/artifacts/<sessionId>/`，返回带本机 path 的条目。 */
export async function persistPastedImages(
  sessionId: string,
  images: Array<{ name?: string; mime?: string; url?: string }>,
  baseDir = dataHome(),
): Promise<PastedImage[]> {
  if (!sessionId || !images.length) return []
  if (!/^[\w.-]+$/.test(sessionId) || sessionId.includes('..')) throw new Error('invalid session id')
  const dir = artifactsDir(sessionId, baseDir)
  await mkdir(dir, { recursive: true })
  const used = new Set<string>()
  try {
    for (const entry of await readdir(dir)) used.add(entry)
  } catch {
    /* empty dir */
  }
  const out: PastedImage[] = []
  for (const item of images.slice(0, 6)) {
    const decoded = decodePastedDataUrl(String(item.url ?? ''))
    if (!decoded) throw new Error('pasted image is not a data URL')
    const hint = String(item.name ?? '').trim() || `paste${extForMime(decoded.mime)}`
    const name = safeArtifactName(hint.endsWith(extForMime(decoded.mime)) ? hint : `${hint}${extForMime(decoded.mime)}`, used)
    const dest = join(dir, name)
    await writeFile(dest, decoded.data)
    out.push({
      name,
      mime: decoded.mime,
      url: String(item.url),
      path: dest,
    })
  }
  return out
}

export function pastedImagePickText(images: Array<{ name: string; path?: string }>) {
  return images
    .filter((item) => item.path)
    .map((item) => {
      const payload = {
        kind: 'file',
        id: `file:paste:${item.name}`,
        label: item.name,
        title: item.name,
        path: item.path,
      }
      return `<pick>${JSON.stringify(payload).replace(/</g, '\\u003c')}</pick>`
    })
    .join('\n')
}

export function withPastedImagePicks(text: string, images: Array<{ name: string; path?: string }>) {
  const picks = pastedImagePickText(images)
  if (!picks) return text
  const body = String(text ?? '').trim()
  return body ? `${body}\n${picks}` : picks
}


export async function openArtifactFile(sessionId: string, name: string, baseDir = dataHome()) {
  const full = resolveArtifactFile(sessionId, name, baseDir)
  if (!full) return null
  try {
    await safeArtifactDirectory(sessionId, baseDir)
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw new Error('invalid artifact file')
      return { handle, path: full, size: info.size, mime: artifactMime(name) }
    } catch (error) {
      await handle.close()
      throw error
    }
  } catch {
    return null
  }
}

export async function readArtifactFile(sessionId: string, name: string, baseDir = dataHome()) {
  const file = await openArtifactFile(sessionId, name, baseDir)
  if (!file) return null
  try {
    const buffer = Buffer.alloc(file.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== file.size) return null
    return { path: file.path, data: buffer.subarray(0, size), mime: file.mime }
  } finally {
    await file.handle.close()
  }
}
