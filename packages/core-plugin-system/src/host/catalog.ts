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
        ownedByRequester: row.ownedByRequester === true,
        reviewStatus: row.reviewStatus,
        reviewReason: row.reviewReason,
        scanStatus: row.scanStatus,
        scanIssues: row.scanIssues,
        cached: flag?.cached === true,
        installed: flag?.installed === true,
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
      inspector: true,
      blurb: '远端插件目录，不是本机已安装插件。人从数据表打开「插件商店」。搜索 db_list /plugin-catalog q=关键词。安装 db_action /plugin-catalog/<id> action=install，可选 args.version 钉住 codeVersion。更新 db_action action=update，只在 updateAvailable 为 true 时可用。idConflict 为 true 表示本机已有同 id 但不是这家商店的同一所有者，不能覆盖。装完后到 /plugins 用 start 运行。发布走 /plugins/<id> action=publish。',
      order: 31,
      icon: 'puzzle-piece',
    },
    records: { update: false, create: false, delete: false },
    schema: {
      labelField: 'title',
      contentField: 'readme',
      contentBackend: 'computed',
      columns: ['title', 'blurb', 'tags', 'installed', 'updateAvailable', 'reviewStatus', 'remoteCodeVersion', 'author'],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '标题' },
        blurb: { type: 'string', label: '简介' },
        tags: { type: 'multi-select', label: '标签' },
        author: { type: 'string', label: '作者' },
        installed: { type: 'boolean', label: '已安装' },
        cached: { type: 'boolean', label: '宿主已缓存' },
        updateAvailable: { type: 'boolean', label: '可更新' },
        idConflict: { type: 'boolean', label: 'ID 冲突' },
        remoteCodeVersion: { type: 'string', label: '商店版本' },
        localCodeVersion: { type: 'string', label: '本地版本' },
        ownerId: { type: 'string', label: '所有者' },
        ownedByRequester: { type: 'boolean', label: '我的上传' },
        reviewStatus: { type: 'select', label: '审核状态' },
        reviewReason: { type: 'string', label: '审核/异常原因' },
        scanStatus: { type: 'select', label: '检测状态' },
        scanIssues: { type: 'string[]', label: '检测问题' },
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
      {
        id: 'uninstall',
        label: '从空间卸载',
        when: { installed: true },
        description: '只移除当前账号在当前 Workspace 的插件安装关系；其他成员和宿主缓存不受影响。',
        run: async (id) => client.uninstall(id),
      },
      {
        id: 'withdraw',
        label: '撤回提交',
        when: { ownedByRequester: true, reviewStatus: 'pending' },
        description: '上传者撤回自己的待审核版本；不会影响当前 Workspace 已安装的副本。',
        run: async (id) => client.withdraw(id),
      },
      {
        id: 'unpublish',
        label: '下架',
        when: { ownedByRequester: true, reviewStatus: 'approved' },
        description: '上传者下架已公开版本，禁止新安装；已安装 Workspace 暂时保留。',
        run: async (id) => client.unpublish(id),
      },
    ],
  }
}

export function pluginReviewsCollection(client: PluginRegistryClient): CollectionSpec {
  const list = async (query?: { q?: string }) => {
    const rows = await client.reviews()
    const q = String(query?.q ?? '').trim().toLowerCase()
    return rows
      .filter((row) => !q || `${row.id}\n${row.name}\n${row.blurb}\n${row.reviewReason}\n${row.scanIssues.join('\n')}`.toLowerCase().includes(q))
      .map((row) => omitEmpty({
        id: `${row.id}@${row.codeVersion}`,
        pluginId: row.id,
        title: `${row.name} · ${row.codeVersion}`,
        blurb: row.blurb,
        tags: row.tags,
        author: row.author,
        codeVersion: row.codeVersion,
        ownerId: row.ownerId,
        reviewStatus: row.reviewStatus,
        reviewReason: row.reviewReason,
        scanStatus: row.scanStatus,
        scanIssues: row.scanIssues,
        submittedAt: row.updatedAt,
      }))
  }
  const reviewAction = (
    id: 'approve' | 'reject' | 'quarantine' | 'revoke',
    label: string,
    status: 'approved' | 'rejected' | 'quarantined' | 'revoked',
  ) => ({
    id,
    label,
    description: `${label}商店插件版本。args.reason 可填写运营原因。`,
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
    run: async (_id: string, record: DbRecord, args: Record<string, unknown> = {}) =>
      client.review(String(record.pluginId), String(record.codeVersion), status, String(args.reason ?? '')),
  })
  return {
    id: 'plugin-reviews',
    path: '/plugin-reviews',
    label: '插件审核',
    view: {
      moduleId: 'plugin-reviews',
      route: '/plugin-reviews',
      title: '插件审核',
      inspector: true,
      blurb: '平台运营端的插件审核队列。仅运营 Workspace 中具备 owner/admin 角色的账号可见，用于审核、驳回、隔离和撤销版本。',
      order: 32,
      icon: 'puzzle-piece',
    },
    records: { update: false, create: false, delete: false },
    schema: {
      labelField: 'title',
      columns: ['title', 'reviewStatus', 'scanStatus', 'scanIssues', 'reviewReason', 'author', 'submittedAt'],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '版本' },
        pluginId: { type: 'string', label: '插件 ID' },
        blurb: { type: 'string', label: '简介' },
        tags: { type: 'multi-select', label: '标签' },
        author: { type: 'string', label: '作者' },
        codeVersion: { type: 'string', label: '代码版本' },
        ownerId: { type: 'string', label: '所有者' },
        reviewStatus: { type: 'select', label: '审核状态' },
        reviewReason: { type: 'string', label: '审核原因' },
        scanStatus: { type: 'select', label: '检测状态' },
        scanIssues: { type: 'string[]', label: '检测问题' },
        submittedAt: { type: 'datetime', label: '提交时间' },
      },
    },
    list,
    get: async (id) => (await list()).find((row) => row.id === id) ?? null,
    actions: [
      reviewAction('approve', '审核通过', 'approved'),
      reviewAction('reject', '驳回', 'rejected'),
      reviewAction('quarantine', '异常隔离', 'quarantined'),
      reviewAction('revoke', '撤销版本', 'revoked'),
    ],
  }
}
