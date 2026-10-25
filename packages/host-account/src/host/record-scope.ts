export type DataScope = 'personal' | 'workspace' | 'shared'

export type ScopePolicy = {
  ownership: string
  accessMode: string
  parentCollection: string
  parentRecordId: string
  ownerAccountId?: string
}

export type ScopeSource = {
  policies: Record<string, ScopePolicy>
  owners: ReadonlySet<string>
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
): boolean {
  const policy = effectiveScopePolicy(collection, recordId, sources)
  if (!policy) return true
  if (!policy.ownerAccountId || policy.ownerAccountId === accountId) return true
  return policy.accessMode !== 'private' && policy.accessMode !== 'restricted'
}
