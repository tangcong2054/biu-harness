import { editorHostFromNode } from './editor-host.ts'
import { pickIdFromText, pickPreview, type PickRef } from './types.ts'

const MAX_SELECTION_CHARS = 16_000
const SENSITIVE = '[data-biu-sensitive], [data-biu-ignore]'

type SelectionSource = {
  text: string
  anchor: Element
  focus: Element
  native: boolean
}

function elementFromNode(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement ?? null
}

function isSensitive(el: Element | null) {
  if (!el) return false
  if (el.closest(SENSITIVE)) return true
  if (el instanceof HTMLInputElement) {
    return el.type === 'password' || /current-password|new-password/i.test(el.autocomplete)
  }
  return false
}

function selectedInputText(): SelectionSource | null {
  const active = document.activeElement
  if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) return null
  if (isSensitive(active)) return null
  const start = active.selectionStart
  const end = active.selectionEnd
  if (start == null || end == null || start === end) return null
  const text = active.value.slice(Math.min(start, end), Math.max(start, end))
  return text.trim() ? { text, anchor: active, focus: active, native: false } : null
}

function selectedDomText(): SelectionSource | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const anchor = elementFromNode(selection.anchorNode)
  const focus = elementFromNode(selection.focusNode)
  if (!anchor || !focus || isSensitive(anchor) || isSensitive(focus)) return null
  const text = selection.toString()
  return text.trim() ? { text, anchor, focus, native: true } : null
}

function pluginScopeFrom(el: Element) {
  const nearest = el.closest('[data-biu-plugin]')
  if (!(nearest instanceof HTMLElement)) return null
  const plugin = nearest.getAttribute('data-biu-plugin')?.trim()
  if (!plugin) return null
  let scope = nearest
  let parent = nearest.parentElement
  while (parent) {
    if (parent.getAttribute('data-biu-plugin')?.trim() === plugin) scope = parent
    parent = parent.parentElement
  }
  return scope
}

function pageBlockFrom(scope: HTMLElement) {
  if (scope.hasAttribute('data-page-block')) return scope
  const block = scope.closest('[data-page-block][data-biu-plugin]')
  return block instanceof HTMLElement ? block : null
}

function selectionTouchesSensitive(scope: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const range = selection.getRangeAt(0)
  for (const node of scope.querySelectorAll(SENSITIVE)) {
    try {
      if (range.intersectsNode(node)) return true
    } catch {
      /* detached nodes cannot intersect */
    }
  }
  return false
}

function cleanText(value: string) {
  return value.replace(/\u0000/g, '').trim().slice(0, MAX_SELECTION_CHARS)
}

function readable(value: string | null | undefined) {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text || /^(div|span|section|article|p|pre|code|table|td|th)$/i.test(text)) return ''
  return text.slice(0, 120)
}

function cellLocation(anchor: Element, block: HTMLElement) {
  const cell = anchor.closest('th,td')
  if (!(cell instanceof HTMLTableCellElement) || !block.contains(cell)) return ''
  const row = cell.parentElement
  if (!(row instanceof HTMLTableRowElement)) return ''
  const table = cell.closest('table')
  if (!(table instanceof HTMLTableElement)) return ''
  const column = cell.cellIndex + 1
  const rowIndex = Array.from(table.rows).indexOf(row) + 1
  const header = readable(table.tHead?.rows[0]?.cells[cell.cellIndex]?.textContent)
  return `表格第${rowIndex}行，第${column}列${header ? `（${header}）` : ''}`
}

function sectionLocation(anchor: Element, block: HTMLElement) {
  const explicit = anchor.closest('[data-biu-location]')
  if (explicit && block.contains(explicit)) return readable(explicit.getAttribute('data-biu-location'))
  const section = anchor.closest('section,article')
  if (!section || !block.contains(section)) return ''
  return readable(section.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent)
}

function activeTab(block: HTMLElement) {
  const tab = block.querySelector('[role="tab"][aria-selected="true"]')
  return readable(tab?.textContent)
}

function elementMetadata(anchor: Element, block: HTMLElement) {
  let node: Element | null = anchor
  while (node && block.contains(node)) {
    const id = readable(node.getAttribute('data-biu-id'))
    const label =
      readable(node.getAttribute('data-biu-label')) ||
      readable(node.getAttribute('aria-label')) ||
      readable(node.getAttribute('title')) ||
      readable(node.getAttribute('data-testid'))
    const field = readable(node.getAttribute('data-biu-field'))
    if (id || label || field) return { elementId: id, elementLabel: label, field }
    if (node === block) break
    node = node.parentElement
  }
  return { elementId: '', elementLabel: '', field: '' }
}

function locationOf(anchor: Element, block: HTMLElement) {
  const meta = elementMetadata(anchor, block)
  const parts = [
    activeTab(block),
    sectionLocation(anchor, block),
    cellLocation(anchor, block),
    meta.field || meta.elementLabel,
  ].filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index)
  return {
    location: parts.join(' / ').slice(0, 300),
    elementId: meta.elementId,
    field: meta.field,
  }
}

/** 普通 DOM 页面块选区。iframe、canvas、xterm 等特殊表面继续由插件适配器处理。 */
export function pluginTextSelectionPick(route = window.location.pathname): PickRef | null {
  const source = selectedInputText() ?? selectedDomText()
  if (!source) return null
  const scope = pluginScopeFrom(source.anchor)
  if (!scope || pluginScopeFrom(source.focus) !== scope || (source.native && selectionTouchesSensitive(scope))) return null
  const plugin = readable(scope.getAttribute('data-biu-plugin'))
  if (!plugin) return null
  const selection = cleanText(source.text)
  if (!selection) return null
  const block = pageBlockFrom(scope)
  const blockId =
    readable(block?.getAttribute('data-page-block-record')) ||
    readable(block?.getAttribute('data-page-block-id')) ||
    readable(block?.getAttribute('data-biu-id')) ||
    readable(scope.getAttribute('data-biu-id'))
  const blockKind = readable(block?.getAttribute('data-page-block'))
  const host = editorHostFromNode(scope)
  const { location, elementId, field } = locationOf(source.anchor, scope)
  return {
    kind: 'text',
    id: pickIdFromText(`${plugin}:${blockId}:${elementId}:${location}:${selection}`),
    label: pickPreview(selection, 80),
    route,
    selection,
    plugin,
    ...(host?.path ? { path: host.path } : {}),
    ...(host?.title ? { title: host.title } : {}),
    ...(blockId ? { block_id: blockId } : {}),
    ...(blockKind ? { block_kind: blockKind } : {}),
    ...(elementId ? { element_id: elementId } : {}),
    ...(location ? { location } : {}),
    ...(field ? { field } : {}),
  }
}

export function isPluginTextSelectionHotkey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>) {
  if (event.isComposing || event.repeat || event.altKey || event.shiftKey) return false
  return (event.metaKey || event.ctrlKey) && (event.key === 'l' || event.key === 'L')
}

export function installPluginTextSelection(attach: (refs: PickRef[]) => void, route: () => string) {
  const onKey = (event: KeyboardEvent) => {
    // 已有特殊适配器先处理成功时会 preventDefault；宿主不能再发一次。
    if (event.defaultPrevented || !isPluginTextSelectionHotkey(event)) return
    const ref = pluginTextSelectionPick(route())
    if (!ref) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    attach([ref])
  }
  document.addEventListener('keydown', onKey, true)
  return () => document.removeEventListener('keydown', onKey, true)
}
