/** @vitest-environment jsdom */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import { Context } from 'cordis'
import { PickService, pickKey, type PickRef } from '@biu/core-pick/web'
import { composerDocExtensions } from './composer-kit.ts'
import { bindComposerSession, collectPickKeys, insertPickChips, serializeComposer } from './composer-tiptap.ts'

const page: PickRef = { kind: 'page', id: 'p1', label: '页面甲', route: '/pages' }

function setup() {
  const pick = new PickService(new Context())
  const editor = new Editor({ extensions: composerDocExtensions() as never })
  const drafts: Record<string, string> = {}
  // 模拟输入栏：refs → 编辑器芯片，编辑器内容 → 当前会话草稿
  const sync = (sessionId: string) => {
    const have = collectPickKeys(editor)
    insertPickChips(editor, pick.refs.filter((ref) => !have.has(pickKey(ref))))
    const text = serializeComposer(editor).text
    if (text) drafts[sessionId] = text
    else delete drafts[sessionId]
  }
  const open = (sessionId: string) => {
    bindComposerSession(editor, pick, sessionId, drafts[sessionId])
    sync(sessionId)
  }
  return { pick, editor, drafts, open, sync }
}

test('a picked ref stays in its own session and does not leak into others', () => {
  const { pick, editor, drafts, open, sync } = setup()
  try {
    open('a')
    pick.attach([page])
    sync('a')
    assert.equal(serializeComposer(editor).refs.length, 1)
    assert.match(drafts.a ?? '', /"id":"p1"/)

    // 切到 B：B 的输入框和草稿都不能带上 A 的引用
    open('b')
    assert.equal(serializeComposer(editor).refs.length, 0)
    assert.equal(pick.refs.length, 0)
    assert.equal(drafts.b, undefined)

    // 再切到 C 也一样
    open('c')
    assert.equal(serializeComposer(editor).refs.length, 0)
    assert.equal(drafts.c, undefined)

    // 切回 A：靠 A 自己的草稿恢复
    open('a')
    assert.deepEqual(serializeComposer(editor).refs.map((ref) => ref.id), ['p1'])
    assert.deepEqual(pick.refs.map((ref) => ref.id), ['p1'])
  } finally {
    editor.destroy()
  }
})

test('remounting the composer in the same session keeps a just-attached ref', () => {
  const { pick, editor, open } = setup()
  try {
    open('a')
    // 在页面上按 Ctrl/Cmd+L：引用先进 pick，草稿里还没有（悬浮窗输入栏随后才挂载）
    pick.attach([page])
    open('a')
    assert.deepEqual(serializeComposer(editor).refs.map((ref) => ref.id), ['p1'])
  } finally {
    editor.destroy()
  }
})

test('a ref attached before any session exists is kept by the first session', () => {
  const { pick, editor, open } = setup()
  try {
    pick.attach([page])
    open('first')
    assert.deepEqual(serializeComposer(editor).refs.map((ref) => ref.id), ['p1'])
  } finally {
    editor.destroy()
  }
})

test('switching sessions while picking does not carry refs either', () => {
  const { pick, editor, open, sync } = setup()
  try {
    open('a')
    pick.enter()
    pick.add(page)
    sync('a')
    open('b')
    assert.equal(pick.refs.length, 0)
    assert.equal(serializeComposer(editor).refs.length, 0)
    // 同一会话重挂时，选取中的引用仍保留
    pick.add(page)
    open('b')
    assert.deepEqual(pick.refs.map((ref) => ref.id), ['p1'])
  } finally {
    pick.exit()
    editor.destroy()
  }
})
