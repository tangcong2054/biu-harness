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

/**
 * 不看授权时，当前账号凭归属能拿到的权限（与 SQLite roleChain 同一顺序）：
 * 创建者 → 对成员开放时的成员默认权限 → 继承上一级。拿不到返回 null，再由授权决定。
 * 没有任何策略的记录（只有旧的 record_owners 或完全未知）按空间角色给默认权限。
 */
export function mysqlOwnershipRole(
  collection: string,
  recordId: string,
  sources: ReadonlyMap<string, ScopeSource>,
  accountId: string,
  member: MysqlMember,
): MysqlRole | null {
  const fallback = (): MysqlRole => {
    if (member.memberKind !== 'member') return 'viewer'
    if (member.role === 'owner' || member.role === 'admin') return 'manager'
    return member.role === 'viewer' ? 'viewer' : 'editor'
  }
  const seen = new Set<string>()
  const walk = (currentCollection: string, currentId: string): MysqlRole | null => {
    const key = `${currentCollection}\t${currentId}`
    if (seen.has(key) || seen.size > 64) return null
    seen.add(key)
    const source = sources.get(currentCollection)
    const policy = source?.policies[currentId]
    if (!policy) {
      const legacyOwner = source?.legacyOwners?.[currentId]
      if (legacyOwner && legacyOwner === accountId) return 'owner'
      return fallback()
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
  if (!policy) return true
  if (!policy.ownerAccountId || policy.ownerAccountId === accountId) return true
  // “对成员开放”只对内部成员开放；外部协作者和访客只能看到授权给他们的记录（由授权判断）。
  if (memberKind !== 'member') return false
  return policy.accessMode !== 'private' && policy.accessMode !== 'restricted'
}
