import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import { Context } from 'cordis'
import { pageEditorExtensions } from './kit.ts'
import { PageEditorService, type PageBlockSpec } from './service.ts'
import { insertDroppedBlocks, isFileDropForBlocks, pickDropBlock } from './page-file-drop.ts'

function transfer(files: File[], dirs: string[] = []): DataTransfer {
  const items = [
    ...files.map((file) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }) })),
    ...dirs.map((name) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name }) })),
  ]
  return { files, items } as unknown as DataTransfer
}

const View = () => null

function spec(kind: string, match: (dt: DataTransfer) => boolean): PageBlockSpec {
  return {
    kind,
    plugin: kind,
    label: kind,
    assets: [],
    View,
    acceptDrop: { match, take: async () => [{ name: kind }] },
  }
}

test('only non-image or folder drops are offered to page blocks', () => {
  const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
  const ts = new File(['x'], 'a.ts', { type: 'text/plain' })
  assert.equal(isFileDropForBlocks(null), false)
  assert.equal(isFileDropForBlocks(transfer([])), false)
  assert.equal(isFileDropForBlocks(transfer([png])), false)
  assert.equal(isFileDropForBlocks(transfer([ts])), true)
  assert.equal(isFileDropForBlocks(transfer([png, ts])), true)
  assert.equal(isFileDropForBlocks(transfer([new File([], 'src')], ['src'])), true)
})

test('the first block whose match accepts wins and throwing matchers are skipped', () => {
  const dt = transfer([new File(['x'], 'a.ts')])
  const broken = spec('broken', () => {
    throw new Error('boom')
  })
  const no = spec('no', () => false)
  const yes = spec('yes', () => true)
  const later = spec('later', () => true)
  const plain: PageBlockSpec = { kind: 'plain', plugin: 'plain', label: 'plain', assets: [], View }
  assert.equal(pickDropBlock([plain, broken, no, yes, later], dt)?.kind, 'yes')
  assert.equal(pickDropBlock([plain, no], dt), undefined)
})

test('dropped items become page blocks carrying plugin, fresh ids and a title', () => {
  const editor = new Editor({
    extensions: pageEditorExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  const block = spec('local-file', () => true)
  assert.equal(insertDroppedBlocks(editor, block, [], 0), false)
  assert.equal(insertDroppedBlocks(editor, block, [{ name: 'a.ts', title: 'a.ts' }, { name: 'b.md' }], 0), true)
  const blocks = (editor.getJSON().content ?? []).filter((node) => node.type === 'pageBlock')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.attrs?.kind, 'local-file')
  assert.equal(blocks[0]?.attrs?.plugin, 'local-file')
  assert.equal((blocks[0]?.attrs?.data as { title?: string }).title, 'a.ts')
  assert.equal((blocks[1]?.attrs?.data as { title?: string }).title, 'local-file')
  assert.notEqual(blocks[0]?.attrs?.id, blocks[1]?.attrs?.id)
  editor.destroy()
})

test('editor drop handler routes file drops to the registered block', async () => {
  const ctx = new Context()
  new PageEditorService(ctx)
  let taken = 0
  const fiber = ctx.plugin({
    name: 'local-file',
    inject: ['pageEditor'],
    apply(inner) {
      inner.pageEditor.registerBlock({
        kind: 'local-file',
        plugin: 'local-file',
        label: '本地文件',
        assets: [],
        View,
        acceptDrop: {
          match: () => true,
          take: async (dt) => {
            taken += 1
            return Array.from(dt.files).map((file) => ({ name: file.name, title: file.name }))
          },
        },
      })
    },
  })
  await fiber
  const editor = new Editor({
    extensions: pageEditorExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  let prevented = false
  const event = {
    dataTransfer: transfer([new File(['x'], 'notes.txt', { type: 'text/plain' })]),
    clientX: 0,
    clientY: 0,
    preventDefault: () => {
      prevented = true
    },
  } as unknown as DragEvent
  const handled = editor.view.someProp('handleDrop', (fn) => fn(editor.view, event, editor.state.doc.slice(0, 0), false))
  assert.equal(handled, true)
  assert.equal(prevented, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(taken, 1)
  const blocks = (editor.getJSON().content ?? []).filter((node) => node.type === 'pageBlock')
  assert.equal(blocks.length, 1)
  assert.equal((blocks[0]?.attrs?.data as { name?: string }).name, 'notes.txt')
  editor.destroy()
  await fiber.dispose()
})
