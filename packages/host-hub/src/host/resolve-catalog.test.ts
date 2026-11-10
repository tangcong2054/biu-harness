import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginCatalogLayer, resolveCatalog } from './resolve-catalog.ts'
import { findRepoRoot, pluginWebSpecifier } from '@biu/host-plugin-loader'

test('resolveCatalog loads only packages declared in cordis.plugins.json', async () => {
  const root = findRepoRoot()
  const raw = JSON.parse(await readFile(join(root, 'cordis.plugins.json'), 'utf8')) as {
    plugins: Array<{ id: string; package: string; web?: string }>
  }
  const catalog = await resolveCatalog()
  for (const item of raw.plugins) {
    const entry = catalog.find((row) => row.id === item.id)
    assert.ok(entry, `missing ${item.id}`)
    assert.equal(entry?.packageName, item.package)
    assert.equal(entry?.web, pluginWebSpecifier(item))
    assert.equal(typeof entry?.plugin, 'object')
    if (item.id.startsWith('core-')) {
      assert.equal(entry?.layer, 'core')
      assert.equal(entry?.togglable, false)
    }
  }
})

test('explicit capability layer wins over core- package prefix', () => {
  assert.equal(pluginCatalogLayer({ id: 'x', package: '@biu/core-ui-actions/host', layer: 'capability' }), 'capability')
  assert.equal(pluginCatalogLayer({ id: 'x', package: '@biu/core-ui-actions/host' }), 'core')
  assert.equal(pluginCatalogLayer({ id: 'core-x', package: '@biu/cap-x/host' }), 'core')
})

test('ui-actions agent channel is a togglable capability', async () => {
  const entry = (await resolveCatalog()).find((row) => row.id === 'ui-actions-agent')
  assert.ok(entry, 'ui-actions-agent missing from catalog')
  assert.equal(entry.layer, 'capability')
  assert.equal(entry.togglable, true)
})
