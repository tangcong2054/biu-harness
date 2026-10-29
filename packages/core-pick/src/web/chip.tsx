import {
  CircleStackIcon,
  StopCircleIcon,
  HashtagIcon,
  Square3Stack3DIcon,
  RectangleStackIcon,
  DocumentIcon,
  DocumentTextIcon,
  ClipboardDocumentCheckIcon,
  CheckCircleIcon,
  ChatBubbleLeftIcon,
  PuzzlePieceIcon,
  TagIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/16/solid'
import { useState, type ComponentType } from 'react'
import { ensureTagChipStyle, HeadlessPopover, TagChipCloseMark, tagTone } from '@biu/public-ui'
import type { PickRef } from './types.ts'
import { chipCaption, chipLabel, pickFullText } from './types.ts'

/** 注入侧可能写 tasks / sessions-db，芯片按规范 kind 取色和图标。 */
const PICK_KIND_ALIAS: Record<string, string> = {
  tasks: 'task',
  pages: 'page',
  plugins: 'plugin',
  sessions: 'session',
  'sessions-db': 'session',
  events: 'event',
  'events-db': 'event',
  views: 'view',
  'views-db': 'view',
  tags: 'tag',
  facets: 'facet',
  'facets-db': 'facet',
}

export function canonicalPickKind(kind: string) {
  const key = String(kind ?? '').trim()
  return PICK_KIND_ALIAS[key] ?? key.replace(/-db$/, '')
}

/** 采集点 kind 字符串映射到分面色板。 */
export function pickKindTone(kind: string) {
  return tagTone(canonicalPickKind(kind))
}

type Glyph = ComponentType<{ className?: string }>

const KIND_ICONS: Record<string, Glyph> = {
  session: ChatBubbleLeftIcon,
  text: DocumentTextIcon,
  task: CheckCircleIcon,
  page: DocumentIcon,
  collection: RectangleStackIcon,
  view: Square3Stack3DIcon,
  plugin: PuzzlePieceIcon,
  message: ChatBubbleLeftIcon,
  reply: ChatBubbleLeftIcon,
  tool: WrenchScrewdriverIcon,
  step: Square3Stack3DIcon,
  event: StopCircleIcon,
  turn: HashtagIcon,
  usage: CircleStackIcon,
  tag: TagIcon,
  facet: RectangleStackIcon,
  record: ClipboardDocumentCheckIcon,
  html: DocumentIcon,
  block: DocumentTextIcon,
}

export function pickKindIcon(kind: string): Glyph {
  return KIND_ICONS[canonicalPickKind(kind)] ?? TagIcon
}

export function PickKindGlyph({ kind }: { kind: string }) {
  const Icon = pickKindIcon(kind)
  return <Icon className="pick-kind-icon" aria-hidden data-testid="pick-kind-icon" data-pick-kind={kind} />
}

export function PickChipLabel({ pick }: { pick: PickRef }) {
  const { name, span } = chipCaption(pick)
  return (
    <>
      <PickKindGlyph kind={pick.kind} />
      <span className="pick-chip-name">{name}</span>
      {span ? <span className="pick-chip-lines">({span})</span> : null}
    </>
  )
}

const PREVIEW_STYLE_ID = 'biu-pick-text-preview'
const PREVIEW_CSS = `
.pick-chip-previewable{cursor:pointer}
.pick-text-preview{z-index:400;width:min(560px,calc(100vw - 24px));display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-sidebar,#fff);color:var(--dsw-sidebar-fg,#2c2c2b);border:1px solid var(--dsw-border,#e5e5e3);border-radius:10px;box-shadow:var(--dsw-shadow,0 8px 24px rgba(0,0,0,.12));font-size:13px}
.pick-text-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pick-text-preview-meta{opacity:.65}
.pick-text-preview-actions{display:inline-flex;gap:6px}
.pick-text-preview-btn{border:1px solid var(--dsw-border,#e5e5e3);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:2px 10px;cursor:pointer}
.pick-text-preview-btn:hover{background:var(--dsw-hover,rgba(0,0,0,.05))}
.pick-text-preview-body{margin:0;max-height:min(360px,50vh);overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;line-height:1.55;user-select:text;-webkit-user-select:text}
`

function ensurePickPreviewStyle() {
  if (typeof document === 'undefined') return
  let style = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = PREVIEW_STYLE_ID
    document.head.appendChild(style)
  }
  if (style.textContent !== PREVIEW_CSS) style.textContent = PREVIEW_CSS
}

/** 剪贴板 API 只在安全上下文可用；内网 http 访问时退回 execCommand。 */
export async function copyPlainText(text: string) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

function TextPickPreview({ text, onExpand, onClose }: { text: string; onExpand?: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('')
  return (
    <>
      <div className="pick-text-preview-head">
        <span className="pick-text-preview-meta">{text.length} 字</span>
        <span className="pick-text-preview-actions">
          <button
            type="button"
            className="pick-text-preview-btn"
            data-testid="pick-text-preview-copy"
            onClick={() => {
              void copyPlainText(text).then((ok) => {
                setCopied(ok ? 'ok' : 'fail')
                window.setTimeout(() => setCopied(''), 1600)
              })
            }}
          >
            {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制'}
          </button>
          {onExpand ? (
            <button
              type="button"
              className="pick-text-preview-btn"
              data-testid="pick-text-preview-expand"
              onClick={() => {
                onClose()
                onExpand()
              }}
            >
              展开为文本
            </button>
          ) : null}
        </span>
      </div>
      <pre className="pick-text-preview-body">{text}</pre>
    </>
  )
}

export function PickChip({
  pick,
  onRemove,
  onExpand,
}: {
  pick: PickRef
  onRemove?: () => void
  /** 把这枚文本芯片换回可编辑的原文。只在输入框里传。 */
  onExpand?: () => void
}) {
  ensureTagChipStyle()
  const label = chipLabel(pick)
  const full = pickFullText(pick)
  const [open, setOpen] = useState(false)
  const chip = (
    <span
      className={`biu-tag composer-tool-chip is-pick${full ? ' pick-chip-previewable' : ''}`}
      data-testid="user-pick-chip"
      data-pick-kind={pick.kind}
      title={full ? '点击查看原文' : `${pick.kind} · ${label}`}
      style={{ ['--biu-tag' as string]: pickKindTone(pick.kind) }}
      // 在编辑器里点芯片不能挪焦点/选区，否则浮层会被当成「焦点移出」立刻关掉。
      onMouseDown={full ? (event) => event.preventDefault() : undefined}
    >
      <PickChipLabel pick={pick} />
      {onRemove ? (
        <button
          type="button"
          className="biu-tag-x"
          aria-label={`移除 ${label}`}
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
        >
          <TagChipCloseMark />
        </button>
      ) : null}
    </span>
  )
  if (!full) return chip
  ensurePickPreviewStyle()
  return (
    <HeadlessPopover open={open} onOpenChange={setOpen} trigger={chip} side="top" align="start">
      <div className="pick-text-preview" role="dialog" aria-label="原文预览" data-testid="pick-text-preview">
        <TextPickPreview text={full} onExpand={onExpand} onClose={() => setOpen(false)} />
      </div>
    </HeadlessPopover>
  )
}
