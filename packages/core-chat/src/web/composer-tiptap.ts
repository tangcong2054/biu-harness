import type { Editor } from '@tiptap/react'
import { mentionPickFromAttrs } from '@biu/core-editor/mention'
import { formatPick, pickChipAttrs, pickKey, pickRefFromAttrs, splitPickStream, type PickRef, type PickService } from '@biu/core-pick/web'

function attrsToRef(attrs: Record<string, unknown>): PickRef | null {
  return pickRefFromAttrs(attrs)
}

export function serializeComposer(editor: Editor | null): { text: string; refs: PickRef[]; plain: string } {
  if (!editor) return { text: '', refs: [], plain: '' }
  let text = ''
  let plain = ''
  const refs: PickRef[] = []
  let block = 0
  editor.state.doc.forEach((node) => {
    if (block++ > 0) {
      text += '\n'
      plain += '\n'
    }
    node.forEach((child) => {
      if (child.isText) {
        const value = child.text ?? ''
        text += value
        plain += value
        return
      }
      if (child.type.name === 'hardBreak') {
        text += '\n'
        plain += '\n'
        return
      }
      if (child.type.name === 'pickChip' || child.type.name === 'mention') {
        const ref =
          child.type.name === 'mention' ? mentionPickFromAttrs(child.attrs) : attrsToRef(child.attrs)
        if (!ref) return
        refs.push(ref)
        text += formatPick(ref)
      }
    })
  })
  return { text: text.replace(/\s+$/g, '').trim(), refs, plain }
}

export function jsonFromDraft(raw: string) {
  const parts = splitPickStream(raw)
  const content: Array<Record<string, unknown>> = []
  for (const part of parts) {
    if (part.type === 'text') {
      const lines = part.value.split('\n')
      lines.forEach((line, index) => {
        if (index > 0) content.push({ type: 'hardBreak' })
        if (line) content.push({ type: 'text', text: line })
      })
    } else {
      const ref = part.ref
      content.push({
        type: 'pickChip',
        attrs: pickChipAttrs(ref),
      })
    }
  }
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        ...(content.length ? { content } : {}),
      },
    ],
  }
}

export function collectPickKeys(editor: Editor | null) {
  const keys = new Set<string>()
  if (!editor) return keys
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'pickChip' && node.type.name !== 'mention') return
    const ref = node.type.name === 'mention' ? mentionPickFromAttrs(node.attrs) : attrsToRef(node.attrs)
    if (ref) keys.add(pickKey(ref))
  })
  return keys
}

function chipContent(ref: PickRef) {
  return {
    type: 'pickChip',
    attrs: pickChipAttrs(ref),
  }
}

export function insertPickChips(editor: Editor, refs: PickRef[]) {
  if (!refs.length || editor.isDestroyed) return
  editor
    .chain()
    .focus()
    .insertContent(refs.map(chipContent))
    .run()
}

type SessionBoundPick = Pick<PickService, 'refs' | 'picking' | 'clear' | 'addMany' | 'claimSession'>

/**
 * 输入栏绑定到某个会话：切换会话、重挂输入栏、开关悬浮窗都会走这里。
 * 选中的引用（refs）全局只有一份，草稿按会话保存；这里只在同一会话（或尚未归属）时保留现有 refs，
 * 换了会话就清掉，只按新会话自己的草稿恢复，避免选中的内容串到所有会话、并被写进别的会话的草稿。
 */
export function bindComposerSession(
  editor: Editor,
  pick: SessionBoundPick | undefined,
  sessionId: string,
  draft: string | undefined,
) {
  const keep = pick?.refs.slice() ?? []
  const owned = pick?.claimSession(sessionId) ?? false
  // 选取模式中、同一会话内不清，避免重挂输入栏把正在选的引用清掉。
  if (!owned || !pick?.picking) pick?.clear()
  if (typeof draft === 'string' && draft) {
    editor.commands.setContent(jsonFromDraft(draft))
    const { refs } = serializeComposer(editor)
    if (refs.length) pick?.addMany(refs)
  } else {
    editor.commands.clearContent()
  }
  if (owned && keep.length && !pick?.picking) pick?.addMany(keep)
}

export function editorCaretPlain(editor: Editor | null): { value: string; cursor: number } {
  if (!editor) return { value: '', cursor: 0 }
  const doc = editor.state.doc
  const from = editor.state.selection.from
  return {
    value: doc.textBetween(0, doc.content.size, '\n', ''),
    cursor: doc.textBetween(0, from, '\n', '').length,
  }
}

export function deletePlainRange(editor: Editor, start: number, end: number) {
  const from = posAtPlainOffset(editor, start)
  const to = posAtPlainOffset(editor, end)
  if (to > from) editor.chain().focus().deleteRange({ from, to }).run()
}

function posAtPlainOffset(editor: Editor, offset: number) {
  let seen = 0
  let found = 1
  editor.state.doc.descendants((node, pos) => {
    if (node.isText) {
      const len = node.text?.length ?? 0
      if (seen + len >= offset) {
        found = pos + (offset - seen)
        return false
      }
      seen += len
      return false
    }
    if (node.type.name === 'hardBreak') {
      if (seen + 1 >= offset) {
        found = pos + 1
        return false
      }
      seen += 1
      return false
    }
    return true
  })
  return found
}
