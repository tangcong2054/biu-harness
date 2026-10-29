import { Node, mergeAttributes } from '@tiptap/core'
import { createRoot, type Root } from 'react-dom/client'
import { PickChip, chipLabel, pickFullText, pickRefFromAttrs, type PickRef } from '@biu/core-pick/web'

function refFromAttrs(attrs: Record<string, unknown>): PickRef {
  return pickRefFromAttrs(attrs) ?? { kind: '', id: '', label: '', route: '' }
}

/** 只有纯粘贴的文本芯片能换回原文；带源码行号/路径的选区展开会丢掉出处。 */
function expandable(ref: PickRef) {
  return Boolean(pickFullText(ref)) && !ref.path && ref.start_line == null
}

/** 原文按行切成 text + hardBreak；空行只留换行，ProseMirror 不接受空 text 节点。 */
export function plainToInlineContent(text: string) {
  const content: Array<Record<string, unknown>> = []
  text.split('\n').forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' })
    if (line) content.push({ type: 'text', text: line })
  })
  return content
}

function PickChipView({
  attrs,
  onRemove,
  onExpand,
}: {
  attrs: Record<string, unknown>
  onRemove?: () => void
  onExpand?: () => void
}) {
  const ref = refFromAttrs(attrs)
  return <PickChip pick={ref} onRemove={onRemove} onExpand={expandable(ref) ? onExpand : undefined} />
}

export const PickChipNode = Node.create({
  name: 'pickChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: '' },
      id: { default: '' },
      action: { default: null },
      label: { default: '' },
      route: { default: '' },
      path: { default: null },
      start_line: { default: null },
      end_line: { default: null },
      text: { default: null },
      selection: { default: null },
      insert: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-pick-chip]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-pick-chip': '',
        'data-testid': 'user-pick-chip',
        class: 'composer-tool-chip is-pick',
      }),
    ]
  },
  /** 复制到剪贴板的纯文本：文本芯片给完整原文，其他芯片给标签。 */
  renderText({ node }) {
    const ref = refFromAttrs(node.attrs as Record<string, unknown>)
    return pickFullText(ref) || chipLabel(ref)
  },
  addNodeView() {
    return ({ editor, getPos, node }) => {
      const dom = document.createElement('span')
      dom.className = 'composer-inline-chip'
      dom.setAttribute('data-pick-chip', '')
      let attrs = node.attrs as Record<string, unknown>
      let root: Root | null = createRoot(dom)
      let paintQueued = false
      const range = () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return null
        const size = editor.state.doc.nodeAt(pos)?.nodeSize ?? 1
        return { from: pos, to: pos + size }
      }
      const remove = () => {
        const at = range()
        if (!at) return
        editor.chain().focus().deleteRange(at).run()
      }
      const expand = () => {
        const at = range()
        const full = pickFullText(refFromAttrs(attrs))
        if (!at || !full) return
        editor.chain().focus().insertContentAt(at, plainToInlineContent(full)).run()
      }
      const paint = () => {
        paintQueued = false
        root?.render(<PickChipView attrs={attrs} onRemove={remove} onExpand={expand} />)
      }
      const schedulePaint = () => {
        if (paintQueued || !root) return
        paintQueued = true
        queueMicrotask(paint)
      }
      schedulePaint()
      return {
        dom,
        // 文本芯片的点击交给芯片自己（打开原文浮层），ProseMirror 不要拿去选中节点、挪焦点。
        stopEvent(event) {
          if (!/^(mouse|pointer|click|dblclick|touch)/.test(event.type)) return false
          const target = event.target
          if (!(target instanceof globalThis.Node) || !dom.contains(target)) return false
          return Boolean(pickFullText(refFromAttrs(attrs)))
        },
        update(updated) {
          if (updated.type.name !== 'pickChip') return false
          attrs = updated.attrs as Record<string, unknown>
          schedulePaint()
          return true
        },
        destroy() {
          const current = root
          root = null
          queueMicrotask(() => current?.unmount())
        },
      }
    }
  },
})
