import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'web/index.tsx'), 'utf8')

test('helpers container is positioned so it cannot push text rows down', () => {
  // .xterm-helpers 是 .xterm-screen 的第一个子节点；不定位就会把文字行整体下推，
  // 底部被裁、选区层和文字错开（选中一处出现两块高亮）。
  assert.match(source, /\.pt-pane \.xterm \.xterm-helpers \{ position: absolute; top: 0; z-index: 5; \}/)
  const textarea = source.slice(source.indexOf('.pt-pane .xterm .xterm-helper-textarea {'))
  const rule = textarea.slice(0, textarea.indexOf('}'))
  assert.match(rule, /position: absolute/)
  // 输入法组合时 xterm 用行内样式移动 textarea，left/top 不能 !important。
  assert.doesNotMatch(rule, /!important/)
})

test('text layer sits above the DOM selection layer', () => {
  assert.match(source, /\.pt-pane \.xterm-screen \.xterm-rows \{ position: relative; z-index: 2; \}/)
})

test('no per-scroll selection re-apply on the output path', () => {
  assert.doesNotMatch(source, /realignSelection/)
  assert.match(source, /scrollSub = term\.onScroll\(syncPickSelection\)/)
})

test('Ctrl/Cmd+L with a terminal selection sends text plus terminal line range', () => {
  assert.match(source, /term\.attachCustomKeyEventHandler\(/)
  assert.match(source, /if \(!term\?\.hasSelection\(\) \|\| typeof PICK\?\.attach !== 'function'\) return true/)
  assert.match(source, /kind: 'terminal'/)
  assert.match(source, /start_line: startLine,\s+end_line: endLine,\s+selection: clipped,/)
  // 拦住冒泡，避免外层页面编辑器再发一次整块。
  assert.match(source, /event\.stopPropagation\(\)\s+const startLine/)
  assert.match(source, /ctx\.inject\?\.\(\['pick'\]/)
})

test('height handle previews locally and writes block data once on release', () => {
  assert.match(source, /function HeightHandle\(/)
  assert.match(source, /onPreview\(latest\)/)
  assert.match(source, /if \(latest !== startH\) commitRef\.current\(latest\)/)
  assert.match(source, /onCommit=\{\(next\) => update\(\{ height: next \}\)\}/)
  assert.match(source, /\{writable && !fillMode \? \(\s+<HeightHandle/)
})
