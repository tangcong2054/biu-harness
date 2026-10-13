import { dirname } from 'node:path'
import type { Context } from 'cordis'
import { pluginCatalogCollection, pluginReviewsCollection } from './catalog.ts'
import { pluginsCollection } from './collection.ts'
import { loadRegistryConfig } from './registry-config.ts'
import { httpRegistryTransport, localRegistryTransport, PluginRegistryClient, registryTokenPath } from './registry-client.ts'
import { registerRegistryRoutes } from './registry-http.ts'
import { loadRegistryAdminToken, PluginRegistryStore } from './registry.ts'
import { openStore } from './store.ts'

export const name = 'core-plugin-system'
export const inject = ['http', 'hub']

export {
  PluginStoreService,
  defaultPluginDir,
  defaultStatePath,
} from './store.ts'
export { pluginsCollection } from './collection.ts'

export async function apply(ctx: Context) {
  const store = await openStore(ctx)
  const config = loadRegistryConfig()
  let transport
  if (config.url) {
    transport = httpRegistryTransport(config.url)
  } else {
    // 兼容旧配置；正式部署和本地模拟均应启动独立 Registry 服务并配置 url。
    const registry = new PluginRegistryStore(config.dataDir, config.id)
    registerRegistryRoutes(ctx, registry)
    transport = localRegistryTransport(registry)
  }
  const client = new PluginRegistryClient(
    store,
    transport,
    config.id,
    registryTokenPath(dirname(store.sandboxDir)),
    loadRegistryAdminToken(config.dataDir),
  )
  store.attachRegistry(client)
  ctx.inject(['database'], (inner) => {
    inner.database.register(pluginsCollection(store, client))
    inner.database.register(pluginCatalogCollection(client))
    inner.database.register(pluginReviewsCollection(client))
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.register(
      'plugin.creation',
      '创建插件前，先查看是否已有相似插件：用 db_list /plugin-catalog q=关键词确认商店里没有能用的插件。没有再在 /plugins 里 sandbox、pack。插件描述必须和其它插件明显不同。创建插件时，必须说明它支持哪些 Action（包括 ui_action）。',
    )
  })
}
