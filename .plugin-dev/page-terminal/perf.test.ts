import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'web/index.tsx'), 'utf8')

test('history capture of raw output is capped instead of concatenating everything', () => {
  assert.match(source, /const HISTORY_CAPTURE_CHARS = 16_000/)
  assert.doesNotMatch(source, /outBuffer \+= chunk\n/)
  assert.match(source, /if \(outBuffer\.length < HISTORY_CAPTURE_CHARS\) outBuffer \+= chunk\.slice\(/)
})

test('pick-layer attributes are only computed in pick mode and at most once per frame', () => {
  const sync = source.slice(source.indexOf('const syncPickSelection = () => {'))
  assert.match(sync.slice(0, 300), /if \(pickFrame \|\| !pickModeOn\(\)\) return/)
  assert.match(sync.slice(0, 300), /requestAnimationFrame/)
  // 进入选取模式时立即补一次。
  assert.match(source, /attributeFilter: \['class'\]/)
})

test('DOM observer ignores xterm row and selection repaints', () => {
  assert.match(source, /closest\('\.xterm-rows, \.xterm-selection, \.xterm-decoration-container'\)/)
  const observer = source.slice(source.indexOf('buryObs = new MutationObserver'), source.indexOf('buryObs.observe('))
  assert.doesNotMatch(observer, /syncPickSelection/)
})

test('scroll rail sync is coalesced to one per animation frame', () => {
  assert.match(source, /term\.onScroll\(scheduleSync\)/)
  assert.match(source, /term\.onRender\(scheduleSync\)/)
  assert.match(source, /if \(syncFrame\) return/)
})
