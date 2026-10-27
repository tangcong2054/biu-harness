import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import {
  collectClipboardImages,
  editorResourcePath,
  imageUploadFailureText,
  insertClipboardImages,
  onImageUploadFailure,
  setEditorResourcePath,
  stripPastedDataImages,
  uploadPageImage,
  type ImageUploadFailure,
} from './page-image.ts'
import { pageEditorExtensions } from './kit.ts'

test('uploadPageImage PUTs to hash storage and returns the asset href', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const prev = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: String(init?.method ?? 'GET') })
    return new Response(JSON.stringify({ name: 'ab'.repeat(32) + '.png', href: '/api/db/file/' + 'ab'.repeat(32) + '.png' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const href = await uploadPageImage(new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' }))
    assert.match(calls[0]?.url ?? '', /\/api\/db\/file\/hash\//)
    assert.equal(calls[0]?.method, 'PUT')
    assert.match(href, /^\/api\/db\/file\/[a-f0-9]+\.png$/i)
  } finally {
    globalThis.fetch = prev
  }
})

test('insertClipboardImages writes an asset href, not a data URL', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ href: '/api/db/file/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.png' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
  const editor = new Editor({
    extensions: pageEditorExtensions(),
    content: 'hello',
    contentType: 'markdown',
  })
  try {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paste.png', { type: 'image/png' })
    await insertClipboardImages(editor, [file], editor.state.selection.from)
    const md = editor.getMarkdown()
    assert.match(md, /\/api\/db\/file\/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\.png/)
    assert.doesNotMatch(md, /data:image/)
  } finally {
    editor.destroy()
    globalThis.fetch = prev
  }
})

test('uploads carry the record path so the host can authorize resource:update', async () => {
  const urls: string[] = []
  const prev = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ href: '/api/db/file/' + 'cd'.repeat(32) + '.png' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const editor = new Editor({ extensions: pageEditorExtensions(), content: 'hi', contentType: 'markdown' })
  try {
    const file = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' })
    await uploadPageImage(file, '/pages/p1')
    assert.equal(new URL(urls[0]!, 'http://x').searchParams.get('path'), '/pages/p1')
    setEditorResourcePath(editor, '/pages/p2')
    assert.equal(editorResourcePath(editor), '/pages/p2')
    await insertClipboardImages(editor, [file], editor.state.selection.from)
    assert.equal(new URL(urls[1]!, 'http://x').searchParams.get('path'), '/pages/p2')
  } finally {
    editor.destroy()
    globalThis.fetch = prev
  }
})

test('collectClipboardImages keeps image files and stripPastedDataImages drops inline data URLs', () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
  const clipboard = {
    files: [file],
    items: [] as DataTransferItem[],
  } as unknown as DataTransfer
  assert.equal(collectClipboardImages(clipboard).length, 1)
  assert.equal(stripPastedDataImages('<p>x</p><img src="data:image/png;base64,QQ==">'), '<p>x</p>')
})

test('多图并发上传，按原顺序插入；失败的会通知编辑器而不是静默丢掉', async () => {
  const prev = globalThis.fetch
  let inFlight = 0
  let peak = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input))
    inFlight += 1
    peak = Math.max(peak, inFlight)
    // 让第一张最慢返回，验证插入顺序不受完成顺序影响。
    await new Promise((resolve) => setTimeout(resolve, url.includes('one.png') ? 30 : 5))
    inFlight -= 1
    if (url.includes('bad.png')) {
      return new Response(JSON.stringify({ error: 'too large' }), { status: 413, headers: { 'content-type': 'application/json' } })
    }
    const tag = url.includes('one.png') ? 'aa' : url.includes('two.png') ? 'bb' : 'cc'
    return new Response(JSON.stringify({ href: `/api/db/file/${tag.repeat(32)}.png` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  // 光标落在非空段落内部：块级图片会劈开段落，逐张 at+1 会导致顺序反转，这里必须仍保持原顺序。
  const editor = new Editor({ extensions: pageEditorExtensions(), content: '<p>hello</p>' })
  const reported: ImageUploadFailure[][] = []
  onImageUploadFailure(editor, (failures) => reported.push(failures))
  try {
    const png = (name: string) => new File([new Uint8Array([0x89, 0x50, name.length])], name, { type: 'image/png' })
    const result = await insertClipboardImages(editor, [png('one.png'), png('bad.png'), png('two.png'), png('three.png')], 6)
    assert.equal(result.inserted, 3)
    assert.equal(peak > 1, true)
    const html = editor.getHTML()
    const order = ['aa', 'bb', 'cc'].map((tag) => html.indexOf(`${tag.repeat(32)}.png`))
    assert.equal(order.every((index) => index >= 0), true)
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.deepEqual(reported, [[{ name: 'bad.png', error: 'too large' }]])
    assert.match(imageUploadFailureText(reported[0]!), /bad\.png.*too large/)
  } finally {
    onImageUploadFailure(editor, undefined)
    editor.destroy()
    globalThis.fetch = prev
  }
})

test('imageUploadFailureText 汇总多张失败', () => {
  assert.equal(imageUploadFailureText([]), '')
  assert.match(
    imageUploadFailureText([{ name: 'a.png', error: 'x' }, { name: 'b.png', error: 'y' }]),
    /^2 张图片上传失败/,
  )
})

test('并发上限为 4', async () => {
  const prev = globalThis.fetch
  let inFlight = 0
  let peak = 0
  globalThis.fetch = (async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
    return new Response(JSON.stringify({ href: `/api/db/file/${'ab'.repeat(32)}.png` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const editor = new Editor({ extensions: pageEditorExtensions(), content: '' })
  try {
    const files = Array.from({ length: 10 }, (_, index) =>
      new File([new Uint8Array([0x89, 0x50, index])], `f${index}.png`, { type: 'image/png' }))
    await insertClipboardImages(editor, files, 0)
    assert.equal(peak, 4)
  } finally {
    editor.destroy()
    globalThis.fetch = prev
  }
})

test('落点放不下图片时按失败提示，不报成功', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ href: `/api/db/file/${'cd'.repeat(32)}.png` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  // 代码块内部容不下块级图片，ProseMirror 会静默 no-op。
  const editor = new Editor({ extensions: pageEditorExtensions(), content: '<pre><code>let x = 1</code></pre>' })
  const reported: ImageUploadFailure[][] = []
  onImageUploadFailure(editor, (failures) => reported.push(failures))
  try {
    const before = editor.getHTML()
    const png = new File([new Uint8Array([0x89, 0x50, 1])], 'a.png', { type: 'image/png' })
    const result = await insertClipboardImages(editor, [png], 5)
    if (editor.getHTML() === before) {
      assert.equal(result.inserted, 0)
      assert.deepEqual(result.failures.map((item) => item.name), ['a.png'])
      assert.match(result.failures[0]!.error, /无法插入/)
      assert.equal(reported.length, 1)
    } else {
      // 该版本允许在代码块处插入：至少不能谎报数量。
      assert.equal(result.inserted, 1)
      assert.deepEqual(result.failures, [])
    }
  } finally {
    onImageUploadFailure(editor, undefined)
    editor.destroy()
    globalThis.fetch = prev
  }
})

test('编辑器已销毁时失败不会被静默丢弃', async () => {
  const prev = globalThis.fetch
  const warned: unknown[][] = []
  const prevWarn = console.warn
  console.warn = (...args: unknown[]) => warned.push(args)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const editor = new Editor({ extensions: pageEditorExtensions(), content: '' })
  try {
    const png = new File([new Uint8Array([0x89, 0x50, 1])], 'a.png', { type: 'image/png' })
    const pending = insertClipboardImages(editor, [png], 0)
    editor.destroy()
    const result = await pending
    assert.equal(result.inserted, 0)
    assert.deepEqual(result.failures.map((item) => item.name), ['a.png'])
    assert.equal(warned.length, 1)
  } finally {
    console.warn = prevWarn
    globalThis.fetch = prev
  }
})
