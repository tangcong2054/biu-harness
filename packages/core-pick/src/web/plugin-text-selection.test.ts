import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { bindEditorTextHost } from './editor-host.ts'
import {
  installPluginTextSelection,
  isPluginTextSelectionHotkey,
  pluginTextSelectionPick,
} from './plugin-text-selection.ts'

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

function selectContents(el: Element) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

test('ordinary plugin DOM selection includes plugin, block, page and table location', () => {
  document.body.innerHTML = `
    <div id="editor">
      <div data-page-block="cdb-tasks" data-page-block-id="block-1" data-biu-plugin="cdb-tasks">
        <section data-biu-location="任务详情/开发者信息">
          <table><thead><tr><th>任务 ID</th></tr></thead>
          <tbody><tr><td data-biu-id="cdb-tasks:row/id" data-biu-label="任务 ID"><span id="value">252488077</span></td></tr></tbody></table>
        </section>
      </div>
    </div>`
  const editor = document.querySelector('#editor')!
  bindEditorTextHost(editor, {
    path: '/pages/task-page',
    title: '实例任务',
    locusFromSelection: () => null,
    locusFromElement: () => null,
  })
  selectContents(document.querySelector('#value')!)

  const ref = pluginTextSelectionPick('/pages/task-page')
  assert.ok(ref)
  assert.equal(ref.selection, '252488077')
  assert.equal(ref.plugin, 'cdb-tasks')
  assert.equal(ref.block_id, 'block-1')
  assert.equal(ref.block_kind, 'cdb-tasks')
  assert.equal(ref.element_id, 'cdb-tasks:row/id')
  assert.equal(ref.path, '/pages/task-page')
  assert.equal(ref.title, '实例任务')
  assert.match(ref.location ?? '', /任务详情\/开发者信息/)
  assert.match(ref.location ?? '', /任务 ID/)
  bindEditorTextHost(editor, null)
})

test('textarea selection is captured but passwords and sensitive regions are not', () => {
  document.body.innerHTML = `
    <div data-page-block="websql" data-page-block-id="sql-1" data-biu-plugin="websql">
      <textarea id="sql">select * from t</textarea>
      <input id="password" type="password" value="do-not-send">
      <div data-biu-sensitive><span id="secret">hidden token</span></div>
    </div>`
  const sql = document.querySelector<HTMLTextAreaElement>('#sql')!
  sql.focus()
  sql.setSelectionRange(0, 6)
  assert.equal(pluginTextSelectionPick('/pages/sql')?.selection, 'select')

  const password = document.querySelector<HTMLInputElement>('#password')!
  password.focus()
  password.setSelectionRange(0, password.value.length)
  assert.equal(pluginTextSelectionPick('/pages/sql'), null)

  password.blur()
  selectContents(document.querySelector('#secret')!)
  assert.equal(pluginTextSelectionPick('/pages/sql'), null)
})

test('selection crossing two plugin blocks is ignored', () => {
  document.body.innerHTML = `
    <div data-page-block="one" data-biu-plugin="one"><span id="a">alpha</span></div>
    <div data-page-block="two" data-biu-plugin="two"><span id="b">beta</span></div>`
  const a = document.querySelector('#a')!
  const b = document.querySelector('#b')!
  const range = document.createRange()
  range.setStart(a.firstChild!, 0)
  range.setEnd(b.firstChild!, 4)
  window.getSelection()?.addRange(range)
  assert.equal(pluginTextSelectionPick('/pages/x'), null)
})

test('ordinary DOM plugin outside a page block is supported', () => {
  document.body.innerHTML = `
    <main data-biu-plugin="standalone-tool" data-biu-id="tool-1">
      <section data-biu-location="查询结果"><span id="value">result text</span></section>
    </main>`
  selectContents(document.querySelector('#value')!)
  const ref = pluginTextSelectionPick('/tools/standalone')
  assert.equal(ref?.selection, 'result text')
  assert.equal(ref?.plugin, 'standalone-tool')
  assert.equal(ref?.block_id, 'tool-1')
  assert.equal(ref?.block_kind, undefined)
  assert.match(ref?.location ?? '', /查询结果/)
})

test('selection spanning a sensitive child is ignored', () => {
  document.body.innerHTML = `
    <div data-page-block="tool" data-biu-plugin="tool">
      <span id="start">before </span><span data-biu-sensitive>secret</span><span id="end"> after</span>
    </div>`
  const start = document.querySelector('#start')!
  const end = document.querySelector('#end')!
  const range = document.createRange()
  range.setStart(start.firstChild!, 0)
  range.setEnd(end.firstChild!, end.firstChild!.textContent!.length)
  window.getSelection()?.addRange(range)
  assert.equal(pluginTextSelectionPick('/pages/tool'), null)
})

test('central capture attaches once and stops later ordinary plugin listeners', () => {
  document.body.innerHTML = `
    <div data-page-block="cdb-meta" data-page-block-id="meta-1" data-biu-plugin="cdb-meta">
      <span id="value">主实例</span>
    </div>`
  selectContents(document.querySelector('#value')!)
  const attached: unknown[] = []
  let later = 0
  const dispose = installPluginTextSelection((refs) => attached.push(...refs), () => '/pages/meta')
  const onLater = () => { later += 1 }
  document.addEventListener('keydown', onLater, true)
  const event = new KeyboardEvent('keydown', {
    key: 'l',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(event)
  document.removeEventListener('keydown', onLater, true)
  dispose()
  assert.equal(attached.length, 1)
  assert.equal(later, 0)
  assert.equal(event.defaultPrevented, true)
})

test('an earlier special adapter can claim Ctrl+L with preventDefault', () => {
  document.body.innerHTML = `
    <div data-page-block="special" data-biu-plugin="special"><span id="value">special text</span></div>`
  selectContents(document.querySelector('#value')!)
  const claim = (event: KeyboardEvent) => event.preventDefault()
  document.addEventListener('keydown', claim, true)
  const attached: unknown[] = []
  const dispose = installPluginTextSelection((refs) => attached.push(...refs), () => '/pages/special')
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'l',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }))
  dispose()
  document.removeEventListener('keydown', claim, true)
  assert.equal(attached.length, 0)
})

test('hotkey only accepts plain Ctrl/Cmd+L', () => {
  const base = { key: 'l', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false }
  assert.equal(isPluginTextSelectionHotkey(base), true)
  assert.equal(isPluginTextSelectionHotkey({ ...base, ctrlKey: false, metaKey: true }), true)
  assert.equal(isPluginTextSelectionHotkey({ ...base, altKey: true }), false)
  assert.equal(isPluginTextSelectionHotkey({ ...base, repeat: true }), false)
})
