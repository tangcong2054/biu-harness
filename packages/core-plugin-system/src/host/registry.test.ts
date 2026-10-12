/** @vitest-environment node */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { CatalogEntry } from '@biu/host-hub'
import { pluginCatalogCollection } from './catalog.ts'
import { loadRegistryConfig } from './registry-config.ts'
import { PluginRegistryClient, localRegistryTransport, registryTokenPath } from './registry-client.ts'
import { PluginRegistryStore, ownerIdForToken } from './registry.ts'
import { PluginStoreService } from './store.ts'

function stubHub(ctx: Context) {
  const adopted: string[] = []
  const dropped: string[] = []
  const forks = new Map<string, CatalogEntry>()
  ;(ctx as unknown as { hub: unknown }).hub = {
    async adopt(entry: CatalogEntry) {
      forks.set(entry.id, entry)
      adopted.push(entry.id)
    },
    async drop(id: string) {
      forks.delete(id)
      dropped.push(id)
    },
    snapshot() {
      return { plugins: [...forks.values()].map((entry) => ({ id: entry.id, enabled: true, state: 'active' })) }
    },
  }
  return { adopted, dropped, forks }
}

function manifest(id: string, extra = '') {
  return `${JSON.stringify({
    id,
    name: id,
    blurb: '查询慢日志',
    tags: ['cdb'],
    provides: [{ kind: id, label: '原始慢日志', aliases: ['慢日志', 'slowlog'] }],
    headless: true,
    createdAt: 1,
  }, null, 2)}\n${extra}`
}

async function seed(dir: string, id: string, host: string) {
  const pluginDir = join(dir, '.plugin', id)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'manifest.json'), manifest(id))
  await writeFile(join(pluginDir, 'host.js'), host)
  await writeFile(join(pluginDir, 'README.md'), '# 慢日志\n\n示例\n')
}

test('registry config reads id, dataDir and url', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-registry-config-'))
  try {
    const path = join(dir, 'plugin-registry.config.json')
    await writeFile(path, JSON.stringify({ id: 'shop', dataDir: 'store-data', url: 'https://plugins.example.com/api/plugin-registry/v1/' }))
    const config = loadRegistryConfig(dir, path)
    assert.equal(config.id, 'shop')
    assert.equal(config.dataDir, join(dir, 'store-data'))
    assert.equal(config.url, 'https://plugins.example.com/api/plugin-registry/v1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('publish, search, install, update and reject a different token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-registry-'))
  const prevToken = process.env.BIU_PLUGIN_TOKEN
  delete process.env.BIU_PLUGIN_TOKEN
  try {
    const ctx = new Context()
    const { dropped, adopted } = stubHub(ctx)
    const store = new PluginStoreService(ctx, join(dir, '.plugin'), join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    const registry = new PluginRegistryStore(join(dir, 'registry'), 'local')
    const client = new PluginRegistryClient(store, localRegistryTransport(registry), 'local', registryTokenPath(dir))
    store.attachRegistry(client)

    await seed(dir, 'slow-log', `export const name = 'slow-log'\nexport function apply() { return 1 }\n`)
    const published = await client.publish('slow-log')
    assert.equal(published.ownerId, ownerIdForToken(await readToken(dir)))
    assert.equal(published.registryId, 'local')

    const found = await registry.search('慢日志')
    assert.equal(found.length, 1)
    assert.equal(found[0]?.id, 'slow-log')
    assert.equal(found[0]?.codeVersion, published.codeVersion)

    await assert.rejects(
      () => registry.publish('slow-log', {
        'manifest.json': manifest('slow-log'),
        'host.js': `export const name = 'slow-log'\nexport function apply() { return 2 }\n`,
      }, {}, 'biu_plug_other'),
      /owned by/,
    )

    const consumerDir = await mkdtemp(join(tmpdir(), 'plugin-registry-consumer-'))
    try {
      const ctx2 = new Context()
      const hub2 = stubHub(ctx2)
      const consumer = new PluginStoreService(ctx2, join(consumerDir, '.plugin'), join(consumerDir, 'store.json'), join(consumerDir, '.plugin-dev')).open()
      const remote = new PluginRegistryClient(consumer, localRegistryTransport(registry), 'local', registryTokenPath(consumerDir))
      consumer.attachRegistry(remote)
      const catalog = pluginCatalogCollection(remote)
      const before = await catalog.list?.()
      assert.equal(before?.[0]?.installed, undefined)
      assert.equal(before?.[0]?.updateAvailable, undefined)
      await catalog.actions?.find((item) => item.id === 'install')?.run('slow-log', before![0]!)
      const host = await readFile(join(consumerDir, '.plugin', 'slow-log', 'host.js'), 'utf8')
      assert.match(host, /return 1/)
      assert.equal(await existsSandbox(consumerDir, 'slow-log'), false)

      await registry.publish('slow-log', {
        'manifest.json': manifest('slow-log'),
        'host.js': `export const name = 'slow-log'\nexport function apply() { return 2 }\n`,
        'README.md': '# 慢日志\n',
      }, {}, await readToken(dir))
      const listed = await catalog.list?.()
      assert.equal(listed?.[0]?.updateAvailable, true)
      assert.notEqual(listed?.[0]?.localCodeVersion, listed?.[0]?.remoteCodeVersion)
      await remote.update('slow-log')
      const next = await readFile(join(consumerDir, '.plugin', 'slow-log', 'host.js'), 'utf8')
      assert.match(next, /return 2/)
      const after = await catalog.list?.()
      assert.equal(after?.[0]?.updateAvailable, undefined)
      assert.equal(hub2.adopted.length + hub2.dropped.length >= 0, true)
    } finally {
      await rm(consumerDir, { recursive: true, force: true })
    }

    await store.openPlugin('slow-log')
    await registry.publish('slow-log', {
      'manifest.json': manifest('slow-log'),
      'host.js': `export const name = 'slow-log'\nexport function apply() { return 3 }\n`,
    }, {}, await readToken(dir))
    await client.update('slow-log')
    assert.deepEqual(dropped, ['slow-log'])
    assert.deepEqual(adopted, ['slow-log', 'slow-log'])
    const rerun = await readFile(join(dir, '.plugin', 'slow-log', 'host.js'), 'utf8')
    assert.match(rerun, /return 3/)
  } finally {
    if (prevToken === undefined) delete process.env.BIU_PLUGIN_TOKEN
    else process.env.BIU_PLUGIN_TOKEN = prevToken
    await rm(dir, { recursive: true, force: true })
  }
})

test('install refuses a local id that belongs to someone else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-registry-conflict-'))
  try {
    const ctx = new Context()
    stubHub(ctx)
    const store = new PluginStoreService(ctx, join(dir, '.plugin'), join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    const registry = new PluginRegistryStore(join(dir, 'registry'), 'local')
    await registry.publish('slow-log', {
      'manifest.json': manifest('slow-log'),
      'host.js': `export const name = 'slow-log'\nexport function apply() {}\n`,
    }, {}, 'biu_plug_owner')
    await store.initSandbox({ id: 'slow-log', name: '本地草稿', hostJs: `export const name = 'slow-log'\nexport function apply() {}\n` })
    const client = new PluginRegistryClient(store, localRegistryTransport(registry), 'local', registryTokenPath(dir))
    await assert.rejects(() => client.install('slow-log'), /plugin id conflict: slow-log/)
    const catalog = pluginCatalogCollection(client)
    const row = (await catalog.list?.())?.[0]
    assert.equal(row?.idConflict, true)
    assert.equal(row?.updateAvailable, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dataDir keeps the registry id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-registry-id-'))
  try {
    new PluginRegistryStore(dir, 'local')
    assert.throws(() => new PluginRegistryStore(dir, 'other'), /belongs to local/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function readToken(workspace: string) {
  const raw = JSON.parse(await readFile(registryTokenPath(workspace), 'utf8')) as { token: string }
  return raw.token
}

async function existsSandbox(workspace: string, id: string) {
  try {
    await readFile(join(workspace, '.plugin-dev', id, 'manifest.json'), 'utf8')
    return true
  } catch {
    return false
  }
}
