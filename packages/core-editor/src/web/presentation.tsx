import { Service, type Context } from 'cordis'
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowTopRightOnSquareIcon, MinusIcon, ViewColumnsIcon } from '@heroicons/react/16/solid'

export type PagePresentationMode = 'inline' | 'sidebar' | 'maximized' | 'minimized'

export type PagePresentationControls = {
  mode: PagePresentationMode
  detached: boolean
  inline: () => void
  sidebar: () => void
  maximize: () => void
  minimize: () => void
  restore: () => void
}

type Entry = {
  id: string
  plugin: string
  title: string
  host: HTMLElement
  inlineTarget: HTMLElement
  mode: PagePresentationMode
  restoreMode: Exclude<PagePresentationMode, 'minimized'>
  recordId: string
  detached: boolean
}

type EntrySnapshot = Pick<Entry, 'id' | 'plugin' | 'title' | 'mode' | 'restoreMode' | 'recordId' | 'detached'>

type PresentationBridge = {
  available?: boolean
  open?: (request: { recordId: string; title: string }) => Promise<unknown>
  focus?: (request: { recordId: string }) => Promise<boolean>
  onClosed?: (fn: (payload: { recordId?: unknown }) => void) => (() => void)
}

const PANEL_ID = 'page-plugin'
const STYLE_ID = 'page-presentation-style'

const STYLE = `
.page-presentation-content{box-sizing:border-box;width:100%;min-width:0}
.page-presentation-content[data-presentation-mode=sidebar],
.page-presentation-content[data-presentation-mode=maximized]{height:100%;min-height:0;overflow:auto;background:var(--dsw-bg)}
.page-presentation-bar{display:flex;flex:none;align-items:center;gap:8px;height:38px;padding:0 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-sidebar);font:12px/1 var(--font-sans)}
.page-presentation-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.page-presentation-spacer{flex:1}
.page-presentation-btn{height:26px;margin:0;border:1px solid var(--dsw-border);border-radius:6px;padding:0 9px;background:var(--dsw-input);color:var(--dsw-label);font:inherit;font-weight:650;cursor:pointer}
.page-presentation-btn:hover{background:var(--dsw-hover)}
.page-presentation-stage{position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}
.page-presentation-sidebar{display:flex;height:100%;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.page-presentation-sidebar .page-presentation-stage{overflow:auto}
.page-presentation-minimized{display:flex;min-width:0;align-items:center;gap:10px;border:1px solid var(--dsw-border);border-radius:8px;padding:8px 10px;background:var(--dsw-sidebar);color:var(--dsw-label);font:12px/1.4 var(--font-sans)}
.page-presentation-minimized-content{min-width:0;flex:1;overflow:hidden}
.page-presentation-minimized-default{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.page-presentation-minimized-restore{display:grid;width:26px;height:26px;flex:none;place-items:center;border:1px solid var(--dsw-border);border-radius:6px;padding:0;background:var(--dsw-input);color:var(--dsw-label);cursor:pointer}
.page-presentation-minimized-restore:hover{background:var(--dsw-hover)}
.page-presentation-minimized-restore svg{width:15px;height:15px}
.page-presentation-inline-actions{position:absolute;right:6px;top:6px;z-index:24;display:flex;gap:4px;opacity:0;transition:opacity .12s}
.page-block:hover>.page-presentation-inline-actions,.page-presentation-inline-actions:focus-within{opacity:1}
.page-presentation-inline-actions button{display:grid;width:26px;height:26px;place-items:center;border:1px solid var(--dsw-border);border-radius:6px;padding:0;background:var(--dsw-sidebar);color:var(--dsw-label);cursor:pointer}
.page-presentation-inline-actions svg,.page-presentation-btn.is-icon svg{width:15px;height:15px}
.page-presentation-btn.is-icon{display:grid;width:28px;padding:0;place-items:center}
.page-presentation-placeholder{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;border:1px dashed var(--dsw-border);border-radius:8px;padding:8px 10px;color:var(--dsw-label-3);font:12px/1.4 var(--font-sans)}
.page-presentation-placeholder button{border:0;background:transparent;color:var(--dsw-pick);font:inherit;font-weight:700;cursor:pointer}
.page-presentation-content[data-presentation-mode=sidebar] .pt-card,
.page-presentation-content[data-presentation-mode=maximized] .pt-card{height:100%!important;min-height:0}
.page-presentation-content[data-presentation-mode=sidebar] .pt-pane,
.page-presentation-content[data-presentation-mode=maximized] .pt-pane{height:auto!important;flex:1!important}
.page-presentation-content[data-presentation-mode=sidebar] .wsp-root{height:100%;border:0;border-radius:0}
.page-presentation-content[data-presentation-mode=sidebar] .wsp-body{grid-template-columns:1fr;height:auto;min-height:100%}
.page-presentation-content[data-presentation-mode=sidebar] .wsp-side{max-height:260px;border-right:0;border-bottom:1px solid var(--dsw-border)}
.page-block-popout{display:flex;width:100vw;height:100vh;min-width:0;min-height:0;flex-direction:column;overflow:hidden;background:var(--dsw-bg);color:var(--dsw-label)}
.page-block-popout-head{display:flex;flex:none;align-items:center;gap:12px;height:42px;padding:0 12px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-sidebar);-webkit-app-region:drag}
.page-block-popout-head strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.page-block-popout-head button{height:26px;border:1px solid var(--dsw-border);border-radius:6px;padding:0 10px;background:var(--dsw-input);color:var(--dsw-label);cursor:pointer;-webkit-app-region:no-drag}
.page-block-popout-stage{display:flex;flex:1;min-width:0;min-height:0;overflow:auto;padding:12px}
.page-block-popout-stage>.page-block{width:100%;min-height:0}
.page-block-popout-stage .pt-card{height:100%!important;min-height:0}
.page-block-popout-stage .pt-pane{height:auto!important;flex:1!important}
`

function ensureStyle() {
  if (typeof document === 'undefined') return
  const style = document.getElementById(STYLE_ID) ?? document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  if (style.parentNode !== document.head) document.head.appendChild(style)
}

function paneId(id: string) {
  return `${PANEL_ID}::${encodeURIComponent(id)}`
}

function entryId(raw: string) {
  const split = raw.indexOf('::')
  if (split < 0) return ''
  try {
    return decodeURIComponent(raw.slice(split + 2))
  } catch {
    return ''
  }
}

let bound: PagePresentationService | undefined

export function getPagePresentation() {
  return bound
}

export class PagePresentationService extends Service {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private targets = new Map<string, HTMLElement>()
  private parking: HTMLElement | null = null
  private browserWindows = new Map<string, Window>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'pagePresentation')
    bound = this
    ensureStyle()
    const disposeClosed = this.bridge()?.onClosed?.((payload) => {
      const recordId = typeof payload?.recordId === 'string' ? payload.recordId : ''
      if (!recordId) return
      for (const item of this.entries.values()) {
        if (item.recordId !== recordId || !item.detached) continue
        item.detached = false
        this.bump()
      }
    })
    ctx.effect(() => () => {
      disposeClosed?.()
      if (bound === this) bound = undefined
      this.parking?.remove()
      this.parking = null
    })
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  version = () => this.seq

  snapshot(id: string): EntrySnapshot | null {
    const item = this.entries.get(id)
    return item ? this.publicEntry(item) : null
  }

  snapshots(): EntrySnapshot[] {
    return [...this.entries.values()].map((item) => this.publicEntry(item))
  }

  register(meta: {
    id: string
    plugin: string
    title: string
    host: HTMLElement
    inlineTarget: HTMLElement
    recordId?: string
  }) {
    const previous = this.entries.get(meta.id)
    const item: Entry = {
      ...meta,
      mode: previous?.mode ?? 'inline',
      restoreMode: previous?.restoreMode ?? 'inline',
      recordId: meta.recordId?.trim() || previous?.recordId || '',
      detached: previous?.detached ?? false,
    }
    meta.host.classList.add('page-presentation-content')
    this.entries.set(meta.id, item)
    this.place(item)
    this.bump()
    return () => {
      if (this.entries.get(meta.id) !== item) return
      this.entries.delete(meta.id)
      this.targets.delete(meta.id)
      meta.host.remove()
      if (item.mode === 'sidebar') this.closeInspector(item.id)
      this.bump()
    }
  }

  controls(id: string): PagePresentationControls {
    const item = this.entries.get(id)
    return {
      mode: item?.mode ?? 'inline',
      detached: item?.detached ?? false,
      inline: () => this.setMode(id, 'inline'),
      sidebar: () => this.setMode(id, 'sidebar'),
      maximize: () => void this.openDetached(id),
      minimize: () => this.setMode(id, 'minimized'),
      restore: () => this.restore(id),
    }
  }

  updateMeta(id: string, patch: { title?: string; plugin?: string; recordId?: string }) {
    const item = this.entries.get(id)
    if (!item) return
    const title = patch.title?.trim()
    const plugin = patch.plugin?.trim()
    const recordId = patch.recordId?.trim()
    if (title) item.title = title
    if (plugin) item.plugin = plugin
    if (recordId) item.recordId = recordId
    this.bump()
  }

  setMode(id: string, mode: PagePresentationMode) {
    const item = this.entries.get(id)
    if (!item) return
    if (item.mode === mode) return
    const previous = item.mode
    if (mode === 'maximized') {
      void this.openDetached(id)
      return
    }
    if (mode === 'minimized' && previous !== 'minimized') {
      item.restoreMode = previous === 'maximized' ? 'inline' : previous
    }
    item.mode = mode
    if (previous === 'sidebar' && mode !== 'sidebar') this.closeInspector(id)
    this.place(item)
    this.bump()
    if (mode === 'sidebar') {
      window.dispatchEvent(new Event('biu:inspector-open'))
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('biu:inspector-tab', { detail: paneId(id) })))
    }
  }

  restore(id: string) {
    const item = this.entries.get(id)
    if (!item) return
    this.setMode(id, item.restoreMode)
  }

  async openDetached(id: string) {
    const item = this.entries.get(id)
    if (!item || !item.recordId) return
    const request = { recordId: item.recordId, title: item.title }
    const bridge = this.bridge()
    if (bridge?.available && bridge.open) {
      await bridge.open(request)
    } else {
      const current = this.browserWindows.get(item.recordId)
      if (current && !current.closed) current.focus()
      else {
        const target = new URL(window.location.href)
        target.search = ''
        target.searchParams.set('popout', 'page-block')
        target.searchParams.set('record', item.recordId)
        const opened = window.open(target, `biu-page-block-${item.recordId}`, 'popup,width=1200,height=800')
        if (opened) this.browserWindows.set(item.recordId, opened)
      }
    }
    item.detached = true
    this.bump()
  }

  attachTarget(id: string, target: HTMLElement) {
    this.targets.set(id, target)
    const item = this.entries.get(id)
    if (item) this.place(item)
    return () => {
      if (this.targets.get(id) !== target) return
      this.targets.delete(id)
      const current = this.entries.get(id)
      if (current?.mode === 'sidebar') {
        current.mode = 'inline'
        this.place(current)
        this.bump()
      }
    }
  }

  private publicEntry(item: Entry): EntrySnapshot {
    return {
      id: item.id,
      plugin: item.plugin,
      title: item.title,
      mode: item.mode,
      restoreMode: item.restoreMode,
      recordId: item.recordId,
      detached: item.detached,
    }
  }

  private park() {
    if (this.parking?.isConnected) return this.parking
    const el = document.createElement('div')
    el.hidden = true
    el.setAttribute('data-page-presentation-parking', '')
    document.body.appendChild(el)
    this.parking = el
    return el
  }

  private place(item: Entry) {
    let target: HTMLElement | null = null
    if (item.mode === 'inline') target = item.inlineTarget
    else if (item.mode === 'minimized') target = this.park()
    else target = this.targets.get(item.id) ?? null
    item.host.dataset.presentationMode = item.mode
    if (target && item.host.parentElement !== target) target.appendChild(item.host)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }

  private closeInspector(id: string) {
    window.dispatchEvent(new CustomEvent('biu:inspector-pane-closed', { detail: paneId(id) }))
  }

  private bridge() {
    return (window as unknown as { biuPresentation?: PresentationBridge }).biuPresentation
  }

  private bump() {
    this.seq += 1
    for (const listener of this.listeners) listener()
  }
}

export function usePagePresentation(id?: string) {
  const service = bound
  useSyncExternalStore(
    (fn) => (service ? service.subscribe(fn) : () => undefined),
    () => service?.version() ?? 0,
    () => 0,
  )
  return id && service ? service.controls(id) : null
}

function PresentationTarget({
  service,
  id,
  className,
}: {
  service: PagePresentationService
  id: string
  className: string
}) {
  const targetRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const target = targetRef.current
    return target ? service.attachTarget(id, target) : undefined
  }, [service, id])
  return <div ref={targetRef} className={className} data-page-presentation-target={id} />
}

export function PagePresentationLayer({ presentation }: { presentation?: PagePresentationService }) {
  const service = presentation ?? bound
  if (!service) return null
  return null
}

function PresentationBar({
  service,
  entry,
  where,
}: {
  service: PagePresentationService
  entry: EntrySnapshot
  where: 'sidebar'
}) {
  return (
    <div className="page-presentation-bar" data-biu-ignore>
      <span className="page-presentation-title">{entry.title}</span>
      <span className="page-presentation-spacer" />
      <button
        type="button"
        className="page-presentation-btn is-icon"
        title={entry.detached ? '聚焦独立窗口' : '在独立窗口打开'}
        aria-label={entry.detached ? '聚焦独立窗口' : '在独立窗口打开'}
        onClick={() => void service.openDetached(entry.id)}
      >
        <ArrowTopRightOnSquareIcon aria-hidden />
      </button>
      <button type="button" className="page-presentation-btn" onClick={() => service.setMode(entry.id, 'minimized')}>
        收起
      </button>
      <button type="button" className="page-presentation-btn" onClick={() => service.setMode(entry.id, 'inline')}>
        页面内
      </button>
    </div>
  )
}

export function PagePresentationInspector({
  presentation,
  paneId: rawPaneId,
}: {
  presentation?: PagePresentationService
  paneId?: string
}) {
  const service = presentation ?? bound
  const id = entryId(String(rawPaneId ?? ''))
  if (!service || !id) return null
  return <PagePresentationInspectorInner service={service} id={id} />
}

function PagePresentationInspectorInner({ service, id }: { service: PagePresentationService; id: string }) {
  useSyncExternalStore(service.subscribe, service.version, () => 0)
  const item = service.snapshot(id)
  if (!item) return <div className="page-presentation-sidebar">插件实例已关闭。</div>
  return (
    <div className="page-presentation-sidebar">
      <PresentationBar service={service} entry={item} where="sidebar" />
      <PresentationTarget service={service} id={id} className="page-presentation-stage" />
    </div>
  )
}

export function PagePresentationInlineActions({
  controls,
}: {
  controls: PagePresentationControls
}) {
  if (controls.mode !== 'inline') return null
  return (
    <div className="page-presentation-inline-actions" data-biu-ignore>
      <button type="button" title="收起" aria-label="收起" onClick={controls.minimize}>
        <MinusIcon aria-hidden />
      </button>
      <button type="button" title="在右侧栏打开" aria-label="在右侧栏打开" onClick={controls.sidebar}>
        <ViewColumnsIcon aria-hidden />
      </button>
      <button
        type="button"
        title={controls.detached ? '聚焦独立窗口' : '在独立窗口打开'}
        aria-label={controls.detached ? '聚焦独立窗口' : '在独立窗口打开'}
        onClick={controls.maximize}
      >
        <ArrowTopRightOnSquareIcon aria-hidden />
      </button>
    </div>
  )
}

export function PagePresentationMinimized({
  title,
  onRestore,
  children,
}: {
  title: string
  onRestore: () => void
  children?: ReactNode
}) {
  return (
    <div className="page-presentation-minimized" data-biu-ignore data-testid="page-presentation-minimized">
      <div className="page-presentation-minimized-content">
        {children ?? <div className="page-presentation-minimized-default">{title}</div>}
      </div>
      <button
        type="button"
        className="page-presentation-minimized-restore"
        title="展开"
        aria-label="展开"
        onClick={onRestore}
      >
        <ViewColumnsIcon aria-hidden />
      </button>
    </div>
  )
}

export function PagePresentationPlaceholder({
  mode,
  onRestore,
}: {
  mode: Exclude<PagePresentationMode, 'inline'>
  onRestore: () => void
}) {
  const label = mode === 'sidebar' ? '右侧栏' : mode === 'maximized' ? '独立窗口' : '最小化栏'
  return (
    <div className="page-presentation-placeholder" data-biu-ignore>
      <span>该插件正在{label}显示</span>
      <button type="button" onClick={onRestore}>放回页面</button>
    </div>
  )
}

declare module 'cordis' {
  interface Context {
    pagePresentation: PagePresentationService
  }
}
