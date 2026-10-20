import type { CollectionSpec, DbRecord } from '@biu/type-file-system'
import { recordBuiltinValues, REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import {
  createArgs,
  PLUGIN_PACK_DESCRIPTION,
  PLUGIN_SANDBOX_DESCRIPTION,
  PLUGIN_SANDBOX_PROPERTIES,
} from './plugin-create.ts'
import type { PluginRegistryClient } from './registry-client.ts'
import type { PluginStoreService, StoreListing } from './store.ts'

type SandboxListing = Awaited<ReturnType<PluginStoreService['listSandboxes']>>[number]

export const BIU_OFFICIAL_NAME = 'BIU官方'
export const BIU_GITHUB = 'https://github.com/helloooooooooooooo97/biu'

const BIU_OFFICIAL = { kind: 'user' as const, name: BIU_OFFICIAL_NAME, url: BIU_GITHUB }

function withOfficial<T extends { builtin?: boolean; author: string; authorUrl: string }>(row: T) {
  if (!row.builtin) return row
  return {
    ...row,
    author: BIU_OFFICIAL_NAME,
    authorUrl: BIU_GITHUB,
    createdBy: BIU_OFFICIAL,
    updatedBy: [BIU_OFFICIAL],
  }
}

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

function asInstalledRecord(row: StoreListing, store: PluginStoreService): DbRecord {
  const shell = row.shell
  return omitEmpty({
    id: row.id,
    name: row.name,
    title: row.name,
    blurb: row.blurb,
    tags: row.tags,
    ...withOfficial(row),
    // 空间卸载后磁盘目录还在，installed 以 store 给出的空间视角为准。
    installed: row.installed !== false,
    pluginPath: store.pluginPath(row.id),
    enabled: row.enabled,
    running: row.running,
    bytes: row.bytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    hasHost: row.hasHost,
    hasWeb: row.hasWeb,
    codeVersion: row.codeVersion,
    headless: row.headless === true,
    ...(row.headless || !shell
      ? {}
      : {
          shellWidth: shell.width,
          shellHeight: shell.height,
          shellMinWidth: shell.minWidth,
          shellMinHeight: shell.minHeight,
          shellResizable: shell.resizable,
        }),
  })
}

function asSandboxRecord(row: SandboxListing, store: PluginStoreService): DbRecord {
  return omitEmpty({
    id: row.id,
    name: row.name,
    title: row.name,
    blurb: row.blurb,
    tags: row.tags,
    ...withOfficial(row),
    sandbox: true,
    sandboxPath: store.sandboxPath(row.id),
    hasHost: row.hasHost,
    hasWeb: row.hasWeb,
    headless: row.headless === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

function mergeLifecycle(
  installed: StoreListing | undefined,
  sandbox: SandboxListing | undefined,
  store: PluginStoreService,
): DbRecord {
  const builtin = Boolean(installed?.builtin || sandbox?.builtin)
  const official = builtin
    ? { builtin: true, author: BIU_OFFICIAL_NAME, authorUrl: BIU_GITHUB, createdBy: BIU_OFFICIAL, updatedBy: [BIU_OFFICIAL] }
    : {}
  if (installed && sandbox) {
    return omitEmpty({
      ...asInstalledRecord(installed, store),
      sandbox: true,
      sandboxPath: store.sandboxPath(sandbox.id),
      updatedAt: Math.max(installed.updatedAt, sandbox.updatedAt),
      ...official,
    })
  }
  if (installed) return { ...asInstalledRecord(installed, store), ...official }
  if (sandbox) return { ...asSandboxRecord(sandbox, store), ...official }
  throw new Error('empty plugin row')
}

export function pluginsCollection(store: PluginStoreService, registry?: PluginRegistryClient): CollectionSpec {
  const list = async () => {
    const [installed, sandboxes] = await Promise.all([store.list(), store.listSandboxes()])
    const ids = new Set([...installed.map((row) => row.id), ...sandboxes.map((row) => row.id)])
    const byInstalled = new Map(installed.map((row) => [row.id, row]))
    const bySandbox = new Map(sandboxes.map((row) => [row.id, row]))
    const flags = typeof store.remoteFlags === 'function' ? await store.remoteFlags() : {}
    return [...ids]
      .sort()
      .map((id) => {
        const listing = byInstalled.get(id)
        const row = mergeLifecycle(listing, bySandbox.get(id), store)
        // 只有"已安装 + 自己发布的（或商店里还没人占这个 id）"才给发布按钮，
        // 避免点了才被商店或记录权限打成 permission denied。
        // installed 要在 omitEmpty 抹掉 false 之前看原始 listing。
        const remoteOwner = String(flags[id]?.ownerId ?? '')
        const ownedRemotely = !remoteOwner || remoteOwner === registry?.ownerId?.()
        const publishable = Boolean(
          registry && listing && listing.installed !== false && ownedRemotely && registry.canPublish(id),
        )
        const rowWithPublish = publishable ? { ...row, canPublish: true } : row
        const flag = flags[id]
        if (!flag) return rowWithPublish
        return omitEmpty({
          ...rowWithPublish,
          remoteCodeVersion: flag.remoteCodeVersion,
          localCodeVersion: flag.localCodeVersion,
          updateAvailable: flag.updateAvailable,
          idConflict: flag.idConflict,
        })
      })
  }
  const find = async (id: string) => {
    const row = (await list()).find((item) => item.id === id) ?? null
    if (!row) return null
    return { ...row, readme: await store.readReadme(id) }
  }
  return {
    id: 'plugins',
    path: '/plugins',
    label: '插件',
    view: {
      moduleId: 'plugins',
      route: '/plugins',
      title: '插件',
      inspector: true,
      blurb: '这是插件（可安装的小程序），不是代理。用户说「再开一个 agent」请去 /sessions db_create，不要在这张表 create。已安装（.plugin）和沙箱（.plugin-dev）同一张表。列表 db_list /plugins；sandboxPath 是源码绝对路径，pluginPath 是安装产物绝对路径，Session 绑定其他项目时也按这两个字段找代码。README 用 db_content /plugins/<id>。页面块插件先读介绍里的「示例写法」再写 :::pageBlock。name 等只读（facet/tags 仍可写）。不能 db_create。窗口尺寸看 shellWidth/shellHeight。codeVersion 是已安装 host.js+web.js 的内容短哈希，和加载 URL 的 v 参数相同。自己写插件：db_action path=/plugins/<插件id> action=sandbox 建 .plugin-dev/<id>/，写完 action=pack 打进 .plugin，再 action=publish 上传商店。从商店安装走 /plugin-catalog action=install，不要为了安装去建沙箱。updateAvailable 为 true 时 action=update 下载最新版并在运行中则重新挂载。start=打开已安装插件窗口（when：installed 且未 running）；stop=关掉运行中的插件（when：installed 且 running）；uninstall=删除 .plugin/<id>/（沙箱还在则这行还在）。',
      order: 30,
      icon: 'puzzle-piece',
    },
    records: { update: false, create: false, delete: true },
    schema: {
      labelField: 'title',
      contentField: 'readme',
      contentBackend: 'editorContent',
      columns: [
        'title',
        'blurb',
        'installed',
        'sandbox',
        'sandboxPath',
        'pluginPath',
        'running',
        'enabled',
        'tags',
        'createdBy',
        'updatedBy',
        'bytes',
        'shellWidth',
        'shellHeight',
        'hasHost',
        'hasWeb',
        'codeVersion',
        'updateAvailable',
        'headless',
      ],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '标题' },
        blurb: { type: 'string', label: '简介' },
        installed: { type: 'boolean', label: '已安装' },
        sandbox: { type: 'boolean', label: '沙箱' },
        sandboxPath: { type: 'string', label: '源码路径' },
        pluginPath: { type: 'string', label: '安装路径' },
        enabled: { type: 'boolean', label: '已打开' },
        running: { type: 'boolean', label: '运行中' },
        tags: { type: 'multi-select', label: '标签', writable: true },
        bytes: { type: 'number', label: '大小' },
        createdAt: { type: 'datetime', label: '创建时间' },
        updatedAt: { type: 'datetime', label: '更新时间' },
        lastRunAt: { type: 'datetime', label: '上次运行' },
        hasHost: { type: 'boolean', label: 'Host' },
        hasWeb: { type: 'boolean', label: 'Web' },
        codeVersion: { type: 'string', label: '代码版本' },
        remoteCodeVersion: { type: 'string', label: '商店版本' },
        localCodeVersion: { type: 'string', label: '本地版本' },
        updateAvailable: { type: 'boolean', label: '可更新' },
        canPublish: { type: 'boolean', label: '可发布' },
        idConflict: { type: 'boolean', label: 'ID 冲突' },
        headless: { type: 'boolean', label: '无头' },
        shellWidth: { type: 'number', label: '窗口宽' },
        shellHeight: { type: 'number', label: '窗口高' },
        shellMinWidth: { type: 'number', label: '最小宽' },
        shellMinHeight: { type: 'number', label: '最小高' },
        shellResizable: { type: 'boolean', label: '可缩放' },
        readme: { type: 'file', label: '介绍', writable: true },
      },
    },
    list,
    get: find,
    update: async (id, patch) => {
      const extra = Object.keys(patch).filter((key) => key !== 'readme')
      if (extra.length) throw new Error(`plugin fields not writable: ${extra.join(', ')}`)
      if ('readme' in patch) await store.writeReadme(id, String(patch.readme ?? ''))
      return (await find(id)) ?? (() => {
        throw new Error(`unknown plugin: ${id}`)
      })()
    },
    remove: async (query) => {
      const ids = query.ids ?? []
      for (const id of ids) await store.destroy(id)
      return ids
    },
    actions: [
      {
        id: 'sandbox',
        label: '开沙箱',
        for: 'agent',
        placement: [],
        allowMissing: true,
        requiredAction: 'resource:read',
        description: PLUGIN_SANDBOX_DESCRIPTION,
        parameters: {
          type: 'object',
          description: PLUGIN_SANDBOX_DESCRIPTION,
          properties: PLUGIN_SANDBOX_PROPERTIES,
          required: ['name'],
        },
        run: async (id, _record, args = {}) => store.initSandbox(createArgs({ ...args, id })),
      },
      {
        id: 'start',
        label: '运行',
        when: { installed: true, running: false },
        description: '为当前账号在这个空间加载已安装插件（无头则只挂 host）。别人的加载状态互不影响。when：installed 且未 running。不要对纯沙箱、未 pack 的行调用。',
        requiredAction: 'resource:read',
        run: async (id) => {
          await store.openPlugin(id)
        },
      },
      {
        id: 'stop',
        label: '停止',
        when: { installed: true, running: true },
        description: '停止当前账号在这个空间加载的插件。别人如果还在用，他们的加载不受影响。when：installed 且 running。',
        requiredAction: 'resource:read',
        run: async (id) => {
          await store.close(id)
        },
      },
      {
        id: 'pack',
        label: '安装',
        when: { sandbox: true },
        description: PLUGIN_PACK_DESCRIPTION,
        requiredAction: 'resource:read',
        parameters: { type: 'object', description: PLUGIN_PACK_DESCRIPTION, properties: {} },
        run: async (id) => store.pack(id),
      },
      {
        id: 'publish',
        label: '发布到商店',
        // canPublish 由列表按"已安装 + 自己的插件（或全新 id）"算出，没配商店时不会给出。
        // builtin 插件记录对非只读操作一律 permission denied，按钮必须收掉。
        when: { installed: true, canPublish: true, builtin: false },
        description: '把 .plugin/<id>/ 的打包结果上传到插件商店。有沙箱时先 pack。同一把本机发布密钥才能更新已占用的 id。',
        run: async (id) => {
          if (!registry) throw new Error('plugin registry is not configured')
          return registry.publish(id)
        },
      },
      {
        id: 'update',
        label: '从商店更新',
        when: { updateAvailable: true },
        description: '下载商店最新版覆盖 .plugin/<id>/。正在运行时会重新挂载。',
        run: async (id) => {
          if (!registry) throw new Error('plugin registry is not configured')
          return registry.update(id)
        },
      },
      {
        id: 'uninstall',
        label: '卸载',
        tone: 'danger',
        confirm: '确定卸载这个插件？线上只会移除你在当前空间的安装，其他成员不受影响。',
        when: { installed: true, builtin: false },
        description: '线上只移除当前账号在当前空间的安装；本地单机模式删除 .plugin/<id>/。',
        requiredAction: 'resource:delete',
        run: async (id) => {
          await store.uninstall(id)
        },
      },
    ],
  }
}
