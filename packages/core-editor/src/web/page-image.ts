import type { Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function fileFingerprint(file: File) {
  return `${file.type}\0${file.size}`
}

export function uniqueImageFiles(files: Array<File | null | undefined>): File[] {
  const seen = new Set<string>()
  const out: File[] = []
  for (const file of files) {
    if (!file || !IMAGE_MIMES.has(file.type)) continue
    const key = fileFingerprint(file)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(file)
  }
  return out
}

export function collectClipboardImages(clipboard: DataTransfer | null | undefined): File[] {
  if (!clipboard) return []
  const fromFiles = uniqueImageFiles(Array.from(clipboard.files ?? []))
  if (fromFiles.length) return fromFiles
  return uniqueImageFiles(Array.from(clipboard.items ?? []).map((item) => (item.kind === 'file' ? item.getAsFile() : null)))
}

function safeAssetFileName(name: string) {
  const base = name.replace(/^.*[/\\]/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-')
  return base || `image-${Date.now()}.png`
}

/** 上传接口要按记录鉴权（resource:update），编辑器要记住自己正在编辑哪条记录。 */
const editorResourcePaths = new WeakMap<Editor, string>()

export function setEditorResourcePath(editor: Editor, path: string | undefined) {
  if (path) editorResourcePaths.set(editor, path)
  else editorResourcePaths.delete(editor)
}

export function editorResourcePath(editor: Editor) {
  return editorResourcePaths.get(editor)
}

export async function uploadPageImage(file: File, resourcePath?: string) {
  const hint = `${Date.now()}-${safeAssetFileName(file.name)}`
  const query = resourcePath ? `?path=${encodeURIComponent(resourcePath)}` : ''
  const res = await fetch(`/api/db/file/hash/${encodeURIComponent(hint)}${query}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; href?: string; name?: string }
  if (!res.ok) throw new Error(body.error || res.statusText)
  const name = body.name || hint
  return body.href || `/api/db/file/${encodeURIComponent(name)}`
}

/**
 * 一次事务插入多张图：顺序由 fragment 保证。
 * 不能逐张 insertContentAt(at++)：图片是块级节点，插在文本块内部会劈开段落，
 * 实际落点比 at 大 1，手算 +1 会让下一张插到上一张之前（顺序反转）。
 * insertContentAt 解析成功即返回 true，放不下时 ProseMirror 静默 no-op，
 * 所以用文档实际变化判断是否真的插进去了。
 */
function insertImages(editor: Editor, srcList: string[], pos: number) {
  if (editor.isDestroyed || !srcList.length) return false
  const at = Math.min(Math.max(0, pos), editor.state.doc.content.size)
  const before = editor.state.doc.content.size
  editor
    .chain()
    .focus()
    .insertContentAt(at, srcList.map((src) => ({ type: 'image', attrs: { src, alt: '' } })))
    .run()
  return editor.state.doc.content.size > before
}

export type ImageUploadFailure = { name: string; error: string }

/** 上传失败的提示由编辑器组件订阅；这里只负责报告，不碰 UI。 */
const uploadFailureHandlers = new WeakMap<Editor, (failures: ImageUploadFailure[]) => void>()

export function onImageUploadFailure(editor: Editor, handler: ((failures: ImageUploadFailure[]) => void) | undefined) {
  if (handler) uploadFailureHandlers.set(editor, handler)
  else uploadFailureHandlers.delete(editor)
}

const UPLOAD_CONCURRENCY = 4

function reportFailures(editor: Editor, failures: ImageUploadFailure[]) {
  if (!failures.length) return
  const handler = uploadFailureHandlers.get(editor)
  if (handler) handler(failures)
  else console.warn('[page-image] 图片上传失败', failures)
}

/** 并发上传（最多 4 张同时），按原顺序一次插入成功的图片；失败的汇总后通知编辑器。 */
export async function insertClipboardImages(editor: Editor, files: File[], pos: number) {
  const resourcePath = editorResourcePath(editor)
  const results: Array<{ src: string } | { error: string }> = new Array(files.length)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      try {
        results[index] = { src: await uploadPageImage(files[index]!, resourcePath) }
      } catch (error) {
        results[index] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))
  const failures: ImageUploadFailure[] = []
  const uploaded: string[] = []
  results.forEach((result, index) => {
    const name = files[index]?.name || `图片 ${index + 1}`
    if ('src' in result) uploaded.push(result.src)
    else failures.push({ name, error: result.error || '上传失败' })
  })
  if (editor.isDestroyed) {
    // 编辑器已销毁：插不进去了，但失败仍要留痕，避免彻底静默。
    if (failures.length) console.warn('[page-image] 编辑器已关闭，图片上传失败', failures)
    return { inserted: 0, failures }
  }
  const ok = insertImages(editor, uploaded, pos)
  if (!ok && uploaded.length) {
    // 落点放不下块级图片（代码块、表格单元格等）：上传成功但正文没变，仍按失败提示。
    results.forEach((result, index) => {
      if ('src' in result) failures.push({ name: files[index]?.name || `图片 ${index + 1}`, error: '当前位置无法插入图片' })
    })
  }
  reportFailures(editor, failures)
  return { inserted: ok ? uploaded.length : 0, failures }
}

export function imageUploadFailureText(failures: ImageUploadFailure[]) {
  if (!failures.length) return ''
  const first = failures[0]!
  const reason = first.error ? `：${first.error}` : ''
  return failures.length === 1
    ? `图片「${first.name}」上传失败${reason}`
    : `${failures.length} 张图片上传失败（如「${first.name}」${reason}）`
}

export function stripPastedDataImages(html: string) {
  return html.replace(/<img\b[^>]*\bsrc=["']data:image[^"']*["'][^>]*>/gi, '')
}

const pageImagePasteKey = new PluginKey('page-image-paste')

export const pageImage = Image.extend({
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: pageImagePasteKey,
        props: {
          transformPastedHTML(html) {
            return stripPastedDataImages(html)
          },
          handlePaste(_view, event) {
            const files = collectClipboardImages(event.clipboardData)
            if (!files.length) return false
            event.preventDefault()
            const pos = editor.state.selection.from
            void insertClipboardImages(editor, files, pos)
            return true
          },
          handleDrop(view, event) {
            const files = uniqueImageFiles(Array.from(event.dataTransfer?.files ?? []))
            if (!files.length) return false
            event.preventDefault()
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            const pos = coords?.pos ?? editor.state.selection.from
            void insertClipboardImages(editor, files, pos)
            return true
          },
        },
      }),
    ]
  },
}).configure({ inline: false, allowBase64: false })
