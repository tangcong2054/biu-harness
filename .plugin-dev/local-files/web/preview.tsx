/**
 * 只读预览。安全要点：
 *   - Markdown / HTML 一律放进 sandbox iframe（不给 allow-same-origin、不给 allow-scripts），
 *     拿不到 Biu 的 cookie / DOM，脚本也不会跑。
 *   - 图片 / 音视频 / PDF 用 blob URL，且按扩展名强制 MIME，防止内容嗅探成 HTML。
 */
import { marked } from 'marked'
import { mimeFor, type ViewKind } from './kinds.ts'

const React = globalThis.React
const { useEffect, useMemo, useState } = React

const FRAME_CSP =
  "default-src 'none'; img-src https: data:; media-src https: data:; style-src 'unsafe-inline'; font-src https: data:"

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

const MD_STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 20px 28px 40px; font: 14px/1.7 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1f2430; }
  h1, h2, h3 { line-height: 1.3; margin: 1.4em 0 .6em; }
  h1 { font-size: 1.8em; border-bottom: 1px solid #eee; padding-bottom: .3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: .25em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: .1em .35em; border-radius: 4px; font-size: .92em; }
  pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0; padding: 0 1em; color: #6b7280; border-left: 3px solid #e5e7eb; }
  table { border-collapse: collapse; } th, td { border: 1px solid #e5e7eb; padding: 6px 10px; }
  img { max-width: 100%; } a { color: #2563eb; }
`

export function markdownDocument(source: string) {
  let body = ''
  try {
    body = String(marked.parse(source, { async: false, gfm: true }))
  } catch {
    body = `<pre>${escapeHtml(source)}</pre>`
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><base target="_blank"><style>${MD_STYLE}</style></head><body>${body}</body></html>`
}

function SandboxFrame({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      srcDoc={html}
      // 不给 allow-scripts / allow-same-origin：内容是不受信任的本地文件。
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ border: 0, width: '100%', height: '100%', background: '#fff', display: 'block' }}
    />
  )
}

export function MarkdownPreview({ text, title }: { text: string; title: string }) {
  const html = useMemo(() => markdownDocument(text), [text])
  return <SandboxFrame html={html} title={title} />
}

export function HtmlPreview({ text, title }: { text: string; title: string }) {
  return <SandboxFrame html={text} title={title} />
}

function useBlobUrl(file: Blob | null, name: string, kind: ViewKind) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!file) {
      setUrl('')
      return
    }
    const typed = new Blob([file], { type: mimeFor(name, kind) })
    const next = URL.createObjectURL(typed)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file, name, kind])
  return url
}

export function MediaPreview({ file, name, kind }: { file: Blob; name: string; kind: ViewKind }) {
  const url = useBlobUrl(file, name, kind)
  if (!url) return null
  const center = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', overflow: 'auto', background: '#fafafa' }
  if (kind === 'image') {
    return (
      <div style={{ ...center, backgroundImage: 'repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%)', backgroundSize: '16px 16px' }}>
        <img src={url} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div style={center}>
        <video src={url} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </div>
    )
  }
  if (kind === 'audio') {
    return (
      <div style={center}>
        <audio src={url} controls />
      </div>
    )
  }
  if (kind === 'pdf') {
    return <iframe title={name} src={url} style={{ border: 0, width: '100%', height: '100%', display: 'block' }} />
  }
  return null
}

export function downloadBlob(data: Blob | string, name: string) {
  const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain;charset=utf-8' }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
