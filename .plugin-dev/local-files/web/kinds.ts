/** 文件类型判断：决定用编辑器还是预览打开。 */

export type ViewKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'video' | 'audio' | 'binary'

/** 编辑器最多打开这么大的文本；更大的只读查看开头。 */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024
export const PREVIEW_HEAD_BYTES = 1024 * 1024

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac'])
const MARKDOWN = new Set(['md', 'markdown', 'mdx'])
const HTML = new Set(['html', 'htm'])
const BINARY = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'wasm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'ai', 'sketch', 'fig',
  'sqlite', 'db', 'mdb', 'iso', 'dmg', 'apk', 'ipa',
])

export function extOf(name: string) {
  const base = name.toLowerCase()
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1)
}

export function kindByName(name: string): ViewKind | null {
  const ext = extOf(name)
  if (IMAGE.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (VIDEO.has(ext)) return 'video'
  if (AUDIO.has(ext)) return 'audio'
  if (MARKDOWN.has(ext)) return 'markdown'
  if (HTML.has(ext)) return 'html'
  if (BINARY.has(ext)) return 'binary'
  return null
}

/** 扩展名认不出来时，看开头 8KB 有没有 NUL。 */
export async function looksBinary(file: Blob) {
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
  for (const byte of head) if (byte === 0) return true
  return false
}

export async function detectKind(file: File): Promise<ViewKind> {
  const byName = kindByName(file.name)
  if (byName) return byName
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return (await looksBinary(file)) ? 'binary' : 'text'
}

/** 预览时强制 MIME，防止把 .png 当 HTML 解析之类的嗅探。 */
export function mimeFor(name: string, kind: ViewKind) {
  const ext = extOf(name)
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'image') return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`
  if (kind === 'video') return ext === 'mov' ? 'video/quicktime' : `video/${ext === 'ogv' ? 'ogg' : ext || 'mp4'}`
  if (kind === 'audio') return ext === 'mp3' ? 'audio/mpeg' : `audio/${ext === 'oga' ? 'ogg' : ext || 'mpeg'}`
  return 'application/octet-stream'
}

export function languageLabel(name: string) {
  const ext = extOf(name)
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React', mjs: 'JavaScript', cjs: 'JavaScript',
    json: 'JSON', md: 'Markdown', markdown: 'Markdown', mdx: 'MDX', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS',
    less: 'Less', py: 'Python', sql: 'SQL', yml: 'YAML', yaml: 'YAML', xml: 'XML', java: 'Java', c: 'C', h: 'C',
    cpp: 'C++', cc: 'C++', hpp: 'C++', go: 'Go', rs: 'Rust', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    toml: 'TOML', ini: 'INI', conf: 'Conf', env: 'Env', lua: 'Lua', rb: 'Ruby', dockerfile: 'Dockerfile', vue: 'Vue',
  }
  if (name.toLowerCase() === 'dockerfile') return 'Dockerfile'
  return map[ext] ?? (ext ? ext.toUpperCase() : '纯文本')
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
