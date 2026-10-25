import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { createPageBlockId } from './page-block.ts'
import { getPageEditor, type PageBlockSpec } from './service.ts'

const pageFileDropKey = new PluginKey('page-file-drop')

function isImageFile(file: File) {
  return file.type.startsWith('image/')
}

/** 拖入里是否带文件夹（Chrome/Firefox 都有 webkitGetAsEntry）。 */
function hasDirectory(dataTransfer: DataTransfer) {
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null })
      .webkitGetAsEntry?.()
    if (entry?.isDirectory) return true
  }
  return false
}

/** 纯图片（且不含文件夹）继续交给内置图片上传；其余文件拖入才问页面块。 */
export function isFileDropForBlocks(dataTransfer: DataTransfer | null | undefined): dataTransfer is DataTransfer {
  if (!dataTransfer) return false
  const files = Array.from(dataTransfer.files ?? [])
  if (!files.length) return false
  if (hasDirectory(dataTransfer)) return true
  return files.some((file) => !isImageFile(file))
}

/** 按登记顺序找第一个愿意接收的块。match 抛错视为不接收。 */
export function pickDropBlock(blocks: PageBlockSpec[], dataTransfer: DataTransfer) {
  for (const block of blocks) {
    if (!block.acceptDrop) continue
    try {
      if (block.acceptDrop.match(dataTransfer)) return block
    } catch {
      // 某个插件判断出错不应拦住其它插件。
    }
  }
  return undefined
}

/** 落点在文字中间时插到所在顶层块之后，不把段落劈开。 */
export function dropInsertPos(view: EditorView, coords: { left: number; top: number }) {
  const size = view.state.doc.content.size
  let hit: { pos: number } | null = null
  try {
    hit = view.posAtCoords(coords)
  } catch {
    hit = null
  }
  if (!hit) return size
  const $pos = view.state.doc.resolve(Math.min(hit.pos, size))
  if ($pos.depth === 0) return $pos.pos
  return $pos.after(1)
}

export function insertDroppedBlocks(
  editor: Editor,
  block: PageBlockSpec,
  items: Array<Record<string, unknown>>,
  pos: number,
) {
  if (!items.length || editor.isDestroyed) return false
  const at = Math.min(Math.max(0, pos), editor.state.doc.content.size)
  const nodes = items.map((data) => ({
    type: 'pageBlock',
    attrs: {
      kind: block.kind,
      plugin: block.plugin,
      id: createPageBlockId(),
      data: { ...data, title: String(data.title ?? '').trim() || block.label || block.kind },
    },
  }))
  return editor.chain().insertContentAt(at, nodes).run()
}

/**
 * 页面块的通用拖入入口：插件在 registerBlock 时声明 acceptDrop，
 * 把文件 / 文件夹拖进页面就在落点插入对应块。块内部拖动（view.dragging）不经过这里。
 */
export const pageFileDrop = Extension.create({
  name: 'pageFileDrop',
  // 要排在 pageImage 之前：混着图片和其它文件时先给页面块一次机会。
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: pageFileDropKey,
        props: {
          handleDrop(view, event) {
            if (!view.editable || view.dragging) return false
            const dataTransfer = event.dataTransfer
            if (!isFileDropForBlocks(dataTransfer)) return false
            const blocks = getPageEditor()?.blocks() ?? []
            const block = pickDropBlock(blocks, dataTransfer)
            if (!block?.acceptDrop) return false
            event.preventDefault()
            const pos = dropInsertPos(view, { left: event.clientX, top: event.clientY })
            let pending: Promise<Array<Record<string, unknown>>>
            try {
              // 同步调用：DataTransfer 过了这个事件就读不到了。
              pending = block.acceptDrop.take(dataTransfer)
            } catch (error) {
              console.warn(`[${block.plugin}] 页面块 "${block.kind}" 接收拖入失败`, error)
              return true
            }
            void pending
              .then((items) => insertDroppedBlocks(editor, block, Array.isArray(items) ? items : [], pos))
              .catch((error) => console.warn(`[${block.plugin}] 页面块 "${block.kind}" 接收拖入失败`, error))
            return true
          },
        },
      }),
    ]
  },
})
