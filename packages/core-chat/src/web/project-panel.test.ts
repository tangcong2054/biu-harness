import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, './project-panel.tsx'), 'utf8')

test('managed online workspace cannot open the host directory picker', () => {
  assert.match(source, /project\?\.managed === true/)
  assert.match(source, /disabled=\{busy \|\| managed\}/)
  assert.match(source, /云端工作区（服务器）/)
})
