// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { localFilePick, type FileSelection } from './selection.ts'
import { formatPicks } from '../../../packages/core-pick/src/web/types.ts'

let preview: typeof import('./preview.tsx')
let mounted: Root | undefined

beforeAll(async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  preview = await import('./preview.tsx')
})

afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount())
  mounted = undefined
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

afterAll(() => vi.unstubAllGlobals())

async function mount(onAttach: (selection: FileSelection | null) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = createRoot(container)
  await act(async () => mounted!.render(<preview.MarkdownPreview text={'# 标题\n\n选中**这段内容**给 agent'} title="README.md" onAttach={onAttach} />))
  return container
}

function select(container: HTMLElement) {
  const node = container.querySelector('strong')!.firstChild!
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return node.parentElement!
}

test('Markdown output excludes executable HTML, global styles, forms and DOM clobbering attributes', () => {
  const html = preview.safeMarkdownHtml('# 标题\n<script>alert(1)</script><style>body{display:none}</style><iframe src="/api/snapshot"></iframe><form><input name="React"></form><img id="lf-styles" src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><svg onload="alert(1)"></svg>')
  const root = document.createElement('div')
  root.innerHTML = html
  expect(root.querySelector('h1')?.textContent).toBe('标题')
  expect(root.querySelector('script,style,iframe,form,input,svg')).toBeNull()
  expect(root.querySelector('[id],[name],[onerror],[onload]')).toBeNull()
  expect(root.querySelector('a')?.getAttribute('href')).toBeNull()
  expect(root.querySelector('img')?.getAttribute('src')).toBeNull()
})

test('Command+L in Markdown preview transfers the actual selection with plugin and file provenance', async () => {
  const attached: ReturnType<typeof localFilePick>[] = []
  const attach = vi.fn((selection: FileSelection | null) => {
    if (selection) attached.push(localFilePick(selection, { rootId: 'lf-md', rootName: 'project', path: 'README.md', route: '/sessions/s1', unsaved: false }))
  })
  const container = await mount(attach)
  const selected = select(container)
  const outerHotkey = vi.fn()
  container.addEventListener('keydown', outerHotkey, true)
  const event = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { selected.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(outerHotkey).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledTimes(1)
  expect(attached[0]).toMatchObject({ plugin: 'local-files', kind: 'local-file', path: 'local-file://lf-md/README.md', selection: '这段内容' })
  expect(attached[0].start_line).toBeUndefined()
  expect(attached[0].title).toContain('Markdown 渲染预览选区')
  const token = formatPicks(attached)
  expect(JSON.parse(token.slice(6, -7)).selection).toBe('这段内容')
})

test('preview hotkey handles body-targeted events but does not steal shortcuts from other inputs', async () => {
  const attach = vi.fn()
  const container = await mount(attach)
  select(container)
  const input = document.createElement('input')
  document.body.appendChild(input)
  const elsewhere = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  input.dispatchEvent(elsewhere)
  expect(elsewhere.defaultPrevented).toBe(false)
  expect(attach).not.toHaveBeenCalled()
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(attach).toHaveBeenCalledTimes(1)
})

test('preview button preserves selected text and hidden previews do not handle Command+L', async () => {
  const attach = vi.fn()
  const container = await mount(attach)
  const selected = select(container)
  const button = container.querySelector('button')!
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  button.dispatchEvent(down)
  expect(down.defaultPrevented).toBe(true)
  await act(async () => button.click())
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ selection: '这段内容', view: 'preview' }))
  container.hidden = true
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  selected.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(attach).toHaveBeenCalledTimes(1)
})

test('inside a page editor (contenteditable root has focus) Command+L still goes to the plugin, not the page', async () => {
  const attach = vi.fn()
  const page = document.createElement('div')
  page.setAttribute('contenteditable', 'true')
  const block = document.createElement('div')
  block.setAttribute('contenteditable', 'false')
  page.appendChild(block)
  document.body.appendChild(page)
  mounted = createRoot(block)
  await act(async () => mounted!.render(<preview.MarkdownPreview text={'选中**这段内容**给 agent'} title="README.md" onAttach={attach} />))
  select(block)
  const pageHotkey = vi.fn()
  page.addEventListener('keydown', pageHotkey)
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  page.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(pageHotkey).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ selection: '这段内容' }))
})

test('if the browser drops the preview selection before the key press, the last selection is still sent', async () => {
  const attach = vi.fn()
  const container = await mount(attach)
  select(container)
  await act(async () => { document.dispatchEvent(new Event('selectionchange')) })
  document.getSelection()!.removeAllRanges()
  await act(async () => { document.dispatchEvent(new Event('selectionchange')) })
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ selection: '这段内容' }))

  // 用户在别处重新选了文字后，不再拿旧的预览选区。
  attach.mockClear()
  const other = document.createElement('p')
  other.textContent = '别处文字'
  document.body.appendChild(other)
  const range = document.createRange()
  range.selectNodeContents(other)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  await act(async () => { document.dispatchEvent(new Event('selectionchange')) })
  const again = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(again)
  expect(attach).not.toHaveBeenCalled()
  expect(again.defaultPrevented).toBe(false)
})

test('Command+L without any preview selection is left to the host (page editor / chat)', async () => {
  const attach = vi.fn()
  await mount(attach)
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(attach).not.toHaveBeenCalled()
})

test('pressing in the preview inside a draggable page block allows text selection instead of dragging/selecting the block', async () => {
  const attach = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  // 模拟宿主 NodeViewWrapper：draggable + React onMouseDown 里 setNodeSelection。
  const blockMouseDown = vi.fn()
  mounted = createRoot(container)
  await act(async () => mounted!.render(
    <div data-testid="block" draggable="true" contentEditable={false} onMouseDown={blockMouseDown}>
      <preview.MarkdownPreview text={'选中**这段内容**给 agent'} title="README.md" onAttach={attach} />
    </div>,
  ))
  const block = container.querySelector('[data-testid="block"]')!
  const text = block.querySelector('strong')!
  text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  expect(block.getAttribute('draggable')).toBe('false')
  expect(blockMouseDown).not.toHaveBeenCalled()
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  expect(block.getAttribute('draggable')).toBe('true')
})

test('pick mode keeps the host behaviour (block can still be picked)', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const blockMouseDown = vi.fn()
  mounted = createRoot(container)
  await act(async () => mounted!.render(
    <div data-testid="block" draggable="true" onMouseDown={blockMouseDown}>
      <preview.MarkdownPreview text={'正文'} title="README.md" onAttach={vi.fn()} />
    </div>,
  ))
  const block = container.querySelector('[data-testid="block"]')!
  document.documentElement.classList.add('pick-mode')
  try {
    block.querySelector('p')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(block.getAttribute('draggable')).toBe('true')
    expect(blockMouseDown).toHaveBeenCalledTimes(1)
  } finally {
    document.documentElement.classList.remove('pick-mode')
  }
})

test('unmount cleans up the preview shortcut, and raw HTML stays in a scriptless opaque sandbox', async () => {
  const attach = vi.fn()
  const container = await mount(attach)
  select(container)
  await act(async () => mounted!.unmount())
  mounted = undefined
  const event = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  expect(attach).not.toHaveBeenCalled()
  mounted = createRoot(container)
  await act(async () => mounted!.render(<preview.HtmlPreview text={'<script>alert(1)</script>'} title="unsafe.html" />))
  const frame = container.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
})
