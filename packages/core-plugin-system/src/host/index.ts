import type { Context } from 'cordis'
import { pluginsCollection } from './collection.ts'
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
  ctx.inject(['database'], (inner) => {
    inner.database.register(pluginsCollection(store))
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.register(
      'plugin.creation',
      '创建插件前，先查看是否已有相似插件。插件描述必须和其它插件明显不同。创建插件时，必须说明它支持哪些 Action。',
    )
  })
}
