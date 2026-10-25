/**
 * 本地文件读写层。两种来源，界面只认 FsRoot：
 *   - handle：File System Access 句柄（Chrome / Edge）。可读写，句柄存进 IndexedDB，刷新后点一次「恢复访问」。
 *   - snapshot：选择 / 拖入那一刻的只读快照（Firefox / Safari，或页面快照）。改动只能下载为新文件。
 * 文件内容只在浏览器里读写，不经过服务器。
 */

export type EntryKind = 'file' | 'directory'
export type FsEntry = { name: string; path: string; kind: EntryKind }
export type RootMode = 'readwrite' | 'readonly'
export type PermissionState = 'granted' | 'prompt' | 'denied'

export interface FsRoot {
  id: string
  name: string
  /** 根本身是文件夹还是单个文件。单文件根的唯一路径就是文件名。 */
  kind: EntryKind
  mode: RootMode
  source: 'handle' | 'snapshot'
  list(path: string): Promise<FsEntry[]>
  file(path: string): Promise<File>
  write?(path: string, data: string | Blob): Promise<void>
  createFile?(dir: string, name: string): Promise<string>
  createDir?(dir: string, name: string): Promise<string>
  remove?(path: string): Promise<void>
  permission(write?: boolean): Promise<PermissionState>
  requestPermission(write?: boolean): Promise<boolean>
}

/** 默认不展开的大目录（可在界面里切换显示）。 */
export const IGNORED_NAMES = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store', '.venv', '.idea'])

/** 快照最多收这么多文件，防止把整个磁盘拖进来卡死页面。 */
export const SNAPSHOT_MAX_FILES = 20000

export function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name
}

export function parentPath(path: string) {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

export function baseName(path: string) {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** 一段文件名：不能为空、不能是 . / ..、不能带分隔符或控制字符。 */
export function validName(name: string) {
  const value = String(name ?? '')
  if (!value || value === '.' || value === '..') return false
  if (value.length > 255) return false
  return !/[/\\\u0000-\u001f]/.test(value)
}

/** 相对路径拆段并逐段校验，挡住 ../ 之类的越界写法。 */
export function splitPath(path: string): string[] {
  const raw = String(path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw) return []
  const parts = raw.split('/')
  for (const part of parts) {
    if (!validName(part)) throw new Error(`非法路径：${path}`)
  }
  return parts
}

export function sortEntries(entries: FsEntry[]) {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function randomId() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `lf_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function newRootId() {
  return randomId()
}

/* ---------------- 能力探测 ---------------- */

type AnyHandle = any

export function supportsHandles() {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as AnyHandle).showDirectoryPicker === 'function'
}

export function supportsFilePicker() {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as AnyHandle).showOpenFilePicker === 'function'
}

/* ---------------- 句柄根（可读写） ---------------- */

export class HandleRoot implements FsRoot {
  readonly source = 'handle' as const
  readonly mode: RootMode = 'readwrite'
  readonly kind: EntryKind
  readonly name: string

  constructor(readonly id: string, readonly handle: AnyHandle) {
    this.kind = handle.kind === 'directory' ? 'directory' : 'file'
    this.name = String(handle.name ?? '')
  }

  async permission(write = false): Promise<PermissionState> {
    if (typeof this.handle.queryPermission !== 'function') return 'granted'
    try {
      return (await this.handle.queryPermission({ mode: write ? 'readwrite' : 'read' })) as PermissionState
    } catch {
      return 'prompt'
    }
  }

  /** 必须在用户手势里调用（点击 / Ctrl+S），否则浏览器会拒绝弹授权。 */
  async requestPermission(write = false) {
    if (typeof this.handle.requestPermission !== 'function') return true
    try {
      return (await this.handle.requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted'
    } catch {
      return false
    }
  }

  private async dirAt(parts: string[], create = false): Promise<AnyHandle> {
    if (this.kind !== 'directory') {
      if (parts.length) throw new Error('单个文件不能包含子目录')
      return null
    }
    let dir = this.handle
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
    return dir
  }

  private async fileHandle(path: string, create = false): Promise<AnyHandle> {
    const parts = splitPath(path)
    if (!parts.length) throw new Error('缺少文件路径')
    if (this.kind === 'file') {
      if (parts.length !== 1 || parts[0] !== this.name) throw new Error(`文件不存在：${path}`)
      return this.handle
    }
    const dir = await this.dirAt(parts.slice(0, -1))
    return dir.getFileHandle(parts[parts.length - 1], { create })
  }

  async list(path: string): Promise<FsEntry[]> {
    if (this.kind === 'file') return path ? [] : [{ name: this.name, path: this.name, kind: 'file' }]
    const parts = splitPath(path)
    const dir = await this.dirAt(parts)
    const out: FsEntry[] = []
    for await (const child of dir.values()) {
      const name = String(child.name)
      out.push({ name, path: joinPath(parts.join('/'), name), kind: child.kind === 'directory' ? 'directory' : 'file' })
    }
    return sortEntries(out)
  }

  async file(path: string): Promise<File> {
    const handle = await this.fileHandle(path)
    return handle.getFile()
  }

  private async ensureWrite() {
    if ((await this.permission(true)) === 'granted') return
    if (!(await this.requestPermission(true))) {
      throw new Error('没有写入权限：请在界面上点一次「保存」或「授权写入」后再试')
    }
  }

  async write(path: string, data: string | Blob) {
    await this.ensureWrite()
    const handle = await this.fileHandle(path, true)
    const writable = await handle.createWritable()
    try {
      await writable.write(data)
    } finally {
      await writable.close()
    }
  }

  private async exists(dir: AnyHandle, name: string) {
    try {
      await dir.getFileHandle(name)
      return true
    } catch {
      /* not a file */
    }
    try {
      await dir.getDirectoryHandle(name)
      return true
    } catch {
      return false
    }
  }

  async createFile(dirPath: string, name: string) {
    if (!validName(name)) throw new Error(`非法文件名：${name}`)
    await this.ensureWrite()
    const dir = await this.dirAt(splitPath(dirPath))
    if (await this.exists(dir, name)) throw new Error(`已存在：${name}`)
    await dir.getFileHandle(name, { create: true })
    return joinPath(splitPath(dirPath).join('/'), name)
  }

  async createDir(dirPath: string, name: string) {
    if (!validName(name)) throw new Error(`非法文件夹名：${name}`)
    await this.ensureWrite()
    const dir = await this.dirAt(splitPath(dirPath))
    if (await this.exists(dir, name)) throw new Error(`已存在：${name}`)
    await dir.getDirectoryHandle(name, { create: true })
    return joinPath(splitPath(dirPath).join('/'), name)
  }

  async remove(path: string) {
    const parts = splitPath(path)
    if (!parts.length || this.kind !== 'directory') throw new Error('不能删除根')
    await this.ensureWrite()
    const dir = await this.dirAt(parts.slice(0, -1))
    await dir.removeEntry(parts[parts.length - 1], { recursive: true })
  }
}

/* ---------------- 快照根（只读） ---------------- */

export class SnapshotRoot implements FsRoot {
  readonly source = 'snapshot' as const
  readonly mode: RootMode = 'readonly'
  private readonly files = new Map<string, File | true>()
  private readonly tree = new Map<string, FsEntry[]>()
  truncated = false

  /**
   * entries 里 file=true 表示内容存在别处（IndexedDB），读取时交给 load 按需取，
   * 避免刷新恢复时一次性把整个文件夹的内容读进内存。
   */
  constructor(
    readonly id: string,
    readonly name: string,
    readonly kind: EntryKind,
    entries: Array<{ path: string; file?: File | true }>,
    private readonly load?: (path: string) => Promise<File>,
  ) {
    this.tree.set('', [])
    const seen = new Set<string>([''])
    for (const item of entries) {
      if (this.files.size >= SNAPSHOT_MAX_FILES) {
        this.truncated = true
        break
      }
      let parts: string[]
      try {
        parts = splitPath(item.path)
      } catch {
        continue
      }
      if (!parts.length) continue
      let dir = ''
      for (let i = 0; i < parts.length; i += 1) {
        const path = dir ? `${dir}/${parts[i]}` : parts[i]
        const isLeaf = i === parts.length - 1
        const kind: EntryKind = isLeaf && item.file ? 'file' : 'directory'
        if (!seen.has(path)) {
          seen.add(path)
          let siblings = this.tree.get(dir)
          if (!siblings) {
            siblings = []
            this.tree.set(dir, siblings)
          }
          siblings.push({ name: parts[i], path, kind })
        }
        if (kind === 'directory' && !this.tree.has(path)) this.tree.set(path, [])
        dir = path
      }
      if (item.file) this.files.set(parts.join('/'), item.file)
    }
    for (const list of this.tree.values()) sortEntries(list)
  }

  /** 只返回内存里真正持有内容的文件；按需加载的条目只带路径和 stored 标记。 */
  entries(): Array<{ path: string; file?: File; stored?: true }> {
    const entries: Array<{ path: string; file?: File; stored?: true }> = []
    for (const path of this.tree.keys()) if (path && !this.files.has(path)) entries.push({ path })
    for (const [path, file] of this.files) entries.push(file === true ? { path, stored: true } : { path, file })
    return entries
  }

  async permission(): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission() {
    return true
  }

  async list(path: string) {
    const key = splitPath(path).join('/')
    return [...(this.tree.get(key) ?? [])]
  }

  async file(path: string) {
    const key = splitPath(path).join('/')
    const hit = this.files.get(key)
    if (!hit) throw new Error(`文件不存在：${path}`)
    if (hit !== true) return hit
    if (!this.load) throw new Error(`文件副本不可用：${path}`)
    return this.load(key)
  }
}

/* ---------------- 选择 / 拖入 ---------------- */

/** 用户取消选择不算错。 */
export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** webkitdirectory / 多选文件得到的 FileList → 快照根。文件夹以第一段为根名。 */
export function snapshotFromFileList(files: File[], folder: boolean): SnapshotRoot[] {
  if (!files.length) return []
  if (!folder) {
    return files.map((file) => new SnapshotRoot(newRootId(), file.name, 'file', [{ path: file.name, file }]))
  }
  const first = String((files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || files[0].name)
  const rootName = first.split('/')[0] || '文件夹'
  const entries = files
    .map((file) => {
      const rel = String((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
      const parts = rel.split('/')
      const inner = parts[0] === rootName ? parts.slice(1) : parts
      return { path: inner.join('/'), file }
    })
    .filter((item) => item.path && !item.path.split('/').some((part) => IGNORED_NAMES.has(part)))
  return [new SnapshotRoot(newRootId(), rootName, 'directory', entries)]
}

/** 选择窗口关闭后、浏览器还在枚举文件期间广播的事件，界面据此显示「正在读取」。 */
export const READING_EVENT = 'lf:reading'
export type ReadingDetail = { busy: boolean; folder: boolean }

function announceReading(detail: ReadingDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ReadingDetail>(READING_EVENT, { detail }))
}

/** 不支持句柄时退回 <input type=file>，和「导入 Skill」同一种做法。 */
export function pickWithInput(folder: boolean): Promise<SnapshotRoot[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (folder) input.setAttribute('webkitdirectory', '')
    input.style.display = 'none'
    let settled = false
    let reading = false
    // Firefox 在关掉选择窗口后才枚举整个文件夹（含 node_modules），change 要等枚举完才触发。
    const onFocus = () => {
      if (settled || reading) return
      reading = true
      announceReading({ busy: true, folder })
      // 老浏览器取消时不发 cancel，别让提示一直挂着。
      setTimeout(() => {
        if (!settled && reading && !input.files?.length) {
          reading = false
          announceReading({ busy: false, folder })
        }
      }, 120_000)
    }
    const finish = (roots: SnapshotRoot[]) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      if (reading) announceReading({ busy: false, folder })
      resolve(roots)
    }
    input.addEventListener('change', () => {
      onFocus()
      // 让「正在读取」先画出来，再做同步的整理。
      setTimeout(() => finish(snapshotFromFileList(Array.from(input.files ?? []), folder)), 0)
    })
    input.addEventListener('cancel', () => finish([]))
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

type EntryLike = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, fail: (error: unknown) => void) => void }
}

async function readAllEntries(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader?.()
  if (!reader) return []
  const out: EntryLike[] = []
  // readEntries 每次最多给一批（Chrome 100 条），要读到空为止。
  for (;;) {
    const batch = await new Promise<EntryLike[]>((ok, fail) => reader.readEntries(ok, fail))
    if (!batch.length) return out
    out.push(...batch)
  }
}

/** Firefox 拖入文件夹：webkitGetAsEntry 递归成只读快照，跳过 node_modules 等大目录。 */
export async function snapshotFromEntry(entry: EntryLike): Promise<SnapshotRoot> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail))
    return new SnapshotRoot(newRootId(), entry.name, 'file', [{ path: entry.name, file }])
  }
  const items: Array<{ path: string; file?: File }> = []
  const walk = async (dir: EntryLike, prefix: string) => {
    for (const child of await readAllEntries(dir)) {
      if (items.length >= SNAPSHOT_MAX_FILES) return
      if (IGNORED_NAMES.has(child.name)) continue
      const path = joinPath(prefix, child.name)
      if (child.isDirectory) {
        items.push({ path })
        await walk(child, path)
      } else if (child.file) {
        try {
          const file = await new Promise<File>((ok, fail) => child.file!(ok, fail))
          items.push({ path, file })
        } catch {
          /* 读不到的文件跳过 */
        }
      }
    }
  }
  await walk(entry, '')
  return new SnapshotRoot(newRootId(), entry.name, 'directory', items)
}

export type DroppedSource =
  | { type: 'handle'; handle: AnyHandle }
  | { type: 'snapshot'; root: SnapshotRoot }

/**
 * 在 drop 事件同步阶段取走句柄 / 条目 / 文件，之后才 await。
 * Chrome 拿可写句柄；拿不到时退回 webkitGetAsEntry；再不行用 dataTransfer.files。
 */
export function captureDrop(dataTransfer: DataTransfer): Promise<DroppedSource[]> {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file')
  const canHandle = supportsHandles()
  const handles = items.map((item) => {
    const get = (item as AnyHandle).getAsFileSystemHandle
    if (!canHandle || typeof get !== 'function') return null
    try {
      return get.call(item) as Promise<AnyHandle>
    } catch {
      return null
    }
  })
  const entries = items.map((item) => {
    try {
      return ((item as AnyHandle).webkitGetAsEntry?.() ?? null) as EntryLike | null
    } catch {
      return null
    }
  })
  const files = Array.from(dataTransfer.files ?? [])
  return (async () => {
    const out: DroppedSource[] = []
    for (let i = 0; i < items.length; i += 1) {
      const pending = handles[i]
      if (pending) {
        try {
          const handle = await pending
          if (handle) {
            out.push({ type: 'handle', handle })
            continue
          }
        } catch {
          /* 退回快照 */
        }
      }
      const entry = entries[i]
      if (entry) {
        out.push({ type: 'snapshot', root: await snapshotFromEntry(entry) })
        continue
      }
      const file = files[i]
      if (file) out.push({ type: 'snapshot', root: new SnapshotRoot(newRootId(), file.name, 'file', [{ path: file.name, file }]) })
    }
    return out
  })()
}
