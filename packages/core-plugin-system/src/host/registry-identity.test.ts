/** @vitest-environment node */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'vitest'
import { runWithAccount } from '@biu/host-plugin-loader/data-dir'
import { PluginRegistryClient, localRegistryTransport, registryTokenPath } from './registry-client.ts'
import { PluginRegistryStore, ownerIdForToken } from './registry.ts'
import type { PluginStoreService } from './store.ts'
import { pluginsCollection } from './collection.ts'

test('restored account credentials preserve multiple publisher owners and isolate other accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-identities-'))
  const previousEnv = process.env.BIU_PLUGIN_TOKEN
  delete process.env.BIU_PLUGIN_TOKEN
  const primary = randomBytes(24).toString('hex')
  const previous = randomBytes(24).toString('hex')
  const outsider = randomBytes(24).toString('hex')
  const admin = randomBytes(24).toString('hex')
  try {
    const registry = new PluginRegistryStore(join(root, 'registry'), 'local', admin)
    const origins = new Map<string, { registryId: string; ownerId: string }>()
    const listings: any[] = []
    for (const [id, token] of [['primary-plugin', primary], ['legacy-plugin', previous]]) {
      const dir = join(root, '.plugin', id)
      await mkdir(dir, { recursive: true })
      const manifest = JSON.stringify({ id, name: id, blurb: 'test', tags: [], provides: [], createdAt: 1 })
      await writeFile(join(dir, 'manifest.json'), manifest)
      await writeFile(join(dir, 'host.js'), 'export function apply() { return 2 }')
      const first = await registry.publish(id, { 'manifest.json': manifest, 'host.js': 'export function apply() { return 1 }' }, {}, token)
      await registry.review(id, first.codeVersion, 'approved', '', admin)
      origins.set(id, { registryId: 'local', ownerId: first.ownerId })
      listings.push({ id, name: id, installed: true, enabled: false, running: false, hasHost: true, hasWeb: false, bytes: 1, updatedAt: 1, codeVersion: first.codeVersion })
    }
    const store = {
      originOf: (id: string) => origins.get(id),
      pluginPath: (id: string) => join(root, '.plugin', id),
      sandboxPath: (id: string) => join(root, '.plugin-dev', id),
      rememberOrigin: (id: string, origin: { registryId: string; ownerId: string }) => origins.set(id, origin),
      list: async () => listings,
      listSandboxes: async () => [],
      isInstalledForCurrentWorkspace: async () => true,
      remoteFlags: async () => client.flags(),
    } as unknown as PluginStoreService
    const client = new PluginRegistryClient(store, localRegistryTransport(registry), 'local', registryTokenPath(root))
    const alicePath = registryTokenPath(root, 'alice')
    await mkdir(join(root, '.biu', 'plugin-registry'), { recursive: true })
    await writeFile(alicePath, JSON.stringify({ token: primary, previousTokens: [previous, primary] }), { mode: 0o600 })
    await writeFile(registryTokenPath(root, 'bob'), JSON.stringify({ token: outsider }), { mode: 0o600 })
    await runWithAccount('alice', async () => {
      const list = await client.search()
      assert.equal(list.plugins.length, 2)
      assert.ok(list.plugins.every(p => p.ownedByRequester))
      assert.equal(client.ownsPublisher(ownerIdForToken(previous)), true)
      const pluginRows = await pluginsCollection(store, client).list()
      assert.ok(pluginRows.every(row => row.canPublish === true))
      const updated = await client.publish('legacy-plugin')
      assert.equal(updated.ownerId, ownerIdForToken(previous))
      assert.equal((await client.detail('legacy-plugin'))?.reviewStatus, 'pending')
      await client.withdraw('legacy-plugin')
      const resubmitted = await client.publish('legacy-plugin')
      await registry.review('legacy-plugin', resubmitted.codeVersion, 'approved', '', admin)
      const unpublished = await client.unpublish('legacy-plugin') as { reviewStatus: string; codeVersion: string }
      assert.equal(unpublished.reviewStatus, 'unpublished')
      assert.equal(unpublished.codeVersion, resubmitted.codeVersion)
      assert.ok((await registry.search()).every(p => p.id !== 'legacy-plugin' || p.codeVersion !== resubmitted.codeVersion))
      assert.equal((await client.detail('legacy-plugin'))?.ownedByRequester, true)
    })
    await runWithAccount('bob', async () => {
      assert.equal(client.canPublish('primary-plugin'), false)
      assert.equal(client.canPublish('legacy-plugin'), false)
      const list = await client.search()
      assert.ok(list.plugins.every(p => !p.ownedByRequester))
      await assert.rejects(client.unpublish('primary-plugin'), /only the uploader/)
      await assert.rejects(client.publish('primary-plugin'), /只有发布者/)
      const publicDetail = await client.detail('legacy-plugin')
      assert.equal(publicDetail?.reviewStatus, 'approved')
      assert.equal(Boolean(publicDetail?.ownedByRequester), false)
    })
    await runWithAccount('alice', async () => {
      assert.equal(client.canPublish('legacy-plugin'), true)
      process.env.BIU_PLUGIN_TOKEN = outsider
      assert.equal(client.canPublish('legacy-plugin'), false)
      assert.equal(client.ownsPublisher(ownerIdForToken(primary)), false)
      delete process.env.BIU_PLUGIN_TOKEN
    })
  } finally {
    if (previousEnv === undefined) delete process.env.BIU_PLUGIN_TOKEN
    else process.env.BIU_PLUGIN_TOKEN = previousEnv
    await rm(root, { recursive: true, force: true })
  }
})
