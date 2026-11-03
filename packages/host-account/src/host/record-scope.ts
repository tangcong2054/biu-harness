export type DataScope = 'personal' | 'workspace' | 'shared'

export type ScopePolicy = {
  ownership: string
  accessMode: string
  parentCollection: string
  parentRecordId: string
  ownerAccountId?: string
  /** 对空间成员开放时普通成员的默认权限（viewer / editor）。 */
  memberDefaultRole?: string
}

export type ScopeSource = {
  policies: Record<string, ScopePolicy>
  owners: ReadonlySet<string>
  /** 没有策略的旧记录的创建者（record_owners）。 */
  legacyOwners?: Readonly<Record<string, string>>
}

export type MysqlRole = 'viewer' | 'editor' | 'manager' | 'owner'
export type MysqlMember = { role: string; memberKind: string }

/** 与 SQLite authorization.ts 的 memberAccessRole 同一规则。 */
export function memberDefaultAccess(policy: ScopePolicy, membershipRole: string): MysqlRole {
  if (membershipRole === 'owner' || membershipRole === 'admin') return 'manager'
  if (membershipRole === 'viewer') return 'viewer'
  if (policy.ownership === 'workspace' || policy.memberDefaultRole === 'editor') return 'editor'
  return 'viewer'
}

const ROLE_RANK: Record<MysqlRole, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 }

/** 与 SQLite authorize 一致：空间“查看者”不管拿到什么授权，最多只能阅读。 */
export function capMysqlRole(role: MysqlRole | null, member: MysqlMember): MysqlRole | null {
  if (!role) return null
  return member.role === 'viewer' && ROLE_RANK[role] > ROLE_RANK.viewer ? 'viewer' : role
}

/**
 * 不看单条策略、按空间角色决定的集合（与 SQLite authorize 的特例一致）：
 * 成员表所有成员都能读；视图表里没有云端归属的（内置视图）按空间角色。返回 undefined 表示走一般规则。
 */
export function mysqlFixedRole(collection: string, member: MysqlMember, hasOwnership: boolean): MysqlRole | undefined {
  if (collection === '/workspace-members') {
    return member.role === 'owner' ? 'owner' : member.role === 'admin' ? 'manager' : 'viewer'
  }
  if (collection === '/views' && !hasOwnership) {
    return member.role === 'owner' ? 'owner' : member.role === 'viewer' ? 'viewer' : 'manager'
  }
  return undefined
}

/**
 * 不看授权时，当前账号凭归属能拿到的权限（与 SQLite effectiveRole / roleChain 同一顺序）：
 * 创建者 → 对成员开放时的成员默认权限 → 继承上一级。拿不到返回 null，再由授权决定。
 * 没有策略的旧记录：只有 record_owners 记了创建者才按空间角色给权限（外部成员不给）；
 * 当前空间里完全没有归属的记录一律拒绝——它可能属于别的空间（插件、技能等全局表）。
 */
export function mysqlOwnershipRole(
  collection: string,
  recordId: string,
  sources: ReadonlyMap<string, ScopeSource>,
  accountId: string,
  member: MysqlMember,
): MysqlRole | null {
  const seen = new Set<string>()
  const walk = (currentCollection: string, currentId: string): MysqlRole | null => {
    const key = `${currentCollection}\t${currentId}`
    if (seen.has(key) || seen.size > 64) return null
    seen.add(key)
    const source = sources.get(currentCollection)
    const policy = source?.policies[currentId]
    if (!policy) {
      const legacyOwner = source?.legacyOwners?.[currentId]
      if (!legacyOwner) return null
      if (legacyOwner === accountId) return 'owner'
      if (member.memberKind !== 'member') return null
      return member.role === 'viewer' ? 'viewer' : 'editor'
    }
    if (policy.ownerAccountId && policy.ownerAccountId === accountId) return 'owner'
    if (policy.accessMode === 'members' && member.memberKind === 'member') return memberDefaultAccess(policy, member.role)
    if (policy.accessMode === 'inherit' && policy.parentRecordId) {
      return walk(policy.parentCollection || currentCollection, policy.parentRecordId)
    }
    return null
  }
  return walk(collection, recordId)
}

/** 与 SQLite AuthorizationService.resourceScope 同一套规则，数据来自 MySQL。 */
export function resolveRecordScope(
  collection: string,
  recordId: string,
  sources: ReadonlyMap<string, ScopeSource>,
): DataScope | null {
  const seen = new Set<string>()
  const walk = (currentCollection: string, currentId: string): DataScope | null => {
    const key = `${currentCollection}\t${currentId}`
    if (seen.has(key)) return null
    seen.add(key)
    const source = sources.get(currentCollection)
    const policy = source?.policies[currentId]
    if (policy?.accessMode === 'inherit' && policy.parentRecordId) {
      return walk(policy.parentCollection || currentCollection, policy.parentRecordId)
    }
    if (!policy) return source?.owners.has(currentId) ? 'workspace' : null
    if (policy.ownership === 'shared') return 'shared'
    if (policy.ownership === 'workspace' || policy.accessMode === 'members') return 'workspace'
    return 'personal'
  }
  return walk(collection, recordId)
}

/** 沿继承找到真正决定权限的那条策略。没有策略时返回 null。 */
export function effectiveScopePolicy(
  collection: string,
  recordId: string,
  sources: ReadonlyMap<string, ScopeSource>,
): ScopePolicy | null {
  const seen = new Set<string>()
  const walk = (currentCollection: string, currentId: string): ScopePolicy | null => {
    const key = `${currentCollection}\t${currentId}`
    if (seen.has(key)) return null
    seen.add(key)
    const policy = sources.get(currentCollection)?.policies[currentId]
    if (!policy) return null
    if (policy.accessMode === 'inherit' && policy.parentRecordId) {
      return walk(policy.parentCollection || currentCollection, policy.parentRecordId) ?? policy
    }
    return policy
  }
  return walk(collection, recordId)
}

/**
 * MySQL 已有归属时，当前账号能不能看见。
 * 没有策略的记录返回 true，调用方继续用原有规则。
 */
export function mysqlRecordVisible(
  collection: string,
  recordId: string,
  sources: ReadonlyMap<string, ScopeSource>,
  accountId: string,
  memberKind = 'member',
): boolean {
  const policy = effectiveScopePolicy(collection, recordId, sources)
  // 没有策略的旧记录（只有 record_owners）沿用空间可见，但只对内部成员；外部协作者和访客要靠授权。
  if (!policy) return memberKind === 'member'
  if (!policy.ownerAccountId || policy.ownerAccountId === accountId) return true
  // “对成员开放”只对内部成员开放；外部协作者和访客只能看到授权给他们的记录（由授权判断）。
  if (memberKind !== 'member') return false
  return policy.accessMode !== 'private' && policy.accessMode !== 'restricted'
}
