import type { Pool, RowDataPacket } from 'mysql2/promise'

export type AccessView = { id: string; filters?: Record<string, unknown>; filterTree?: unknown }
export type AccessRecord = { id: string } & Record<string, unknown>
type Scope = 'personal' | 'workspace' | 'shared'
export type AccessMatchers = {
  readRecord(workspaceId: string, collection: string, recordId: string): Promise<AccessRecord | null>
  memberView(viewId: string, member: AccessRecord, views: AccessView[]): boolean
  recordView(viewId: string, record: AccessRecord, views: AccessView[], scope: Scope | null, ownerId: string, grantedBy: string, collection: string): boolean
}

export function accessDenied() {
  return Object.assign(new Error('没有权限查看此资源的协作信息'), { status: 403, code: 'ACCESS_DETAILS_DENIED' })
}

/** 当前账号在一个集合上获得的授权：记录授权取最高角色，视图授权需再按视图条件逐条匹配。 */
export type CollectionGrants = {
  records: Record<string, string>
  views: Array<{ viewId: string; grantedBy: string; role: string }>
  savedViews: AccessView[]
}

const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 }

const readableRoles = new Set(['viewer', 'editor', 'manager', 'owner'])

type ChainRole = 'viewer' | 'editor' | 'manager' | 'owner'
export type RoleChainStep = { id: string; title: string; detail: string; role: ChainRole }

/** 与 host-account authorization.ts 的 memberAccessRole 同一规则（本包不能依赖 host-account）。 */
function memberAccessRole(policy: Record<string, unknown>, membership: unknown): ChainRole {
  if (membership === 'owner' || membership === 'admin') return 'manager'
  if (membership === 'viewer') return 'viewer'
  if (policy.ownership === 'workspace' || policy.member_default_role === 'editor') return 'editor'
  return 'viewer'
}

/** 请求级读取决策，不复用跨请求授权缓存，也不以空间管理角色替代私人记录授权。 */
export class MysqlAccessReader {
  private member: AccessRecord | null = null
  private views = new Map<string, AccessView[]>()
  private groups = new Map<string, boolean>()

  constructor(
    private pool: Pool,
    private database: string,
    private workspaceId: string,
    private accountId: string,
    private matchers?: AccessMatchers,
  ) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database)) throw new Error('invalid database')
  }

  private async rows(sql: string, params: unknown[]) {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params)
    return rows
  }

  private async init() {
    if (this.member) return
    if (!this.workspaceId || !this.accountId) throw accessDenied()
    const rows = await this.rows(
      `SELECT m.role, m.member_kind, m.created_at, m.display_name, a.name, a.email
       FROM \`${this.database}\`.workspace_members m JOIN \`${this.database}\`.accounts a ON a.id = m.account_id
       WHERE m.workspace_id = ? AND m.account_id = ?`,
      [this.workspaceId, this.accountId],
    )
    const row = rows[0]
    if (!row) throw accessDenied()
    this.member = {
      id: this.accountId, title: row.display_name || row.name || row.email,
      name: row.display_name || row.name, email: row.email, role: row.role,
      membershipKind: row.member_kind, joinedAt: row.created_at,
    }
  }

  private async savedViews(collection: string) {
    const cached = this.views.get(collection)
    if (cached) return cached
    const rows = await this.rows(
      `SELECT view_id, payload_json FROM \`${this.database}\`.saved_views WHERE workspace_id = ? AND collection = ?`,
      [this.workspaceId, collection],
    )
    const views: AccessView[] = []
    for (const row of rows) {
      try {
        const value = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
        if (value && typeof value === 'object' && !Array.isArray(value) && value.deletedAt == null) views.push({ ...value, id: String(row.view_id) })
      } catch {
        // 无效视图不能成为授权依据。
      }
    }
    this.views.set(collection, views)
    return views
  }

  private async subjectMatches(grant: Record<string, unknown>) {
    if (!readableRoles.has(String(grant.role))) return false
    if (grant.subject_type === 'account') return grant.subject_id === this.accountId
    if (grant.subject_type === 'workspace_role') return grant.subject_id === this.member?.role
    if (grant.subject_type === 'group') {
      const groupId = String(grant.subject_id)
      const cached = this.groups.get(groupId)
      if (cached !== undefined) return cached
      const rows = await this.rows(
        `SELECT 1 AS ok FROM \`${this.database}\`.workspace_group_members gm
         JOIN \`${this.database}\`.workspace_groups g ON g.id = gm.group_id
         WHERE g.workspace_id = ? AND gm.group_id = ? AND gm.account_id = ?`,
        [this.workspaceId, groupId, this.accountId],
      )
      this.groups.set(groupId, rows.length > 0)
      return rows.length > 0
    }
    if (grant.subject_type === 'member_view') {
      const id = String(grant.subject_id)
      if (id === 'builtin-all:/workspace-members') return true
      if (['member', 'external', 'guest'].some((kind) => id === `builtin-member:${kind}`)) {
        return id === `builtin-member:${this.member?.membershipKind}`
      }
      return Boolean(this.matchers?.memberView(id, this.member!, await this.savedViews('/workspace-members')))
    }
    return false
  }

  async record(collection: string, recordId: string) {
    if (!/^\/[^/\s]+$/.test(collection) || !recordId.trim()) throw accessDenied()
    await this.init()
    const result = await this.walk(collection, recordId, new Set())
    if (!result.allowed) throw accessDenied()
    return result.viewGrants
  }

  /**
   * 当前账号对这条记录的权限来源，与 SQLite 版 AuthorizationService.roleChain 同一规则：
   * 创建者 → 直接/成员组/成员视图/空间角色授权（取最高）→ 对成员开放 → 继承上一级。
   */
  async roleChain(collection: string, recordId: string): Promise<RoleChainStep[]> {
    if (!/^\/[^/\s]+$/.test(collection) || !recordId.trim()) return []
    await this.init()
    return this.chain(collection, recordId, new Set(), true)
  }

  private async chain(collection: string, recordId: string, visited: Set<string>, top: boolean): Promise<RoleChainStep[]> {
    const key = `${this.workspaceId}\t${collection}\t${recordId}`
    if (visited.has(key) || visited.size > 64) return []
    visited.add(key)
    const title = top ? '这条内容' : '上一级内容'
    const policies = await this.rows(
      `SELECT ownership, owner_account_id, access_mode, member_default_role, parent_collection, parent_record_id
       FROM \`${this.database}\`.resource_policies WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId, collection, recordId],
    )
    const policy = policies[0]
    if (!policy) {
      const owners = await this.rows(
        `SELECT owner_id FROM \`${this.database}\`.record_owners WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
        [this.workspaceId, collection, recordId],
      )
      const ownerId = String(owners[0]?.owner_id ?? '')
      if (!ownerId) return []
      if (ownerId === this.accountId) return [{ id: key, title, detail: '你是创建者', role: 'owner' }]
      return [{ id: key, title, detail: '沿用空间里的旧记录', role: this.member?.role === 'viewer' ? 'viewer' : 'editor' }]
    }
    if (String(policy.owner_account_id ?? '') === this.accountId) return [{ id: key, title, detail: '你是创建者', role: 'owner' }]
    const grants = await this.rows(
      `SELECT subject_type, subject_id, role FROM \`${this.database}\`.record_grants
       WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId, collection, recordId],
    )
    const matched: RowDataPacket[] = []
    for (const grant of grants) if (await this.subjectMatches(grant)) matched.push(grant)
    let best = ''
    for (const grant of matched) if ((ROLE_RANK[String(grant.role)] ?? 0) > (ROLE_RANK[best] ?? 0)) best = String(grant.role)
    if (best) {
      const at = (type: string) => matched.some((grant) => grant.subject_type === type && grant.role === best)
      const detail = at('account') ? '直接授权给你' : at('group') ? '通过成员组授权' : at('member_view') ? '通过成员视图授权' : '按空间角色授权'
      return [{ id: key, title, detail, role: best as ChainRole }]
    }
    if (policy.access_mode === 'members' && this.member?.membershipKind === 'member') {
      const role = memberAccessRole(policy, this.member.role)
      const detail = role === 'manager' ? '空间管理者默认可管理' : role === 'viewer' ? '查看者只能阅读' : '空间成员默认可编辑'
      return [{ id: key, title, detail, role }]
    }
    if (policy.access_mode === 'inherit' && policy.parent_record_id) {
      const parent = await this.chain(String(policy.parent_collection || collection), String(policy.parent_record_id), visited, false)
      if (!parent.length) return []
      return [{ id: key, title, detail: '权限继承自上一级', role: parent[parent.length - 1]!.role }, ...parent]
    }
    return []
  }

  /** 列表用：一次读出整个集合上与当前账号匹配的授权。不是成员时返回空，不授予任何访问。 */
  async collectionGrants(collection: string): Promise<CollectionGrants> {
    const empty: CollectionGrants = { records: {}, views: [], savedViews: [] }
    if (!/^\/[^/\s]+$/.test(collection)) return empty
    try {
      await this.init()
    } catch {
      return empty
    }
    const records: Record<string, string> = {}
    const recordGrants = await this.rows(
      `SELECT record_id, subject_type, subject_id, role FROM \`${this.database}\`.record_grants
       WHERE workspace_id = ? AND collection = ?`,
      [this.workspaceId, collection],
    )
    for (const grant of recordGrants) {
      if (!(await this.subjectMatches(grant))) continue
      const id = String(grant.record_id)
      const role = String(grant.role)
      if ((ROLE_RANK[role] ?? 0) > (ROLE_RANK[records[id] ?? ''] ?? 0)) records[id] = role
    }
    const views: CollectionGrants['views'] = []
    const viewGrants = await this.rows(
      `SELECT view_id, subject_type, subject_id, role, granted_by FROM \`${this.database}\`.view_grants
       WHERE workspace_id = ? AND collection = ?`,
      [this.workspaceId, collection],
    )
    for (const grant of viewGrants) {
      if (!(await this.subjectMatches(grant))) continue
      views.push({ viewId: String(grant.view_id), grantedBy: String(grant.granted_by ?? ''), role: String(grant.role) })
    }
    return { records, views, savedViews: views.length ? await this.savedViews(collection) : [] }
  }

  private async walk(collection: string, recordId: string, visited: Set<string>): Promise<{
    allowed: boolean; scope: Scope | null; viewGrants: RowDataPacket[]
    /** 生效策略（继承链顶端）是否对空间成员开放，以及它的拥有者；与 mysqlRecordVisible 同一规则。 */
    found: boolean; open: boolean; effectiveOwner: string
  }> {
    const denied = { allowed: false, scope: null, viewGrants: [], found: false, open: false, effectiveOwner: '' }
    const key = `${collection}\0${recordId}`
    if (visited.has(key) || visited.size >= 64) return denied
    visited.add(key)
    const policies = await this.rows(
      `SELECT ownership, owner_account_id, access_mode, parent_collection, parent_record_id
       FROM \`${this.database}\`.resource_policies WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId, collection, recordId],
    )
    const policy = policies[0]
    const owners = policy?.owner_account_id ? [] : await this.rows(
      `SELECT owner_id FROM \`${this.database}\`.record_owners WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId, collection, recordId],
    )
    const ownerId = String(policy?.owner_account_id || owners[0]?.owner_id || '')
    if (!policy && !ownerId) return denied
    let allowed = ownerId === this.accountId
    let scope: Scope | null = !policy ? 'workspace' : policy.ownership === 'shared' ? 'shared'
      : policy.ownership === 'workspace' || policy.access_mode === 'members' ? 'workspace' : 'personal'
    const grants = await this.rows(
      `SELECT subject_type, subject_id, role FROM \`${this.database}\`.record_grants
       WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId, collection, recordId],
    )
    for (const grant of grants) if (await this.subjectMatches(grant)) allowed = true
    if (policy?.access_mode === 'members' && this.member?.membershipKind === 'member') allowed = true
    let open = !policy || (policy.access_mode !== 'private' && policy.access_mode !== 'restricted')
    let effectiveOwner = policy ? String(policy.owner_account_id || '') : ''
    if (policy?.access_mode === 'inherit' && policy.parent_record_id) {
      const parent = await this.walk(String(policy.parent_collection || collection), String(policy.parent_record_id), visited)
      allowed ||= parent.allowed
      scope = parent.scope
      if (parent.found) {
        open = parent.open
        effectiveOwner = parent.effectiveOwner
      }
    }
    // 视图只能转授授权人自己看得到的记录：自己的，或对空间成员开放的。
    const granterCanSee = (granter: string) => Boolean(granter) && (open || !effectiveOwner || effectiveOwner === granter)
    const viewGrants = await this.rows(
      `SELECT view_id, subject_type, subject_id, role, granted_by FROM \`${this.database}\`.view_grants
       WHERE workspace_id = ? AND collection = ?`,
      [this.workspaceId, collection],
    )
    const applicable: RowDataPacket[] = []
    let record: AccessRecord | null | undefined
    for (const grant of viewGrants) {
      if (!readableRoles.has(String(grant.role))) continue
      const id = String(grant.view_id)
      let matches = id === `builtin-all:${collection}` && Boolean(grant.granted_by) && grant.granted_by === ownerId
      if (!id.startsWith('builtin-all:') && this.matchers && granterCanSee(String(grant.granted_by ?? ''))) {
        if (record === undefined) record = await this.matchers.readRecord(this.workspaceId, collection, recordId)
        matches = Boolean(record && this.matchers.recordView(id, record, [{ id: `builtin-all:${collection}` }, ...await this.savedViews(collection)], scope, ownerId, String(grant.granted_by ?? ''), collection))
      }
      if (!matches) continue
      applicable.push(grant)
      if (await this.subjectMatches(grant)) allowed = true
    }
    return { allowed, scope, viewGrants: applicable, found: true, open, effectiveOwner }
  }
}
