import type { CollectionActionInfo, CollectionSchema } from '@biu/type-file-system'

export type PublicLinkPatch = {
  enabled?: boolean
  password?: string | null
  sharePlugins?: boolean
  allowCopy?: boolean
}

export const RECORD_SHARING_SCHEMA: NonNullable<CollectionSchema['sharing']> = {
  description: '用 db_update content.sharing 更新公开链接。必须单独更新，不与普通字段混写。省略的设置不变；首次开启须 enabled:true；关闭链接不撤销协作者或继承权限。查看设置和协作者用 db_action sharing_get。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['publicLink'],
    properties: {
      publicLink: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          enabled: { type: 'boolean' },
          password: { type: ['string', 'null'], maxLength: 1024, description: 'null 或空串清除密码；省略保持不变。密码不在结果中返回。' },
          sharePlugins: { type: 'boolean' },
          allowCopy: { type: 'boolean' },
        },
      },
    },
  },
}

export const RECORD_SHARING_ACTIONS: CollectionActionInfo[] = [
  {
    id: 'sharing_get',
    label: '查看共享设置',
    for: 'agent',
    requiredAction: 'resource:share',
    description: '查看当前记录的直接公开链接和直接协作者授权。不会列出全部继承权限；密码不返回。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    id: 'sharing_invite',
    label: '邀请协作者',
    for: 'agent',
    requiredAction: 'resource:share',
    description: '按邮箱为已注册账号授予或更新当前记录的协作权限，不发送注册邀请邮件。role 默认 viewer；当前空间内部成员须传 collaboratorKind:internal，外部协作者默认 external。只改变指定协作者的直接授权，不改变公开链接。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['email'],
      properties: {
        email: { type: 'string' },
        role: { type: 'string', enum: ['viewer', 'editor', 'manager'], default: 'viewer' },
        collaboratorKind: { type: 'string', enum: ['internal', 'external'], default: 'external' },
      },
    },
  },
  {
    id: 'sharing_revoke',
    label: '撤销协作者',
    for: 'agent',
    requiredAction: 'resource:manage-permissions',
    description: '撤销指定 accountId 对当前记录的直接授权。accountId 从 sharing_get 获取；不会撤销空间、视图、父记录等继承权限，也不会关闭公开链接。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['accountId'],
      properties: { accountId: { type: 'string' } },
    },
  },
]

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unknown sharing field: ${key}`)
  }
}

export function parseSharingUpdate(content: Record<string, unknown>): PublicLinkPatch {
  if (Object.keys(content).some((key) => key !== 'sharing')) throw new Error('sharing must be updated separately from record fields')
  const sharing = object(content.sharing, 'sharing')
  onlyKeys(sharing, ['publicLink'])
  const patch = object(sharing.publicLink, 'sharing.publicLink')
  onlyKeys(patch, ['enabled', 'password', 'sharePlugins', 'allowCopy'])
  if (!Object.keys(patch).length) throw new Error('sharing.publicLink must not be empty')
  for (const key of ['enabled', 'sharePlugins', 'allowCopy']) {
    if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`sharing.publicLink.${key} must be a boolean`)
  }
  if ('password' in patch && patch.password !== null && (typeof patch.password !== 'string' || patch.password.length > 1024)) {
    throw new Error('sharing.publicLink.password must be a string of at most 1024 characters or null')
  }
  if (patch.enabled === false && Object.keys(patch).length !== 1) throw new Error('disabling a public link cannot be combined with other settings')
  return patch as PublicLinkPatch
}

export function parseSharingAction(action: string, input?: Record<string, unknown>): {
  email?: string; role?: 'viewer' | 'editor' | 'manager'; accountId?: string; collaboratorKind?: 'internal' | 'external'
} {
  const args = object(input ?? {}, 'sharing action args')
  if (action === 'sharing_get') {
    onlyKeys(args, [])
    return {}
  }
  if (action === 'sharing_invite') {
    onlyKeys(args, ['email', 'role', 'collaboratorKind'])
    if (typeof args.email !== 'string' || args.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim())) {
      throw new Error('a valid collaborator email is required')
    }
    const role = args.role ?? 'viewer'
    if (role !== 'viewer' && role !== 'editor' && role !== 'manager') throw new Error('role must be viewer, editor or manager')
    const collaboratorKind = args.collaboratorKind ?? 'external'
    if (collaboratorKind !== 'internal' && collaboratorKind !== 'external') throw new Error('collaboratorKind must be internal or external')
    return { email: args.email.trim().toLowerCase(), role, collaboratorKind }
  }
  if (action === 'sharing_revoke') {
    onlyKeys(args, ['accountId'])
    if (typeof args.accountId !== 'string' || !args.accountId.trim() || args.accountId.length > 255) throw new Error('accountId is required')
    return { accountId: args.accountId.trim() }
  }
  throw new Error(`unknown sharing action: ${action}`)
}
