/**
 * 只读预览。安全要点：
 *   - Markdown 经严格白名单清洗后渲染；HTML 原文仍放在不允许脚本或同源访问的 sandbox iframe。
 *   - 图片 / 音视频 / PDF 用 blob URL，且按扩展名强制 MIME，防止内容嗅探成 HTML。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { mimeFor, type ViewKind } from './kinds.ts'
import { bindPreviewHotkey, readPreviewSelectionCached, type FileSelection } from './selection.ts'

const React = globalThis.React
const { useEffect, useMemo, useRef, useState } = React

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

export function safeMarkdownHtml(text: string) {
  let html: string
  try {
    html = String(marked.parse(text, { async: false, gfm: true }))
  } catch {
    html = `<pre>${escapeHtml(text)}</pre>`
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img', 'span', 'div', 'details', 'summary', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'open'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  })
}

/**
 * 页面块外层被页面编辑器设成 draggable（整块可拖动），在里面按住拖动会变成「拖整个块」而不是选字。
 * 按下时临时关掉祖先的 draggable，松开后恢复，块的拖动手柄不受影响。
 */
export function releaseAncestorDrag(start: Element) {
  const doc = start.ownerDocument
  const changed: HTMLElement[] = []
  for (let el = start.parentElement; el; el = el.parentElement) {
    if (el.getAttribute('draggable') === 'true') {
      el.setAttribute('draggable', 'false')
      changed.push(el)
    }
  }
  if (!changed.length) return
  const win = doc.defaultView
  const restore = () => {
    for (const el of changed) if (el.getAttribute('draggable') === 'false') el.setAttribute('draggable', 'true')
    doc.removeEventListener('mouseup', restore, true)
    doc.removeEventListener('pointercancel', restore, true)
    win?.removeEventListener('blur', restore)
  }
  doc.addEventListener('mouseup', restore, true)
  doc.addEventListener('pointercancel', restore, true)
  win?.addEventListener('blur', restore)
}

function isPickMode(doc: Document) {
  return doc.documentElement.classList.contains('pick-mode')
}

export function MarkdownPreview({ text, title, onAttach }: { text: string; title: string; onAttach?: (selection: FileSelection | null) => void }) {
  const html = useMemo(() => safeMarkdownHtml(text), [text])
  const host = useRef<HTMLDivElement | null>(null)
  const latest = useRef(onAttach)
  latest.current = onAttach
  useEffect(() => {
    if (!host.current || !onAttach) return
    return bindPreviewHotkey(host.current, (selection) => latest.current?.(selection))
  }, [Boolean(onAttach)])
  return (
    <>
      <div
        ref={host}
        className="lf-markdown"
        tabIndex={0}
        aria-label={`${title} Markdown 预览`}
        dangerouslySetInnerHTML={{ __html: html }}
        onMouseDown={(event: MouseEvent) => {
          const el = event.currentTarget as HTMLElement
          if (event.button !== 0 || isPickMode(el.ownerDocument)) return
          releaseAncestorDrag(el)
          // 不让页面块把这次按下当成「选中整个块」，否则浏览器选区会被换成整块。
          event.stopPropagation()
        }}
        onDragStart={(event: DragEvent) => {
          // 拖动已选中的文字时也不要把整个块拖走。
          event.stopPropagation()
        }}
        onClick={(event: MouseEvent) => {
          const target = event.target
          if (!(target instanceof Element)) return
          const link = target.closest('a[href]')
          if (!link) return
          event.preventDefault()
          const href = link.getAttribute('href') ?? ''
          if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
        }}
      />
      {onAttach ? (
        <div className="lf-selection-tools">
          <button type="button" className="lf-btn" onMouseDown={(event: MouseEvent) => event.preventDefault()} onClick={() => onAttach(host.current ? readPreviewSelectionCached(host.current) : null)}>
            加入对话（Ctrl/⌘+L）
          </button>
        </div>
      ) : null}
    </>
  )
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
