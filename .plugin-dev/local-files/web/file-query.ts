import { IGNORED_NAMES, splitPath, type FsEntry, type FsRoot } from './fs.ts'
import { looksBinary } from './kinds.ts'

const encoder = new TextEncoder()
const MAX_OUTPUT = 1024 * 1024
const MAX_SCAN_FILE = 5 * 1024 * 1024

export function bounded(value: unknown, fallback: number, max: number, min = 1) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

function clip(text: string, max: number) {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return { text, bytes: bytes.length, truncated: false }
  return { text: new TextDecoder().decode(bytes.slice(0, max), { stream: true }), bytes: max, truncated: true }
}

export async function listTree(root: FsRoot, args: Record<string, unknown>) {
  const path = splitPath(String(args.path ?? '')).join('/')
  const maxEntries = bounded(args.maxEntries, 1000, 5000)
  const maxDepth = bounded(args.maxDepth, 8, 32)
  const entries: FsEntry[] = []
  const errors: Array<{ path: string; error: string }> = []
  let truncated = false
  const walk = async (dir: string, depth: number) => {
    try {
      for (const entry of await root.list(dir)) {
        if (IGNORED_NAMES.has(entry.name)) continue
        if (entries.length >= maxEntries) { truncated = true; return }
        entries.push(entry)
        if (entry.kind === 'directory') {
          if (depth < maxDepth) await walk(entry.path, depth + 1)
          else truncated = true
        }
      }
    } catch (error) {
      errors.push({ path: dir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await walk(path, 1)
  return { rootId: root.id, path, entries, errors, truncated }
}

export async function searchFiles(root: FsRoot, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim()
  if (!query) throw new Error('请输入文件名搜索词')
  const tree = await listTree(root, args)
  const needle = args.caseSensitive === true ? query : query.toLowerCase()
  const matches = tree.entries.filter((entry) => entry.kind === 'file' &&
    (args.caseSensitive === true ? entry.path : entry.path.toLowerCase()).includes(needle))
  const limit = bounded(args.limit, 100, 500)
  return { rootId: root.id, matches: matches.slice(0, limit), errors: tree.errors, truncated: tree.truncated || matches.length > limit }
}

export async function readRange(root: FsRoot, args: Record<string, unknown>) {
  const path = splitPath(String(args.path ?? '')).join('/')
  const file = await root.file(path)
  if (await looksBinary(file)) throw new Error('二进制文件不支持按行读取')
  const startLine = bounded(args.startLine, 1, 10000000)
  const endLine = bounded(args.endLine, startLine + 199, 10000000)
  if (endLine < startLine) throw new Error('endLine 不能小于 startLine')
  const maxBytes = bounded(args.maxBytes, 100 * 1024, MAX_OUTPUT)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let pending = '', line = 1, scanned = 0, bytes = 0, stop = false, truncated = false
  const lines: Array<{ line: number; text: string }> = []
  const emit = (text: string) => {
    if (line >= startLine && line <= endLine) {
      const piece = clip(text.replace(/\r$/, ''), Math.max(0, maxBytes - bytes))
      lines.push({ line, text: piece.text })
      bytes += piece.bytes + 1
      if (piece.truncated || bytes >= maxBytes) { truncated = true; stop = true }
    }
    line += 1
    if (line > endLine) stop = true
  }
  try {
    while (!stop) {
      const next = await reader.read()
      if (next.done) {
        pending += decoder.decode()
        if (pending || file.size === 0) emit(pending)
        pending = ''
        break
      }
      scanned += next.value.byteLength
      if (scanned > 32 * 1024 * 1024) { truncated = true; break }
      pending += decoder.decode(next.value, { stream: true })
      let index: number
      while (!stop && (index = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
      if (encoder.encode(pending).length > MAX_OUTPUT) {
        if (line >= startLine) emit(pending)
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return { rootId: root.id, path, size: file.size, startLine, endLine: lines.at(-1)?.line ?? null, lines, truncated }
}

export async function readFiles(root: FsRoot, args: Record<string, unknown>) {
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 20) throw new Error('paths 必须包含 1～20 个文件路径')
  const total = bounded(args.maxBytes, 200 * 1024, MAX_OUTPUT)
  let remaining = total
  const files: Array<Record<string, unknown>> = []
  for (const raw of args.paths) {
    const path = splitPath(String(raw)).join('/')
    if (remaining <= 0) { files.push({ path, skipped: '达到总返回量上限' }); continue }
    try {
      const file = await root.file(path)
      if (await looksBinary(file)) { files.push({ path, skipped: '二进制文件' }); continue }
      const piece = clip(await file.slice(0, remaining).text(), remaining)
      files.push({ path, text: piece.text, size: file.size, truncated: piece.truncated || file.size > remaining })
      remaining -= piece.bytes
    } catch (error) {
      files.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { rootId: root.id, files, bytes: total - remaining }
}

export async function searchContent(root: FsRoot, args: Record<string, unknown>) {
  const query = String(args.query ?? '')
  if (!query.trim() || query.length > 1024) throw new Error('搜索词需为 1～1024 个字符；仅支持字面量搜索')
  const tree = await listTree(root, args)
  const limit = bounded(args.limit, 100, 500)
  const context = bounded(args.context, 2, 5, 0)
  const needle = args.caseSensitive === true ? query : query.toLowerCase()
  const matches: Array<{ path: string; line: number; text: string; context: Array<{ line: number; text: string }> }> = []
  let scannedFiles = 0, scanBytes = 0, outputBytes = 0, truncated = tree.truncated
  const skipped: Array<{ path: string; reason: string }> = []
  for (const entry of tree.entries) {
    if (entry.kind !== 'file') continue
    if (matches.length >= limit || scanBytes >= 20 * 1024 * 1024 || outputBytes >= MAX_OUTPUT) { truncated = true; break }
    try {
      const file = await root.file(entry.path)
      if (file.size > MAX_SCAN_FILE || await looksBinary(file)) {
        skipped.push({ path: entry.path, reason: file.size > MAX_SCAN_FILE ? '超过 5MB' : '二进制文件' })
        continue
      }
      if (scanBytes + file.size > 20 * 1024 * 1024) { truncated = true; break }
      scanBytes += file.size
      scannedFiles += 1
      const lines = (await file.text()).split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const value = args.caseSensitive === true ? lines[i] : lines[i].toLowerCase()
        if (!value.includes(needle)) continue
        const around = lines.slice(Math.max(0, i - context), i + context + 1)
          .map((text, offset) => ({ line: Math.max(0, i - context) + offset + 1, text: clip(text, 2000).text }))
        const match = { path: entry.path, line: i + 1, text: clip(lines[i], 2000).text, context: around }
        const bytes = encoder.encode(JSON.stringify(match)).length
        if (matches.length >= limit || outputBytes + bytes > MAX_OUTPUT) { truncated = true; break }
        matches.push(match)
        outputBytes += bytes
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    } catch (error) {
      skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { rootId: root.id, matches, scannedFiles, scanBytes, skipped, errors: tree.errors, truncated }
}
