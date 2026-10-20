// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { bindSelectionHotkey, isAttachHotkey, localFilePick, readFileSelection } from './selection.ts'
import { createCodeEditor } from './code-editor.ts'
import { formatPicks } from '../../../packages/core-pick/src/web/types.ts'

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  document.body.replaceChildren()
})

function state(doc = 'first line\n中文 target\nlast line', anchor = 13, head = 17) {
  return EditorState.create({ doc, selection: { anchor, head } })
}

function ctrlL(target: HTMLElement, props: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true, ...props })
  target.dispatchEvent(event)
  return event
}

test('selection contains selected text, complete lines and 1-based line span', () => {
  expect(readFileSelection(state('first\n中文 target\nlast', 8, 16))).toEqual({
    from: 8, to: 16, startLine: 2, endLine: 2, text: '中文 target', selection: ' target\n',
  })
  expect(readFileSelection(state('first\nsecond\nthird', 2, 10))).toMatchObject({
    startLine: 1, endLine: 2, text: 'first\nsecond', selection: 'rst\nseco',
  })
  expect(readFileSelection(state('first\nsecond\nthird', 10, 2))).toEqual(readFileSelection(state('first\nsecond\nthird', 2, 10)))
  expect(readFileSelection(state('first', 2, 2))).toBeNull()
})

test('local file pick includes plugin, root, path, lines and unsaved provenance without posing as a DB record', () => {
  const selection = readFileSelection(state())!
  const source = { rootId: 'lf-a', rootName: 'project', path: 'docs/中文.md', route: '/pages/p001', unsaved: true }
  const ref = localFilePick(selection, source)
  expect(ref).toMatchObject({
    kind: 'local-file', plugin: 'local-files', route: '/pages/p001',
    start_line: selection.startLine, end_line: selection.endLine, selection: selection.selection, text: selection.text,
  })
  expect(ref.path).toBe('local-file://lf-a/docs/%E4%B8%AD%E6%96%87.md')
  expect(ref.title).toContain('rootId=lf-a')
  expect(ref.title).toContain('含未保存修改')
  expect(ref.title).toContain('非数据库记录')
  expect(ref.label).toContain('本地文件')
  expect(localFilePick(selection, { ...source, rootId: 'lf-b' }).id).not.toBe(ref.id)
  expect(localFilePick(selection, { ...source, path: 'other.md' }).id).not.toBe(ref.id)
  const serialized = formatPicks([ref, ref])
  const payload = JSON.parse(serialized.slice('<pick>'.length, -'</pick>'.length))
  expect(payload).toMatchObject({ plugin: 'local-files', path: ref.path, selection: selection.selection.trim(), start_line: selection.startLine })
  expect(payload.title).toContain('rootId=lf-a')
  const single = formatPicks([ref])
  expect(JSON.parse(single.slice('<pick>'.length, -'</pick>'.length)).selection).toBe(selection.selection)
})

test('oversized selections fail clearly while huge surrounding lines are not sent', () => {
  const huge = 'a'.repeat(110000)
  const source = { rootId: 'a', rootName: 'a', path: 'a.txt', route: '/', unsaved: false }
  expect(() => localFilePick(readFileSelection(state(huge, 0, huge.length))!, source)).toThrow('100KB')
  expect(localFilePick(readFileSelection(state(huge, 0, 2))!, source).text).toBe('aa')
})

test('hotkey supports Ctrl and Meta and ignores shift, alt and composing', () => {
  expect(isAttachHotkey(new KeyboardEvent('keydown', { key: 'L', metaKey: true }))).toBe(true)
  expect(isAttachHotkey(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }))).toBe(true)
  for (const extra of [{ shiftKey: true }, { altKey: true }, { isComposing: true }]) {
    expect(isAttachHotkey(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, ...extra }))).toBe(false)
  }
})

test('capture handler beats the outer page editor and is scoped to the visible local editor', () => {
  const outer = document.createElement('div')
  const parent = document.createElement('div')
  outer.appendChild(parent)
  document.body.appendChild(outer)
  const view = new EditorView({ parent, state: state() })
  const attach = vi.fn()
  const outerHandler = vi.fn()
  outer.addEventListener('keydown', outerHandler, true)
  const stop = bindSelectionHotkey(view, attach)
  cleanup.push(() => { stop(); view.destroy() })
  expect(ctrlL(view.contentDOM).defaultPrevented).toBe(true)
  expect(attach).toHaveBeenCalledWith(readFileSelection(view.state))
  expect(outerHandler).not.toHaveBeenCalled()
  ctrlL(view.contentDOM, { repeat: true })
  expect(attach).toHaveBeenCalledTimes(1)
  parent.hidden = true
  expect(ctrlL(view.contentDOM).defaultPrevented).toBe(false)
  expect(attach).toHaveBeenCalledTimes(1)
  parent.hidden = false
  stop()
  expect(ctrlL(view.contentDOM).defaultPrevented).toBe(false)
  expect(attach).toHaveBeenCalledTimes(1)
})

test('unselected local editor produces no content and unrelated inputs are untouched', () => {
  const parent = document.createElement('div')
  const other = document.createElement('input')
  document.body.append(parent, other)
  const view = new EditorView({ parent, state: state('abc', 1, 1) })
  const attach = vi.fn()
  const stop = bindSelectionHotkey(view, attach)
  cleanup.push(() => { stop(); view.destroy() })
  expect(ctrlL(other).defaultPrevented).toBe(false)
  expect(attach).not.toHaveBeenCalled()
  expect(ctrlL(view.contentDOM).defaultPrevented).toBe(true)
  expect(attach).toHaveBeenCalledWith(null)
})

test('CodeMirror integration calls onAttach and removes listener when the editor is destroyed', () => {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const attach = vi.fn()
  const editor = createCodeEditor(parent, { doc: 'markdown text', name: 'README.md', readOnly: true, onChange: () => {}, onSave: () => {}, onAttach: attach })
  const dom = parent.querySelector<HTMLElement>('.cm-content')!
  const view = EditorView.findFromDOM(dom)!
  view.dispatch({ selection: { anchor: 0, head: 8 } })
  ctrlL(dom)
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ selection: 'markdown', startLine: 1 }))
  editor.destroy()
  expect(ctrlL(dom).defaultPrevented).toBe(false)
  expect(attach).toHaveBeenCalledTimes(1)
})
