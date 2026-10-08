import { createPortal } from 'react-dom'
import { bindHtmlSlide, collectHtmlSlides, cssBoxSize, htmlDeckEnabled, htmlDeckIndex, htmlDeckKeyAction, htmlLooksFillLayout, HTML_FILL_HOST_PX, stepHtmlDeck } from './html-deck.ts'
import { injectHtmlSelectionBridge, parseHtmlSelectionMessage, suspendAncestorDrag } from './selection-bridge.ts'
import { htmlBlockKey, stampHtmlPickSurfaces, stampHtmlSource } from './stamp-picks.ts'
import { injectDeckBridge, probeDeckPages, sendDeckCommand } from './deck-bridge.ts'

const React = globalThis.React
const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React

export const name = 'page-html-blocks'
export const inject = ['pageEditor', 'pick']

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}

/* ---------------- shared bits ---------------- */

const field = {
  width: '100%',
  boxSizing: 'border-box' as const,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

type SelectionBubbleState = {
  text: string
  top: number
  left: number
}

type HtmlPickService = {
  picking: boolean
  attach: (refs: Array<Record<string, unknown>>) => void
}

let htmlPick: HtmlPickService | undefined

function selectionId(text: string) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  return hash.toString(16)
}

function attachHtmlSelection(text: string) {
  const selection = text.trim().slice(0, 16_000)
  if (!selection || !htmlPick) return false
  htmlPick.attach([{
    kind: 'text',
    id: selectionId(selection),
    label: selection.length > 80 ? `${selection.slice(0, 80)}…` : selection,
    route: window.location.pathname,
    selection,
    plugin: name,
    title: 'HTML 文字选区',
  }])
  return true
}

function selectionNodeElement(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement ?? null
}

function selectionInside(host: HTMLElement | null) {
  const selection = window.getSelection()
  if (!host || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const anchor = selectionNodeElement(selection.anchorNode)
  const focus = selectionNodeElement(selection.focusNode)
  if (!anchor || !focus || !host.contains(anchor) || !host.contains(focus)) return null
  if (anchor.closest('[data-biu-ignore], textarea, input')) return null
  const text = selection.toString().trim().slice(0, 16_000)
  if (!text) return null
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  return {
    text,
    top: Math.max(8, rect.top - 40),
    left: Math.min(window.innerWidth - 44, Math.max(8, rect.left + rect.width / 2 - 16)),
  }
}

function SelectionBubble({ state, onAttach }: { state: SelectionBubbleState | null; onAttach: () => void }) {
  if (!state) return null
  return createPortal(
    <button
      type="button"
      data-testid="html-selection-bubble"
      data-biu-ignore
      title="加入对话（Ctrl/⌘+L）"
      aria-label="加入对话"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAttach}
      style={{
        position: 'fixed',
        zIndex: 2147483645,
        top: state.top,
        left: state.left,
        width: 32,
        height: 32,
        border: '1px solid var(--dsw-border)',
        borderRadius: 8,
        background: 'var(--dsw-float)',
        color: 'var(--dsw-label)',
        boxShadow: 'var(--dsw-shadow)',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: '30px',
        textAlign: 'center',
      }}
    >
      ↗
    </button>,
    document.body,
  )
}

function useDirectHtmlSelection(hostRef: { current: HTMLElement | null }) {
  const [state, setState] = useState<SelectionBubbleState | null>(null)
  const stateRef = useRef<SelectionBubbleState | null>(null)
  useEffect(() => {
    const sync = (clearWhenEmpty = false) => {
      const next = selectionInside(hostRef.current)
      if (!next && !clearWhenEmpty) return
      stateRef.current = next
      setState(next)
    }
    const onSelectionChange = () => sync(false)
    const onMouseUp = () => sync(true)
    const onViewport = () => sync(false)
    const onKey = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        (event.key !== 'l' && event.key !== 'L')
      ) return
      const selected = selectionInside(hostRef.current) ?? stateRef.current
      if (!selected) return
      event.preventDefault()
      if (attachHtmlSelection(selected.text)) {
        window.getSelection()?.removeAllRanges()
        stateRef.current = null
        setState(null)
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onViewport, true)
    window.addEventListener('resize', onViewport)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onViewport, true)
      window.removeEventListener('resize', onViewport)
    }
  }, [hostRef])
  const attach = () => {
    if (!state || !attachHtmlSelection(state.text)) return
    window.getSelection()?.removeAllRanges()
    stateRef.current = null
    setState(null)
  }
  return <SelectionBubble state={state} onAttach={attach} />
}

/** 源码编辑区。草稿在本地，避免每次回车写回 pageBlock 把光标甩到最后。 */
function SourceEditor({ html, onChange }: { html: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(html)
  const focused = useRef(false)
  const draftRef = useRef(draft)
  const htmlRef = useRef(html)
  const onChangeRef = useRef(onChange)
  draftRef.current = draft
  htmlRef.current = html
  onChangeRef.current = onChange
  useEffect(() => {
    if (!focused.current) setDraft(html)
  }, [html])
  useEffect(
    () => () => {
      if (draftRef.current !== htmlRef.current) onChangeRef.current(draftRef.current)
    },
    [],
  )
  const flush = () => {
    if (draftRef.current !== htmlRef.current) onChangeRef.current(draftRef.current)
  }
  return (
    <textarea
      data-testid="html-source"
      data-page-block-capture=""
      data-biu-ignore
      spellCheck={false}
      value={draft}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        flush()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={'<div style="...">…</div>'}
      style={{
        ...field,
        width: '100%',
        minHeight: 160,
        padding: '26px 10px 10px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.55,
        color: '#111',
        background: '#fff',
        border: '2px solid #111',
        borderRadius: 0,
        resize: 'vertical',
      }}
    />
  )
}

function ExpandGlyph({ shrink }: { shrink?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {shrink ? (
        <path
          fillRule="evenodd"
          d="M2.22 2.22a.75.75 0 0 1 1.06 0L5.5 4.44V2.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.69L2.22 3.28a.75.75 0 0 1 0-1.06Zm10.5 0a.75.75 0 1 1 1.06 1.06L11.56 5.5h1.69a.75.75 0 0 1 0 1.5h-3.5A.75.75 0 0 1 9 6.25v-3.5a.75.75 0 0 1 1.5 0v1.69l2.22-2.22ZM2.75 9h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-1.69l-2.22 2.22a.75.75 0 0 1-1.06-1.06l2.22-2.22H2.75a.75.75 0 0 1 0-1.5ZM9 9.75A.75.75 0 0 1 9.75 9h3.5a.75.75 0 0 1 0 1.5h-1.69l2.22 2.22a.75.75 0 1 1-1.06 1.06l-2.22-2.22v1.69a.75.75 0 0 1-1.5 0v-3.5Z"
        />
      ) : (
        <path
          fillRule="evenodd"
          d="M2.75 9a.75.75 0 0 1 .75.75v1.69l2.22-2.22a.75.75 0 0 1 1.06 1.06L4.56 12.5h1.69a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75v-3.5A.75.75 0 0 1 2.75 9ZM2.75 7a.75.75 0 0 0 .75-.75V4.56l2.22 2.22a.75.75 0 0 0 1.06-1.06L4.56 3.5h1.69a.75.75 0 0 0 0-1.5h-3.5a.75.75 0 0 0-.75.75v3.5c0 .414.336.75.75.75ZM13.25 9a.75.75 0 0 0-.75.75v1.69l-2.22-2.22a.75.75 0 1 0-1.06 1.06l2.22 2.22H9.75a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 .75-.75v-3.5a.75.75 0 0 0-.75-.75ZM13.25 7a.75.75 0 0 1-.75-.75V4.56l-2.22 2.22a.75.75 0 1 1-1.06-1.06l2.22-2.22H9.75a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75Z"
        />
      )}
    </svg>
  )
}

const inkFace = "'Helvetica Neue', Arial, sans-serif"
const MAG_INK = '#0a0a0a'
const MAG_PAPER = '#ece7dc'
const MAG_BLUE = '#1c7cff'

const barBtn: Record<string, unknown> = {
  cursor: 'pointer',
  border: 'none',
  borderRadius: 6,
  padding: '4px 8px',
  background: 'transparent',
  color: '#c9cdd6',
  fontWeight: 700,
  fontSize: 11,
  lineHeight: '16px',
  display: 'inline-flex',
  alignItems: 'center',
}

const pressBtn: Record<string, unknown> = {
  cursor: 'pointer',
  border: 'none',
  borderLeft: '2px solid #111',
  borderRadius: 0,
  padding: '8px 10px',
  background: '#fff',
  color: '#111',
  fontFamily: inkFace,
  fontWeight: 800,
  fontSize: 10,
  letterSpacing: '.15em',
  lineHeight: '16px',
  display: 'inline-flex',
  alignItems: 'center',
}

/** 一格放映内容。htmlframe 走 iframe（注了桥，可被父页驱动翻页）。 */
function DeckFrame({
  frameRef,
  html,
  kind,
  index,
  multi,
  onKey,
  onInfo,
}: {
  /* 由父组件持有，父组件要靠它向块内发指令 */
  frameRef: { current: HTMLIFrameElement | null }
  html: string
  kind: 'html' | 'htmlframe'
  index: number
  /* 是否多块连放：决定单页块要不要把按键交给放映器 */
  multi?: boolean
  onKey?: (cmd: string) => void
  onInfo?: (info: { total: number; page: number }) => void
}) {
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  const infoRef = useRef(onInfo)
  infoRef.current = onInfo
  const nonceRef = useRef(`html-selection-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
  const source = useMemo(
    () => injectHtmlSelectionBridge(injectDeckBridge(html), nonceRef.current),
    [html],
  )
  const selection = useFrameHtmlSelection(frameRef, nonceRef.current)

  useEffect(() => {
    if (kind !== 'htmlframe') return
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as
        | { __phpDeckKey?: string; __phpDeckInfo?: number; total?: number; page?: number }
        | null
      if (!data) return
      if (data.__phpDeckKey) keyRef.current?.(data.__phpDeckKey)
      if (data.__phpDeckInfo && typeof data.total === 'number') {
        infoRef.current?.({ total: data.total, page: Number(data.page) || 0 })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [kind, source])

  const stamped = kind === 'html' ? stampHtmlSource(injectDeckBridge(html), `deck-${index}`, name) : ''
  const fill = {
    position: 'absolute' as const,
    inset: 0,
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    minWidth: 0,
    minHeight: 0,
    border: 'none',
    boxSizing: 'border-box' as const,
  }

  if (kind === 'htmlframe') {
    return (
      <>
        <iframe
          ref={frameRef}
          title={`html-deck-${index}`}
          srcDoc={source}
          sandbox="allow-scripts"
          onLoad={() => {
            selection.clear()
            /* 告诉桥：本次放映是否多块连放 */
            try {
              frameRef.current?.contentWindow?.postMessage({ __phpDeckCmd: 'cfg', multi: !!multi }, '*')
            } catch {
              /* 忽略 */
            }
            sendDeckCommand(frameRef.current, 'info')
          }}
          style={{ ...fill, background: MAG_INK, pointerEvents: 'auto' }}
        />
        {selection.bubble}
      </>
    )
  }
  return (
    <div
      data-testid="html-deck-slide"
      style={{ ...fill, overflow: 'auto', background: 'transparent' }}
      dangerouslySetInnerHTML={{ __html: stamped }}
    />
  )
}

/** 放映一格 = 块的某一页。block 型每块一页；stream 型用块内那一叠当页。 */
type DeckItem = { slide: ReturnType<typeof collectHtmlSlides>[number]; kindMode: 'htmlframe' | 'html'; page: number; total: number }
function HtmlDeckOverlay({
  slides,
  index,
  onIndex,
  onClose,
}: {
  slides: ReturnType<typeof collectHtmlSlides>
  index: number
  onIndex: (next: number) => void
  onClose: () => void
}) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const boxRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [navHot, setNavHot] = useState(false)

  const [item, setItem] = useState<DeckItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [pos, setPos] = useState(0)
  /* 当前页的同步镜像：键盘闭包 / 周期上报都读它，避免读到过期的 state */
  const posRef = useRef(0)
  posRef.current = pos
  /* 刚下发、还没被块内确认的页码。防止桥的旧上报把页码拉回去 */
  const pendingRef = useRef<number | null>(null)

  const slide = slides[index]
  const total = slides.length
  const pages = Math.max(1, item?.total ?? 1)
  const page = Math.min(pos, pages - 1)

  /* 进入一格：先按单页渲染，块内的桥会立刻上报真实页数。
     这里刻意不做离屏探测——那会把块内容（计时器/请求/埋点）额外跑一遍。 */
  useEffect(() => {
    if (!slide) return
    posRef.current = 0
    pendingRef.current = null
    setPos(0)
    setItem({ slide, kindMode: slide.kind, page: 0, total: 1 })
    setLoading(false)
  }, [slide])

  const goPage = (next: number) => {
    const target = Math.min(Math.max(0, next), pages - 1)
    posRef.current = target
    pendingRef.current = target
    setPos(target)
    sendDeckCommand(frameRef.current, 'goto', target)
  }

  /* 换块后把新块复位到第一页 */
  const switchTo = (next: number) => {
    posRef.current = 0
    pendingRef.current = null
    setPos(0)
    window.setTimeout(() => sendDeckCommand(frameRef.current, 'first'), 0)
    onIndex(next)
  }

  /* 翻页 = 先翻块内的叠放页，翻到头才换块；往回同理 */
  /* 翻块：只有真存在相邻块才切；已在首/末块就停住，不要回绕到本块第一页。 */
  const goBlock = (delta: number) => {
    const next = stepHtmlDeck(index, delta, total)
    if (next === index) return
    switchTo(next)
  }

  const step = (delta: number) => {
    const cur = posRef.current
    const target = cur + delta
    if (target >= 0 && target < pages) {
      goPage(target)
      return
    }
    goBlock(delta)
  }

  const jump = (where: 'first' | 'last') => {
    if (where === 'first') {
      switchTo(0)
      return
    }
    posRef.current = pages - 1
    pendingRef.current = pages - 1
    setPos(pages - 1)
    sendDeckCommand(frameRef.current, 'last')
    onIndex(Math.max(0, total - 1))
  }

  /*
   * 块内自己按了方向键。注意：桥会 preventDefault 掉块内的默认处理，
   * 所以这里必须显式把翻页指令发回块内，否则块内不会动、上报的页码会把 pos 拉回原地。
   * 翻到边界才交给父页换块。
   */
  const onFrameKey = (cmd: string) => {
    if (cmd === 'close') {
      closeRef.current()
      return
    }
    const cur = posRef.current
    if (cmd === 'next') {
      if (cur < pages - 1) goPage(cur + 1)
      else goBlock(1)
      return
    }
    if (cmd === 'prev') {
      if (cur > 0) goPage(cur - 1)
      else goBlock(-1)
      return
    }
    if (cmd === 'first') jump('first')
    else if (cmd === 'last') jump('last')
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = htmlDeckKeyAction(event.key)
      if (action == null) return
      if (action === 'close') {
        closeRef.current()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (action === 'first') jump(('first'))
      else if (action === 'last') jump('last')
      else step(action)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    const root = document.documentElement
    let gone = false
    void Promise.resolve(root.requestFullscreen?.({ navigationUI: 'hide' })).catch(() => {})
    const onFs = () => {
      if (gone) return
      if (document.fullscreenElement) return
      closeRef.current()
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      gone = true
      document.removeEventListener('fullscreenchange', onFs)
      if (document.fullscreenElement) void document.exitFullscreen?.()
    }
  }, [])

  if (!slide) return null
  const counter = pages > 1 ? `第 ${index + 1} / ${total} 块 · ${page + 1} / ${pages} 页` : `${index + 1} / ${total}`
  const atStart = index <= 0 && page <= 0
  const atEnd = index >= total - 1 && page >= pages - 1

  return createPortal(
    <div
      ref={boxRef}
      data-testid="html-deck"
      data-biu-ignore
      tabIndex={0}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        zIndex: 2147483646,
        display: 'flex',
        flexDirection: 'column',
        background: '#0b0b12',
        color: '#e6edf3',
        font: '13px/1.4 ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <style>{`[data-testid="html-deck"]:fullscreen,[data-testid="html-deck"]:-webkit-full-screen{inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important}[data-testid="html-deck-slide"]>*{width:100%!important;height:100%!important;max-width:none!important;box-sizing:border-box}`}</style>
      <div
        data-testid="html-deck-stage"
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        {loading || !item ? (
          <div style={{ ...fillBox(), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b93a7' }}>
            载入中…
          </div>
        ) : (
          <DeckFrame
            key={`${index}-${item.total}`}
            frameRef={frameRef}
            html={slide.html}
            kind={slide.kind}
            index={index}
            onKey={onFrameKey}
            multi={total > 1}
            onInfo={(info) => {
              const t = Math.max(1, info.total)
              setItem((cur) => (cur && cur.total !== t ? { ...cur, total: t } : cur))
              const p = Math.min(Math.max(0, info.page), t - 1)
              if (pendingRef.current != null) {
                /* 还在等刚才那条指令落位：等到了就清掉，否则是过期上报，忽略 */
                if (p === pendingRef.current) pendingRef.current = null
                return
              }
              posRef.current = p
              setPos(p)
            }}
          />
        )}
      </div>
      <div
        data-testid="html-deck-nav"
        onMouseEnter={() => setNavHot(true)}
        onMouseLeave={() => setNavHot(false)}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          height: 96,
          padding: '0 16px 18px',
          background: navHot ? 'linear-gradient(transparent, rgba(0,0,0,.55))' : 'transparent',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            opacity: navHot ? 1 : 0,
            transition: 'opacity 160ms ease',
            pointerEvents: navHot ? 'auto' : 'none',
          }}
        >
          <button type="button" style={{ ...barBtn, ...(atStart ? { opacity: 0.35, cursor: 'default' } : {}) }} disabled={atStart} onClick={() => step(-1)} aria-label="上一张">
            上一张
          </button>
          <span data-testid="html-deck-index" style={{ color: '#8b93a7', minWidth: 64, textAlign: 'center' }}>
            {counter}
          </span>
          <button
            type="button"
            style={{ ...barBtn, ...(atEnd ? { opacity: 0.35, cursor: 'default' } : {}) }}
            disabled={atEnd}
            onClick={() => step(1)}
            aria-label="下一张"
          >
            下一张
          </button>
          <button type="button" data-page-block-expand="" style={{ ...barBtn, marginLeft: 12 }} onClick={onClose} title="退出放映" aria-label="退出放映">
            <ExpandGlyph shrink />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function fillBox() {
  return {
    position: 'absolute' as const,
    inset: 0,
    width: '100%',
    height: '100%',
    boxSizing: 'border-box' as const,
  }
}

function useHtmlDeck(
  hostRef: { current: HTMLElement | null },
  kind: 'html' | 'htmlframe',
  html: string,
  opts?: { width?: unknown; height?: unknown; deck?: boolean },
) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [slides, setSlides] = useState<ReturnType<typeof collectHtmlSlides>>([])
  const width = opts?.width
  const height = opts?.height
  const deck = htmlDeckEnabled(opts?.deck)

  useLayoutEffect(() => {
    const host = hostRef.current?.closest('[data-page-block]') ?? null
    bindHtmlSlide(host, {
      kind,
      html,
      deck,
      ...(width != null && width !== '' ? { width: width as number | string } : {}),
      ...(height != null && height !== '' ? { height: height as number | string } : {}),
    })
    return () => bindHtmlSlide(host, null)
  }, [hostRef, html, kind, width, height, deck])

  /* 放映范围：默认只放当前块。想看同页其它块一起连放，按住 Alt 再点放大。 */
  const start = (all = false) => {
    const host = hostRef.current?.closest('[data-page-block]') ?? null
    const list = all ? collectHtmlSlides(host) : collectHtmlSlides(host).filter((item) => item.host === host)
    const scope = list.length ? list : collectHtmlSlides(host)
    if (!scope.length) return
    setSlides(scope)
    setIndex(Math.max(0, htmlDeckIndex(scope, host)))
    setOpen(true)
  }

  const overlay = open ? (
    <HtmlDeckOverlay
      slides={slides.length ? slides : collectHtmlSlides(hostRef.current?.closest('[data-page-block]') ?? null)}
      index={index}
      /*
       * 注意：这里不要重新 collect。曾因 host 解析为空而回退成「整页所有块」，
       * 导致翻到边界时块集突然从 1 个变成 2 个、跳到别的块。
       * 放映范围在 start() 时就定下来了，之后只改下标。
       */
      onIndex={setIndex}
      onClose={() => setOpen(false)}
    />
  ) : null

  return { start, overlay }
}

function SizeGrip({
  boxRef,
  onSize,
  reveal,
}: {
  boxRef: { current: HTMLElement | null }
  onSize: (next: { width: number; height: number }) => void
  reveal: boolean
}) {
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const show = reveal || dragging
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = drag.current
      if (!start) return
      event.preventDefault()
      onSizeRef.current({
        width: Math.max(80, Math.round(start.w + event.clientX - start.x)),
        height: Math.max(48, Math.round(start.h + event.clientY - start.y)),
      })
    }
    const up = () => {
      drag.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])
  if (!show) return null
  return (
    <button
      type="button"
      data-testid="html-size-grip"
      data-biu-ignore
      tabIndex={-1}
      title="拖动调整宽高"
      aria-label="拖动调整宽高"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const box = boxRef.current
        if (!box) return
        setDragging(true)
        drag.current = { x: event.clientX, y: event.clientY, w: box.offsetWidth, h: box.offsetHeight }
      }}
      style={{
        appearance: 'none',
        position: 'absolute',
        right: 3,
        bottom: 3,
        zIndex: 18,
        width: 16,
        height: 16,
        margin: 0,
        padding: 0,
        cursor: 'nwse-resize',
        border: 'none',
        borderRadius: 0,
        background: 'linear-gradient(135deg, transparent 46%, #111 46%)',
      }}
    />
  )
}
function FloatBar({
  editing,
  setEditing,
  ro,
  onExpand,
  deck,
  onDeck,
  sized,
  onResetSize,
  children,
}: {
  editing: boolean
  setEditing: (v: boolean) => void
  ro: boolean
  onExpand: (all?: boolean) => void
  deck: boolean
  onDeck?: (next: boolean) => void
  sized?: boolean
  onResetSize?: () => void
  children?: unknown
}) {
  const seg = (active: boolean, onClick: () => void, label: string, on: string, onInk: string) => (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      style={{
        ...pressBtn,
        background: active ? on : '#fff',
        color: active ? onInk : '#111',
      }}
    >
      {label}
    </button>
  )
  return (
    <div
      data-testid="html-floatbar"
      data-biu-ignore
      style={{
        position: 'absolute',
        top: 2,
        right: 2,
        zIndex: 20,
        display: 'flex',
        gap: 0,
        alignItems: 'stretch',
        padding: 0,
        borderRadius: 0,
        background: '#fff',
        border: 'none',
        borderBottom: '2px solid #111',
        boxShadow: 'none',
        fontFamily: inkFace,
        fontSize: 10,
        lineHeight: 1.2,
      }}
    >
      {children}
      {ro ? null : (
        <>
          {seg(!editing, () => setEditing(false), '预览', '#1c7cff', '#fff')}
          {seg(editing, () => setEditing(true), '编辑', '#ffd400', '#111')}
          {sized ? (
            <button
              type="button"
              tabIndex={-1}
              data-testid="html-size-auto"
              title="恢复自适应宽高"
              aria-label="恢复自适应宽高"
              onClick={() => onResetSize?.()}
              style={{ ...pressBtn, background: '#ffd400' }}
            >
              自适应
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            data-testid="html-deck-toggle"
            title={deck ? '已加入演示，点击移出' : '未加入演示，点击加入'}
            aria-label={deck ? '移出演示' : '加入演示'}
            aria-pressed={deck}
            onClick={() => onDeck?.(!deck)}
            style={{
              ...pressBtn,
              background: deck ? '#ff2a6d' : '#fff',
              color: deck ? '#fff' : '#111',
            }}
          >
            演示
          </button>
        </>
      )}
      <button
        type="button"
        tabIndex={-1}
        data-page-block-expand=""
        data-testid="html-deck-expand"
        title="放大放映"
        aria-label="放大放映"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => onExpand(event.altKey)}
        style={{ ...pressBtn }}
      >
        <ExpandGlyph />
      </button>
    </div>
  )
}

/* ============================================================
   1) kind=html：直接渲染（无 iframe，无脚本）——内容裸渲染，无外框
   ============================================================ */

const HTML_EDITORIAL_SAMPLE = `<div style="box-sizing:border-box;min-height:100%;height:100%;width:100%;font-family:'Helvetica Neue','Arial',sans-serif;background:${MAG_INK};border:2px solid ${MAG_PAPER};color:${MAG_PAPER};margin:0;display:flex;flex-direction:column">
  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid ${MAG_PAPER};padding:8px 12px;padding-right:220px;font-size:11px;letter-spacing:.15em">
    <span style="font-weight:700">现代 ・ 美式</span><span style="font-weight:800">创立 2024</span>
  </div>
  <div style="background:${MAG_BLUE};color:#fff;font-size:34px;font-weight:900;line-height:1.05;padding:16px;letter-spacing:-.02em">丰富<br>排版，<br>不跑脚本。</div>
  <div style="display:flex;gap:0;flex:1">
    <div style="flex:1.4;padding:12px;font-size:13px;line-height:1.7;font-weight:500">夜间美式杂志网格。静态富排版，不执行脚本。纯 HTML / CSS，用来做卡片、表格、配色和干净的刊头。</div>
    <div style="flex:1;border-left:2px solid ${MAG_PAPER};display:flex;flex-direction:column;gap:6px;padding:12px;font-size:10px;font-weight:800">
      <span style="background:#ffd400;color:#0a0a0a;padding:2px 6px">静态</span>
      <span style="background:#ff2a6d;color:#fff;padding:2px 6px">无脚本</span>
      <span style="border:1.5px solid ${MAG_PAPER};padding:2px 6px">直出</span>
    </div>
  </div>
</div>`

const HTML_DIRECT_SAMPLE = HTML_EDITORIAL_SAMPLE

const HTML_FILL_CSS = `.html-direct-fill-inner{height:100%;min-height:100%}.html-direct-fill-inner>:first-child{height:100%!important;min-height:100%;box-sizing:border-box}`

function HtmlDirectCard({ data, update, writable }: BlockProps) {
  const ro = !writable
  const html = String(data.html ?? '')
  const width = data.width
  const height = data.height
  const fill = htmlLooksFillLayout(html)
  const fillHost = fill && (height == null || height === '')
  const sized = (width != null && width !== '') || (height != null && height !== '') || fillHost
  const deckOn = htmlDeckEnabled(data.deck)
  const [editing, setEditing] = useState(false)
  const [hover, setHover] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const deck = useHtmlDeck(hostRef, 'html', html, { width, height, deck: deckOn })
  const selectionBubble = useDirectHtmlSelection(hostRef)
  const stamped = useMemo(
    () => stampHtmlSource(html, htmlBlockKey(hostRef.current?.closest('[data-page-block]') ?? null, html), name),
    [html],
  )

  return (
    <div
      ref={hostRef}
      data-testid="page-html-direct"
      className={fill ? 'html-direct-fill' : undefined}
      style={{
        position: 'relative',
        width: cssBoxSize(width) ?? '100%',
        height: cssBoxSize(height) ?? (fillHost ? HTML_FILL_HOST_PX : undefined),
        maxWidth: '100%',
        overflow: sized ? 'auto' : undefined,
        boxSizing: 'border-box',
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {fill ? <style>{HTML_FILL_CSS}</style> : null}
      {(hover || editing) && (
        <FloatBar
          editing={editing}
          setEditing={setEditing}
          ro={ro}
          onExpand={deck.start}
          deck={deckOn}
          onDeck={(next) => update({ deck: next })}
          sized={sized}
          onResetSize={() => update({ width: undefined, height: undefined })}
        />
      )}
      {editing ? (
        <SourceEditor html={html} onChange={(v) => update({ html: v })} />
      ) : (
        <div
          className={fill ? 'html-direct-fill-inner' : undefined}
          style={{ overflowX: sized ? undefined : 'auto', height: fill ? '100%' : undefined }}
          onMouseDown={(event) => {
            event.stopPropagation()
            suspendAncestorDrag(event.currentTarget)
          }}
          dangerouslySetInnerHTML={{ __html: stamped }}
        />
      )}
      {ro || editing ? null : <SizeGrip reveal={hover} boxRef={hostRef} onSize={(next) => update(next)} />}
      {editing ? null : selectionBubble}
      {deck.overlay}
    </div>
  )
}

/* ============================================================
   2) kind=htmlframe：iframe 沙箱隔离渲染（可跑脚本）
   同样无外框，iframe 本身不再描边
   ============================================================ */

const HTML_FRAME_SAMPLE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${MAG_INK};color:${MAG_PAPER}}
@keyframes mag-pulse{50%{opacity:.35}}
@keyframes mag-rail{from{transform:translateX(0)}to{transform:translateX(-50%)}}
.mag{font-family:'Helvetica Neue',Arial,sans-serif;background:${MAG_INK};border:2px solid ${MAG_PAPER};color:${MAG_PAPER};margin:0;min-height:100%;box-sizing:border-box;display:flex;flex-direction:column}
.mag-head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid ${MAG_PAPER};padding:8px 12px;padding-right:220px;font-size:11px;letter-spacing:.15em}
.mag-hero{background:${MAG_BLUE};color:#fff;font-size:34px;font-weight:900;line-height:1.05;padding:16px;letter-spacing:-.02em}
.mag-body{display:flex;gap:0;flex:1}
.mag-copy{flex:1.4;padding:12px;font-size:13px;line-height:1.7;font-weight:500}
.mag-side{flex:1;border-left:2px solid ${MAG_PAPER};display:flex;flex-direction:column;gap:6px;padding:12px;font-size:10px;font-weight:800}
.mag-live{display:inline-flex;align-items:center;gap:6px}
.mag-dot{width:7px;height:7px;border-radius:50%;background:#ff2a6d;animation:mag-pulse 1.1s ease-in-out infinite}
.mag-rail-wrap{overflow:hidden;border-top:2px solid ${MAG_PAPER}}
.mag-rail{display:flex;width:max-content;animation:mag-rail 12s linear infinite;font-size:10px;font-weight:800;letter-spacing:.18em;padding:6px 0}
.mag-rail span{padding:0 18px;white-space:nowrap}
.mag-hit{cursor:pointer;background:#ffd400;color:#0a0a0a;padding:2px 6px;border:0;font:inherit;font-weight:800}
</style></head><body>
<div class="mag">
  <div class="mag-head"><span style="font-weight:700">现代 ・ 美式</span><span class="mag-live"><span class="mag-dot"></span><span id="mag-clock" style="font-weight:800">创立 2024</span></span></div>
  <div class="mag-hero">丰富<br>排版，<br><span id="mag-line">会跑脚本。</span></div>
  <div class="mag-body">
    <div class="mag-copy">同一夜间刊头，沙箱里跑脚本：时钟、词条轮播、点击计数。版式与静态块一致，只是内容会动。</div>
    <div class="mag-side">
      <button type="button" class="mag-hit" id="mag-hit">动态 · 点我 <span id="mag-n">0</span></button>
      <span style="background:#ff2a6d;color:#fff;padding:2px 6px">有脚本</span>
      <span style="border:1.5px solid ${MAG_PAPER};padding:2px 6px">iframe</span>
    </div>
  </div>
  <div class="mag-rail-wrap"><div class="mag-rail" id="mag-rail"><span>NIGHT ISSUE</span><span>LIVE TYPE</span><span>NEW YORK GRID</span><span>NIGHT ISSUE</span><span>LIVE TYPE</span><span>NEW YORK GRID</span></div></div>
</div>
<script>
(function(){
  var lines=['会跑脚本。','会动。','夜间刊。'];
  var i=0,n=0;
  var clock=document.getElementById('mag-clock');
  var line=document.getElementById('mag-line');
  var hit=document.getElementById('mag-hit');
  var count=document.getElementById('mag-n');
  function tick(){
    var d=new Date();
    var hh=String(d.getHours()).padStart(2,'0');
    var mm=String(d.getMinutes()).padStart(2,'0');
    var ss=String(d.getSeconds()).padStart(2,'0');
    if(clock) clock.textContent=hh+':'+mm+':'+ss;
  }
  tick();
  setInterval(tick,1000);
  setInterval(function(){
    i=(i+1)%lines.length;
    if(line) line.textContent=lines[i];
  },1800);
  if(hit) hit.addEventListener('click',function(){
    n+=1;
    if(count) count.textContent=String(n);
  });
})();
</script>
</body></html>`

function useFrameHtmlSelection(
  frameRef: { current: HTMLIFrameElement | null },
  nonce: string,
) {
  const [state, setState] = useState<SelectionBubbleState | null>(null)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseHtmlSelectionMessage(event, frameRef.current, nonce)
      if (!message) return
      if (message.action === 'attach' || htmlPick?.picking) {
        if (attachHtmlSelection(message.text)) setState(null)
        return
      }
      const frameBox = frameRef.current?.getBoundingClientRect()
      if (!frameBox) return
      const rect = message.rect
      const center = rect ? rect.left + rect.width / 2 : frameBox.width / 2
      setState({
        text: message.text,
        top: Math.max(8, frameBox.top + (rect?.top ?? 0) - 40),
        left: Math.min(window.innerWidth - 44, Math.max(8, frameBox.left + center - 16)),
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef, nonce])
  const attach = () => {
    if (!state || !attachHtmlSelection(state.text)) return
    setState(null)
  }
  return {
    bubble: <SelectionBubble state={state} onAttach={attach} />,
    clear: () => setState(null),
  }
}

function HtmlFrameCard({ data, update, writable }: BlockProps) {
  const ro = !writable
  const html = String(data.html ?? '')
  const height = Number(data.height) || 300
  const deckOn = htmlDeckEnabled(data.deck)
  const [editing, setEditing] = useState(false)
  const [hover, setHover] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const nonceRef = useRef(`html-selection-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
  const bridgedHtml = useMemo(
    () => injectHtmlSelectionBridge(html, nonceRef.current),
    [html],
  )
  const selection = useFrameHtmlSelection(frameRef, nonceRef.current)
  const deck = useHtmlDeck(hostRef, 'htmlframe', html, { height, deck: deckOn })

  const stampFrame = () => {
    const frame = frameRef.current
    if (!frame) return
    const host = hostRef.current?.closest('[data-page-block]') ?? null
    const key = htmlBlockKey(host, html)
    stampHtmlPickSurfaces(frame, key, { plugin: name })
    try {
      const body = frame.contentDocument?.body
      if (body) stampHtmlPickSurfaces(body, `${key}-doc`, { plugin: name })
    } catch {
      /* srcdoc + sandbox 可能读不到 contentDocument */
    }
  }

  useEffect(() => {
    if (editing) return
    queueMicrotask(stampFrame)
  }, [editing, html, height])

  return (
    <div
      ref={hostRef}
      data-testid="page-html-frame"
      style={{ position: 'relative', width: '100%' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {(hover || editing) && (
        <FloatBar editing={editing} setEditing={setEditing} ro={ro} onExpand={deck.start} deck={deckOn} onDeck={(next) => update({ deck: next })}>
          {ro ? null : (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', color: '#111', fontSize: 10, fontWeight: 800, letterSpacing: '.15em', borderLeft: '2px solid #111' }}>
              H
              <input
                type="number"
                min={80}
                value={height}
                onChange={(e) => update({ height: Number(e.target.value) || 300 })}
                style={{ width: 52, border: '2px solid #111', borderRadius: 0, background: '#fff', color: '#111', padding: '1px 4px', fontSize: 12, fontFamily: inkFace }}
              />
            </label>
          )}
        </FloatBar>
      )}
      {editing ? (
        <SourceEditor html={html} onChange={(v) => update({ html: v })} />
      ) : (
        <iframe
          ref={frameRef}
          data-testid="page-html-frame-preview"
          title="html-frame"
          srcDoc={bridgedHtml}
          sandbox="allow-scripts"
          onLoad={() => {
            selection.clear()
            stampFrame()
          }}
          style={{ display: 'block', width: '100%', height, border: 'none', background: MAG_INK, pointerEvents: 'auto' }}
        />
      )}
      {editing ? null : selection.bubble}
      {deck.overlay}
    </div>
  )
}

/* ---------------- apply ---------------- */

export function apply(ctx: {
  pick: HtmlPickService
  pageEditor: {
    registerBlock: (spec: {
      kind: string
      plugin: string
      label: string
      blockType?: string
      blockTypeLabel?: string
      hint?: string
      aliases?: string[]
      defaults?: Record<string, unknown> | (() => Record<string, unknown>)
      View: (props: BlockProps) => unknown
    }) => void
  }
}) {
  htmlPick = ctx.pick
  ctx.pageEditor.registerBlock({
    kind: 'html',
    plugin: name,
    label: '静态HTML',
    blockType: 'html',
    blockTypeLabel: 'HTML',
    hint: 'HTML/CSS 卡片和刊头，不跑脚本；悬停可编辑',
    aliases: ['html', 'html直', '静态html', '排版', '直接渲染', '静态渲染', '静态演示'],
    assets: (data: Record<string, unknown>) => {
      const html = String(data.html ?? '')
      const out: string[] = []
      for (const match of html.matchAll(/<(?:img|a|source|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        out.push(match[1] ?? '')
      }
      return out
    },
    defaults: { html: HTML_DIRECT_SAMPLE, deck: true },
    View: HtmlDirectCard,
  })
  ctx.pageEditor.registerBlock({
    kind: 'htmlframe',
    plugin: name,
    label: '动态HTML',
    blockType: 'html',
    blockTypeLabel: 'HTML',
    hint: '能跑脚本的独立页面；放大后可翻页放映',
    aliases: ['iframe', 'htmlf', 'frame', '幻灯片', 'slide', '沙箱', '小网页', '动态演示'],
    assets: (data: Record<string, unknown>) => {
      const html = String(data.html ?? '')
      const out: string[] = []
      for (const match of html.matchAll(/<(?:img|a|source|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        out.push(match[1] ?? '')
      }
      return out
    },
    defaults: { html: HTML_FRAME_SAMPLE, height: 300, deck: true },
    View: HtmlFrameCard,
  })
}
