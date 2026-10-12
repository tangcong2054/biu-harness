import type { CollectionSpec } from '@biu/type-file-system'
import { recordBuiltinValues, REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import type { PluginRegistryClient } from './registry-client.ts'

function omitEmpty(row: DbRecord): DbRecord {
  const next: DbRecord = { id: row.id }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue
    if (value == null || value === '' || value === false) continue
    if (Array.isArray(value) && value.length === 0) continue
    next[key] = value
  }
  return { ...next, ...recordBuiltinValues(row) }
}

export function pluginCatalogCollection(client: PluginRegistryClient): CollectionSpec {
  const list = async (query?: { q?: string }) => {
    const listed = await client.search(query?.q)
    const flags = await client.flags()
    return listed.plugins.map((row) => {
      const flag = flags[row.id]
      return omitEmpty({
        id: row.id,
        name: row.name,
        title: row.name,
        blurb: row.blurb,
        tags: row.tags,
        author: row.author,
        headless: row.headless,
        hasHost: row.hasHost,
        hasWeb: row.hasWeb,
        bytes: row.bytes,
        updatedAt: row.updatedAt,
        remoteCodeVersion: row.codeVersion,
        localCodeVersion: flag?.localCodeVersion ?? '',
        ownerId: row.ownerId,
        installed: Boolean(flag?.localCodeVersion),
        updateAvailable: flag?.updateAvailable === true,
        idConflict: flag?.idConflict === true,
        registryId: listed.registryId || client.registryId,
      })
    })
  }
  return {
    id: 'plugin-catalog',
    path: '/plugin-catalog',
    label: '插件商店',
    view: {
      moduleId: 'plugin-catalog',
      route: '/plugin-catalog',
      title: '插件商店',
      inspector: false,
      blurb: '远端插件目录，不是本机已安装插件。人从数据表打开「插件商店」。搜索 db_list /plugin-catalog q=关键词。安装 db_action /plugin-catalog/<id> action=install，可选 args.version 钉住 codeVersion。更新 db_action action=update，只在 updateAvailable 为 true 时可用。idConflict 为 true 表示本机已有同 id 但不是这家商店的同一所有者，不能覆盖。装完后到 /plugins 用 start 运行。发布走 /plugins/<id> action=publish。',
      order: 31,
      icon: 'puzzle-piece',
    },
    records: { update: false, create: false, delete: false },
    schema: {
      labelField: 'title',
      contentField: 'readme',
      contentBackend: 'computed',
      columns: ['title', 'blurb', 'tags', 'installed', 'updateAvailable', 'remoteCodeVersion', 'author'],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '标题' },
        blurb: { type: 'string', label: '简介' },
        tags: { type: 'multi-select', label: '标签' },
        author: { type: 'string', label: '作者' },
        installed: { type: 'boolean', label: '已安装' },
        updateAvailable: { type: 'boolean', label: '可更新' },
        idConflict: { type: 'boolean', label: 'ID 冲突' },
        remoteCodeVersion: { type: 'string', label: '商店版本' },
        localCodeVersion: { type: 'string', label: '本地版本' },
        ownerId: { type: 'string', label: '所有者' },
        registryId: { type: 'string', label: '商店' },
        hasHost: { type: 'boolean', label: 'Host' },
        hasWeb: { type: 'boolean', label: 'Web' },
        bytes: { type: 'number', label: '大小' },
        headless: { type: 'boolean', label: '无头' },
        readme: { type: 'file', label: '介绍' },
      },
    },
    list,
    get: async (id) => {
      const row = (await list()).find((item) => item.id === id)
      if (!row) return null
      const detail = await client.detail(id)
      return { ...row, readme: detail?.readme ?? '' }
    },
    actions: [
      {
        id: 'install',
        label: '安装',
        when: { installed: false, idConflict: false },
        description: '把商店里的打包结果下载到 .plugin/<id>/，不建沙箱。args.version 可填 codeVersion，缺省 latest。id 冲突时不要调用。',
        parameters: {
          type: 'object',
          properties: { version: { type: 'string', description: '要安装的 codeVersion，缺省最新' } },
        },
        run: async (id, _record, args = {}) => client.install(id, typeof args.version === 'string' ? args.version : undefined),
      },
      {
        id: 'update',
        label: '更新',
        when: { updateAvailable: true },
        description: '下载商店 latest 并覆盖 .plugin/<id>/。插件正在运行时会卸掉再挂上新的 host.js / web.js。',
        run: async (id) => client.update(id),
      },
    ],
  }
}
