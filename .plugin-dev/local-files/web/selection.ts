import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { PLUGIN_ID } from './runtime.ts'

export type SourceSelection = {
  startLine: number
  endLine: number
  text: string
  selection: string
  from: number
  to: number
}

export type FileSelection = SourceSelection | {
  view: 'preview'
  text: string
  selection: string
  startLine: null
  endLine: null
  from: null
  to: null
}

export type LocalFilePick = {
  kind: 'local-file'
  id: string
  label: string
  route: string
  title: string
  path: string
  plugin: string
  start_line?: number
  end_line?: number
  text: string
  selection: string
}

export type PickApi = {
  attach: (refs: LocalFilePick[]) => void
}

const MAX_SELECTION_BYTES = 100 * 1024

export function readFileSelection(state: EditorState): SourceSelection | null {
  const { from, to } = state.selection.main
  if (from === to) return null
  const start = state.doc.lineAt(from)
  const end = state.doc.lineAt(to - 1)
  return {
    startLine: start.number,
    endLine: end.number,
    text: state.doc.sliceString(start.from, end.to),
    selection: state.doc.sliceString(from, to),
    from,
    to,
  }
}

export function localFilePick(
  selection: FileSelection,
  source: { rootId: string; rootName: string; path: string; route: string; unsaved: boolean },
): LocalFilePick {
  const encoder = new TextEncoder()
  if (encoder.encode(selection.selection).length > MAX_SELECTION_BYTES) {
    throw new Error('选中内容超过 100KB，请缩小选区或让 agent 使用 read_range 分段读取')
  }
  const path = `local-file://${encodeURIComponent(source.rootId)}/${source.path.split('/').map(encodeURIComponent).join('/')}`
  const location = `${source.rootName}/${source.path}`
  return {
    kind: 'local-file',
    id: `${path}#${selection.from === null ? `preview-${selectionId(selection.selection)}` : `${selection.from}:${selection.to}`}`,
    label: `本地文件 · ${source.path} · ${selection.startLine === null ? 'Markdown 预览选区' : `L${selection.startLine}–${selection.endLine}`}`,
    route: source.route,
    title: `[本地文件插件 ${PLUGIN_ID}；rootId=${source.rootId}；${source.unsaved ? '含未保存修改' : '文件内容'}；${selection.startLine === null ? 'Markdown 渲染预览选区，未标注源码行号；' : ''}非服务器文件/非数据库记录] ${location}`,
    path,
    plugin: PLUGIN_ID,
    ...(selection.startLine !== null ? { start_line: selection.startLine, end_line: selection.endLine as number } : {}),
    text: encoder.encode(selection.text).length <= MAX_SELECTION_BYTES ? selection.text : selection.selection,
    selection: selection.selection,
  }
}

function selectionId(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `${text.length}-${(hash >>> 0).toString(36)}`
}

/**
 * 浏览器（尤其 Firefox）在点按、focus 或页面编辑器接管选区时会把渲染区里的选区清掉，
 * 所以记住最近一次落在渲染区内的选区，按快捷键时优先用活的选区，取不到再用它。
 */
const lastPreview = new WeakMap<HTMLElement, { at: number; selection: FileSelection }>()

export function readPreviewSelection(host: HTMLElement): FileSelection | null {
  const selection = host.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  return { view: 'preview', text, selection: text, startLine: null, endLine: null, from: null, to: null }
}

export function isAttachHotkey(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing &&
    (event.key.toLowerCase() === 'l' || event.code === 'KeyL')
}

/** 渲染区里最近一次真实选区；超过 2 分钟或已被外部选区替代时不用。 */
export function readPreviewSelectionCached(host: HTMLElement): FileSelection | null {
  const live = readPreviewSelection(host)
  if (live) return live
  const kept = lastPreview.get(host)
  if (!kept || Date.now() - kept.at > 120_000) return null
  return kept.selection
}

export function bindPreviewHotkey(host: HTMLElement, attach: (selection: FileSelection | null) => void) {
  const win = host.ownerDocument.defaultView
  if (!win) return () => undefined
  const doc = host.ownerDocument
  const remember = () => {
    if (!host.isConnected) return
    const live = readPreviewSelection(host)
    if (live) {
      lastPreview.set(host, { at: Date.now(), selection: live })
      return
    }
    // 用户在别处重新选了文字，旧的预览选区就不该再被快捷键取用。
    const current = doc.getSelection()
    if (current && !current.isCollapsed && current.rangeCount) {
      const range = current.getRangeAt(0)
      if (!host.contains(range.commonAncestorContainer)) lastPreview.delete(host)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isAttachHotkey(event) || !host.isConnected || host.closest('[hidden], [inert], [aria-hidden="true"]')) return
    const target = event.target
    const inside = target instanceof win.Node && host.contains(target)
    if (!inside) {
      // 页面块嵌在页面编辑器（整页 contenteditable）里，焦点常落在编辑器根上；
      // 只有焦点在「另一个」输入区（不包含本预览）时才让出快捷键。
      const editable = target instanceof win.Element ? target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') : null
      if (editable && !editable.contains(host)) return
    }
    const selection = readPreviewSelectionCached(host)
    if (!selection) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || !claimHotkey(event)) return
    attach(selection)
  }
  doc.addEventListener('selectionchange', remember)
  win.addEventListener('keydown', onKeyDown, true)
  return () => {
    doc.removeEventListener('selectionchange', remember)
    win.removeEventListener('keydown', onKeyDown, true)
    lastPreview.delete(host)
  }
}

/** 同一个按键只允许一个选区来源响应（编辑区和 Markdown 预览的监听都在 window 捕获阶段）。 */
let claimed: KeyboardEvent | null = null
function claimHotkey(event: KeyboardEvent) {
  if (claimed === event) return false
  claimed = event
  return true
}

export function bindSelectionHotkey(view: EditorView, attach: (selection: FileSelection | null) => void) {
  const win = view.dom.ownerDocument.defaultView
  if (!win) return () => undefined
  let focused = false
  const onFocus = () => {
    focused = true
  }
  const onBlur = () => {
    focused = false
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isAttachHotkey(event)) return
    if (!view.dom.isConnected || view.dom.closest('[hidden], [inert], [aria-hidden="true"]')) return
    const target = event.target
    if (!(target instanceof win.Node)) return
    const inside = view.contentDOM.contains(target)
    if (!inside) {
      // 页面块嵌在整页 contenteditable 里：焦点可能落在编辑器根上，但选中的还是这段代码，
      // 只要还没在别处输入（输入框 / 别的编辑区）就照常响应。
      const editable = target instanceof win.Element ? target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') : null
      if (!focused || (editable && !editable.contains(view.dom))) return
    }
    const selection = readFileSelection(view.state)
    // 焦点在编辑区里没选中时也拦下（提示「请先选中」），免得被页面编辑器当成整段发走。
    if (!selection && !inside) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || !claimHotkey(event)) return
    attach(selection)
  }
  view.dom.addEventListener('focusin', onFocus)
  view.dom.addEventListener('focusout', onBlur)
  win.addEventListener('keydown', onKeyDown, true)
  return () => {
    view.dom.removeEventListener('focusin', onFocus)
    view.dom.removeEventListener('focusout', onBlur)
    win.removeEventListener('keydown', onKeyDown, true)
  }
}
