/** @vitest-environment jsdom */
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react'
import { PickChip, pickChipAttrs, pickFullText, textPickFromPlain, type PickRef } from '@biu/core-pick/web'
import { composerDocExtensions } from './composer-kit.ts'
import { insertPickChips, serializeComposer } from './composer-tiptap.ts'
import { plainToInlineContent } from './composer-pick-node.tsx'

const LONG = `第一行${'甲'.repeat(200)}\n\n第三行 end`

afterEach(() => cleanup())

function pastedChip(): PickRef {
  const ref = textPickFromPlain('/s/test', LONG)
  assert.ok(ref)
  return ref
}

test('pickFullText only returns original text for text picks', () => {
  assert.equal(pickFullText(pastedChip()), LONG.trim())
  assert.equal(pickFullText({ kind: 'page', selection: 'x' }), '')
})

test('copying a long paste chip puts the full original text on the clipboard', () => {
  const editor = new Editor({ extensions: composerDocExtensions() as never })
  try {
    editor.commands.insertContent('前缀 ')
    insertPickChips(editor, [pastedChip()])
    // getText 与 ClipboardTextSerializer 走同一套 renderText，决定复制出去的 text/plain
    const plain = editor.getText()
    assert.ok(plain.includes(LONG.trim()), 'copied text should contain full original')
    assert.ok(!plain.includes(`(${LONG.trim().length})`), 'should not copy the chip caption')
  } finally {
    editor.destroy()
  }
})

test('plainToInlineContent keeps line breaks and skips empty text nodes', () => {
  const content = plainToInlineContent('a\n\nb')
  assert.deepEqual(content, [
    { type: 'text', text: 'a' },
    { type: 'hardBreak' },
    { type: 'hardBreak' },
    { type: 'text', text: 'b' },
  ])
})

test('expanding a chip replaces it with editable original text', () => {
  const editor = new Editor({ extensions: composerDocExtensions() as never })
  try {
    insertPickChips(editor, [pastedChip()])
    let pos = -1
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'pickChip') pos = at
    })
    assert.ok(pos >= 0)
    const size = editor.state.doc.nodeAt(pos)!.nodeSize
    editor.chain().insertContentAt({ from: pos, to: pos + size }, plainToInlineContent(LONG.trim())).run()
    const packed = serializeComposer(editor)
    assert.equal(packed.refs.length, 0)
    assert.equal(packed.plain.trim(), LONG.trim())
  } finally {
    editor.destroy()
  }
})

test('text chip opens a preview with copy and optional expand', async () => {
  const ref = pastedChip()
  let expanded = 0
  const { getByTestId, queryByTestId } = render(
    <PickChip pick={ref} onExpand={() => { expanded += 1 }} />,
  )
  fireEvent.click(getByTestId('user-pick-chip'))
  await waitFor(() => assert.ok(queryByTestId('pick-text-preview')))
  assert.ok(getByTestId('pick-text-preview').textContent?.includes('第三行 end'))
  assert.equal(getByTestId('pick-text-preview').getAttribute('data-state'), 'open')
  assert.ok(getByTestId('pick-text-preview').closest('[data-radix-popper-content-wrapper]')?.getAttribute('style')?.includes('transform'))
  assert.ok(queryByTestId('pick-text-preview-copy'))
  fireEvent.click(getByTestId('pick-text-preview-expand'))
  assert.equal(expanded, 1)
})

test('mounted editor chip stays open after DOM mutations and expands through its button', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    editorProps: { handleScrollToSelection: () => true },
    extensions: composerDocExtensions() as never,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'pickChip', attrs: pickChipAttrs(pastedChip()) }] }] },
  })
  try {
    const chip = await waitFor(() => {
      const element = host.querySelector('[data-testid="user-pick-chip"]')
      assert.ok(element)
      return element
    })
    fireEvent.mouseDown(chip)
    fireEvent.mouseUp(chip)
    fireEvent.click(chip)
    const preview = await waitFor(() => {
      const element = document.querySelector('[data-testid="pick-text-preview"]')
      assert.equal(element?.getAttribute('data-state'), 'open')
      return element!
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(preview.isConnected)
    const expand = preview.querySelector('[data-testid="pick-text-preview-expand"]')
    assert.ok(expand)
    fireEvent.click(expand)
    await waitFor(() => assert.equal(serializeComposer(editor).refs.length, 0))
    assert.equal(serializeComposer(editor).plain.trim(), LONG.trim())
    assert.ok(editor.commands.undo())
    assert.equal(serializeComposer(editor).refs.length, 1)
  } finally {
    editor.destroy()
    host.remove()
  }
})

test('sent bubble chip has copy but no expand', async () => {
  const { getByTestId, queryByTestId } = render(<PickChip pick={pastedChip()} />)
  fireEvent.click(getByTestId('user-pick-chip'))
  await waitFor(() => assert.ok(queryByTestId('pick-text-preview')))
  assert.ok(queryByTestId('pick-text-preview-copy'))
  assert.equal(queryByTestId('pick-text-preview-expand'), null)
})
