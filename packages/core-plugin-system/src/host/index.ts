import { dirname } from 'node:path'
import type { Context } from 'cordis'
import { isOnlineRuntime, isOperationsRuntime } from '@biu/host-plugin-loader/data-dir'
import { pluginCatalogCollection, pluginReviewsCollection } from './catalog.ts'
import { pluginsCollection } from './collection.ts'
import { loadRegistryConfig } from './registry-config.ts'
import { httpRegistryTransport, localRegistryTransport, PluginRegistryClient, registryTokenPath } from './registry-client.ts'
import { registerRegistryRoutes } from './registry-http.ts'
import { loadRegistryAdminToken, PluginRegistryStore } from './registry.ts'
import { bindPlatformOperationsAccount, ensurePlatformOperationsPlugin } from './operations-plugin.ts'
import { checkOperator } from './operations-collections.ts'
import { registerPluginsPrompt } from './prompt.ts'
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
  const operations = (isOnlineRuntime() && !process.env.VITEST) || isOperationsRuntime()
  if (operations) {
    ensurePlatformOperationsPlugin()
    bindPlatformOperationsAccount(ctx)
  }
  const store = await openStore(ctx)
  const config = loadRegistryConfig()
  let transport
  if (config.url) {
    transport = httpRegistryTransport(config.url)
  } else {
    // 兼容旧配置；正式部署和本地模拟均应启动独立 Registry 服务并配置 url。
    const registry = new PluginRegistryStore(config.dataDir, config.id)
    registerRegistryRoutes(ctx, registry, { operations })
    transport = localRegistryTransport(registry)
  }
  const client = new PluginRegistryClient(
    store,
    transport,
    config.id,
    registryTokenPath(dirname(store.sandboxDir)),
    operations ? loadRegistryAdminToken(config.dataDir) : '',
    async () => {
      if (!operations) return false
      return checkOperator(ctx)
    },
  )
  store.attachRegistry(client)
  ctx.inject(['database'], (inner) => {
    inner.database.register(pluginsCollection(store, client))
    inner.database.register(pluginCatalogCollection(client))
    if (operations) inner.database.register(pluginReviewsCollection(client))
  })
  registerPluginsPrompt(ctx, store)
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.register(
      'plugin.creation',
      '创建插件前，先查看是否已有相似插件：用 db_list /plugin-catalog q=关键词确认商店里没有能用的插件。没有再在 /plugins 里 sandbox、pack。插件描述必须和其它插件明显不同。创建插件时，必须说明它支持哪些 Action（包括 ui_action）。' +
        '插件 README（介绍）必须包含「什么时候用」和「示例写法」两段：前者写清用户说什么、要做什么时该用它，后者给出可直接照抄的用法（页面块给完整 :::pageBlock，工具给调用示例）。Agent 只靠插件名和这份介绍决定要不要用它。',
    )
    if (operations) {
      inner.systemPrompt.register(
        'plugin.operations',
        '平台运营是私有页面块插件 platform-operations，仅在运营 Workspace（ws_operations）内供运营账号使用，不发布到插件商店。用户、Workspace、用量、设备、同步、安全和审计分别使用 /ops-accounts、/ops-workspaces、/ops-usage、/ops-devices、/ops-sync-health、/ops-security-events、/ops-audit。插件审核使用 /plugin-reviews 的 approve/reject/quarantine/revoke。在线模型和 API Key 使用 /api/operations/v1/llm，写入主机已有的模型配置，不另建密钥库。这些是平台元数据，不读取用户正文、密码或 Token。',
      )
    }
  })
}
