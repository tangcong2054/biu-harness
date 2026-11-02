/**
 * 协作权限详情的接口契约（GET /api/account/access）。
 * SQLite 与 MySQL 两条路径都只返回这里列出的字段；前端分享面板只依赖这些类型。
 *
 * 字段命名约定：
 *  - 接口里一律用 memberKind（member / external / guest）。
 *  - /workspace-members 集合记录上的同义字段叫 membershipKind，它已写进成员视图的筛选条件，
 *    是存量数据的一部分，不能改名。
 */

export type MemberKind = 'member' | 'external' | 'guest'
export type AccessRole = 'viewer' | 'editor' | 'manager' | 'owner'
export type AccessScope = 'personal' | 'workspace' | 'shared'

export type AccessPerson = {
  id: string
  name: string
  email: string
  role: string
  memberKind: MemberKind
}

export type AccessGroup = { id: string; name: string; role: string }
export type AccessMemberView = { id: string; role: string }

/** 通过数据视图授出的权限；记录详情里只包含对这条记录生效的那些。 */
export type ViewGrantShare = {
  viewId: string
  subjectType: 'account' | 'member_view'
  subjectId: string
  role: string
  name: string
  email: string
  grantedBy: string
  memberKind: MemberKind
}

/** 当前账号对这条记录的权限从哪里来，从这条内容一路到继承的上级。 */
export type RoleChainStep = { id: string; title: string; detail: string; role: AccessRole }

export type RecordAccessDetails = {
  private: boolean
  scope: AccessScope
  ownerId: string
  people: AccessPerson[]
  groups: AccessGroup[]
  memberViews: AccessMemberView[]
  viewGrants: ViewGrantShare[]
  roleChain: RoleChainStep[]
}

export type ViewAccessDetails = {
  private: boolean
  scope: 'personal'
  ownerId: ''
  viewId: string
  people: AccessPerson[]
  groups: AccessGroup[]
  memberViews: AccessMemberView[]
}

export function toMemberKind(value: unknown): MemberKind {
  return value === 'external' || value === 'guest' ? value : 'member'
}

const ROLES = new Set<string>(['viewer', 'editor', 'manager', 'owner'])
const SCOPES = new Set<string>(['personal', 'workspace', 'shared'])

const text = (value: unknown) => (value == null ? '' : String(value))
const list = (value: unknown) => (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>

const person = (row: Record<string, unknown>): AccessPerson => ({
  id: text(row.id), name: text(row.name), email: text(row.email), role: text(row.role), memberKind: toMemberKind(row.memberKind),
})
const group = (row: Record<string, unknown>): AccessGroup => ({ id: text(row.id), name: text(row.name || row.id), role: text(row.role) })
const memberView = (row: Record<string, unknown>): AccessMemberView => ({ id: text(row.id), role: text(row.role) })

/**
 * 只挑出契约字段：内部计算用的 policy、原始授权行等不会再出现在响应里
 * （原始授权行里有其他协作者的邮箱和授权人，超出分享面板需要的范围）。
 */
export function toRecordAccessDetails(raw: Record<string, unknown>): RecordAccessDetails {
  const people = list(raw.people).map(person)
  const groups = list(raw.groups).map(group)
  const memberViews = list(raw.memberViews).map(memberView)
  const ownerId = text(raw.ownerId)
  return {
    private: typeof raw.private === 'boolean'
      ? raw.private
      : people.filter((row) => row.id !== ownerId).length + groups.length + memberViews.length === 0,
    scope: SCOPES.has(text(raw.scope)) ? (raw.scope as AccessScope) : 'personal',
    ownerId,
    people,
    groups,
    memberViews,
    viewGrants: list(raw.viewGrants).map((row) => ({
      viewId: text(row.viewId),
      subjectType: row.subjectType === 'member_view' ? 'member_view' : 'account',
      subjectId: text(row.subjectId),
      role: text(row.role),
      name: text(row.name),
      email: text(row.email),
      grantedBy: text(row.grantedBy),
      memberKind: toMemberKind(row.memberKind),
    })),
    roleChain: list(raw.roleChain).flatMap((row) => ROLES.has(text(row.role))
      ? [{ id: text(row.id), title: text(row.title), detail: text(row.detail), role: row.role as AccessRole }]
      : []),
  }
}

export function toViewAccessDetails(raw: Record<string, unknown>, viewId: string): ViewAccessDetails {
  const people = list(raw.people).map(person)
  const memberViews = list(raw.memberViews).map(memberView)
  return {
    private: people.length + memberViews.length === 0,
    scope: 'personal',
    ownerId: '',
    viewId,
    people,
    groups: [],
    memberViews,
  }
}
