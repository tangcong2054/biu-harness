import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const root = resolve(import.meta.dirname, '../../../../.plugin-dev')
const explicit = new Set([
  'api-playground',
  'arena-rogue',
  'cdb-errorlog',
  'cdb-logs',
  'cdb-processlist',
  'cdb-slowlog',
  'dbbrain-limit',
  'option-matrix',
  'page-algorithm',
  'page-browser',
  'page-code-runner',
  'page-html-blocks',
  'page-regression',
  'page-toc',
  'plugin-doctor',
  'websql',
])
const domOnly = new Set(['audit-findings', 'cost-reconcile', 'edu-classboard', 'med-ruleset', 'page-video'])
const complex = new Set(['page-excalidraw', 'page-terminal'])
const sourceMissing = new Set<string>()

test('every sandbox plugin has an explicit UI Action coverage classification', () => {
  const plugins = readdirSync(root)
    .filter((id) => existsSync(resolve(root, id, 'manifest.json')))
    .sort()
  const classified = [...explicit, ...domOnly, ...complex, ...sourceMissing].sort()
  assert.deepEqual(classified, plugins)
})

test('plugins classified explicit inject and register uiActions', () => {
  for (const id of explicit) {
    const sourceFile = existsSync(resolve(root, id, 'web/index.tsx'))
      ? 'web/index.tsx'
      : existsSync(resolve(root, id, 'web/index.ts'))
        ? 'web/index.ts'
        : existsSync(resolve(root, id, 'web.tsx'))
          ? 'web.tsx'
          : 'web.js'
    const source = readFileSync(resolve(root, id, sourceFile), 'utf8')
    assert.match(source, /(?:inject|INJ)\s*=\s*\[[^\]]*['"]uiActions['"]/, `${id} 没有 inject uiActions`)
    assert.match(source, /(?:uiActions|UIA)\?*\.register|(?:uiActions|UIA)\.register/, `${id} 没有注册语义 Action`)
  }
})

test('missing-source plugins are not silently treated as implemented', () => {
  for (const id of sourceMissing) {
    assert.equal(existsSync(resolve(root, id, 'web.tsx')), false, `${id} 已恢复源码，应更新覆盖分类`)
  }
})
