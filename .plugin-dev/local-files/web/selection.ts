import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { PLUGIN_ID } from './runtime.ts'

export type FileSelection = {
  startLine: number
  endLine: number
  text: string
  selection: string
  from: number
  to: number
}

export type LocalFilePick = {
  kind: 'local-file'
  id: string
  label: string
  route: string
  title: string
  path: string
  plugin: string
  start_line: number
  end_line: number
  text: string
  selection: string
}

export type PickApi = {
  attach: (refs: LocalFilePick[]) => void
}

const MAX_SELECTION_BYTES = 100 * 1024

export function readFileSelection(state: EditorState): FileSelection | null {
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
    id: `${path}#${selection.from}:${selection.to}`,
    label: `本地文件 · ${source.path} · L${selection.startLine}–${selection.endLine}`,
    route: source.route,
    title: `[本地文件插件 ${PLUGIN_ID}；rootId=${source.rootId}；${source.unsaved ? '含未保存修改' : '文件内容'}；非服务器文件/非数据库记录] ${location}`,
    path,
    plugin: PLUGIN_ID,
    start_line: selection.startLine,
    end_line: selection.endLine,
    text: encoder.encode(selection.text).length <= MAX_SELECTION_BYTES ? selection.text : selection.selection,
    selection: selection.selection,
  }
}

export function isAttachHotkey(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing &&
    event.key.toLowerCase() === 'l'
}

export function bindSelectionHotkey(view: EditorView, attach: (selection: FileSelection | null) => void) {
  const win = view.dom.ownerDocument.defaultView
  if (!win) return () => undefined
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isAttachHotkey(event)) return
    const target = event.target
    if (!(target instanceof win.Node) || !view.contentDOM.contains(target)) return
    if (!view.dom.isConnected || view.dom.closest('[hidden], [inert], [aria-hidden="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) attach(readFileSelection(view.state))
  }
  win.addEventListener('keydown', onKeyDown, true)
  return () => win.removeEventListener('keydown', onKeyDown, true)
}
