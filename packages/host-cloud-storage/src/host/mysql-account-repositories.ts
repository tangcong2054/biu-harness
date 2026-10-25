import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { resolveRuntimeRepositoryMode, type RuntimeRepositoryMode } from './mysql-runtime-repositories.ts'

const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type AccountControlMode = RuntimeRepositoryMode
export type AccountRow = {
  id: string
  name: string
  email: string
  passwordHash: string
  activeWorkspaceId: string
  mustChangePassword: boolean
  createdAt: number
}
export type WorkspaceRow = {
  id: string
  name: string
  ownerId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  createdAt: number
}
export type MemberRow = {
  id: string
  name: string
  display_name: string
  email: string
  role: string
  member_kind: 'member' | 'external' | 'guest'
  created_at: number
}
export type GrantSubject = 'account' | 'group' | 'workspace_role' | 'member_view'
export type GrantRole = 'viewer' | 'editor' | 'manager' | 'owner'
const PRESENCE_STALE_MS = 30_000

function databaseName(value: string) {
  if (!SAFE_DATABASE.test(value)) throw new Error(`unsafe MySQL database name: ${value}`)
  return `\`${value}\``
}

function mysqlJsonValue(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    // mysql2 may already decode a JSON string scalar to its plain string value.
    return value
  }
}

function accountRow(row: Record<string, unknown>): AccountRow {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    passwordHash: String(row.password_hash ?? ''),
    activeWorkspaceId: String(row.active_workspace_id ?? ''),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: Number(row.created_at) || 0,
  }
}

/** Online control-plane repository. Every tenant query is workspace scoped. */
export class MysqlAccountRepository {
  private readonly db: string
  private readonly operationsDb: string | null

  constructor(readonly pool: Pool, database: string, operationsDatabase?: string) {
    this.db = databaseName(database)
    this.operationsDb = operationsDatabase ? databaseName(operationsDatabase) : null
  }

  async isSuspended(accountId: string) {
    if (!this.operationsDb) return false
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT status FROM ${this.operationsDb}.ops_account_governance WHERE account_id = ?`,
      [accountId],
    )
    return rows[0]?.status === 'suspended'
  }

  async accountByEmail(email: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, email, password_hash, active_workspace_id, must_change_password, created_at
       FROM ${this.db}.accounts WHERE normalized_email = NULLIF(LOWER(TRIM(?)), '') LIMIT 1`,
      [email],
    )
    return rows[0] ? accountRow(rows[0]) : null
  }

  async accountById(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, email, password_hash, active_workspace_id, must_change_password, created_at
       FROM ${this.db}.accounts WHERE id = ?`,
      [id],
    )
    return rows[0] ? accountRow(rows[0]) : null
  }

  async createAccount(input: {
    id: string; name: string; email: string; passwordHash: string; token: string; createdAt: number
  }) {
    await this.pool.query(
      `INSERT INTO ${this.db}.accounts
       (id, name, token, password_hash, created_at, email, active_workspace_id, must_change_password, password_recall)
       VALUES (?, ?, ?, ?, ?, NULLIF(LOWER(TRIM(?)), ''), '', 0, '')`,
      [input.id, input.name, input.token, input.passwordHash, input.createdAt, input.email],
    )
    return (await this.accountById(input.id))!
  }

  async register(input: {
    accountId: string; name: string; email: string; passwordHash: string; accountToken: string;
    workspaceId: string; workspaceName: string; sessionId: string; sessionTokenHash: string;
    deviceName: string; expiresAt: number; now: number
  }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.accounts
         (id, name, token, password_hash, created_at, email, active_workspace_id, must_change_password, password_recall)
         VALUES (?, ?, ?, ?, ?, NULLIF(LOWER(TRIM(?)), ''), ?, 0, '')`,
        [input.accountId, input.name, input.accountToken, input.passwordHash, input.now, input.email, input.workspaceId],
      )
      await connection.query(
        `INSERT INTO ${this.db}.workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`,
        [input.workspaceId, input.workspaceName, input.accountId, input.now],
      )
      await connection.query(
        `INSERT INTO ${this.db}.workspace_members
         (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
         VALUES (?, ?, 'owner', ?, '', '', 'member')`,
        [input.workspaceId, input.accountId, input.now],
      )
      await connection.query(
        `INSERT INTO ${this.db}.auth_sessions
         (id, account_id, token_hash, device_name, expires_at, revoked_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [input.sessionId, input.accountId, input.sessionTokenHash, input.deviceName, input.expiresAt, input.now, input.now],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async accountByTokenHash(tokenHash: string, now = Date.now()) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT a.id, a.name, a.email, a.password_hash, a.active_workspace_id,
                a.must_change_password, a.created_at, s.id AS session_id
         FROM ${this.db}.auth_sessions s JOIN ${this.db}.accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL
           AND (s.expires_at IS NULL OR s.expires_at > ?) FOR UPDATE`,
        [tokenHash, now],
      )
      const row = rows[0]
      if (!row) {
        await connection.rollback()
        return null
      }
      await connection.query(`UPDATE ${this.db}.auth_sessions SET last_seen_at = ? WHERE id = ?`, [now, row.session_id])
      await connection.commit()
      return accountRow(row)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async openSession(input: {
    id: string; accountId: string; tokenHash: string; deviceName: string; expiresAt: number; now: number
  }) {
    await this.pool.query(
      `INSERT INTO ${this.db}.auth_sessions
       (id, account_id, token_hash, device_name, expires_at, revoked_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [input.id, input.accountId, input.tokenHash, input.deviceName, input.expiresAt, input.now, input.now],
    )
  }

  async revokeSession(tokenHash: string, now = Date.now()) {
    await this.pool.query(
      `UPDATE ${this.db}.auth_sessions SET revoked_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
      [now, tokenHash],
    )
  }

  async listSessions(accountId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, device_name, expires_at, revoked_at, created_at, last_seen_at
       FROM ${this.db}.auth_sessions WHERE account_id = ? ORDER BY created_at DESC`,
      [accountId],
    )
    return rows as Array<Record<string, unknown>>
  }

  async revokeSessionById(accountId: string, sessionId: string, now = Date.now()) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.auth_sessions SET revoked_at = ?
       WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
      [now, sessionId, accountId],
    )
    return result.affectedRows > 0
  }

  async changePassword(accountId: string, passwordHash: string, keepTokenHash: string, now = Date.now()) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `UPDATE ${this.db}.accounts SET password_hash = ?, must_change_password = 0,
         password_recall = '' WHERE id = ?`,
        [passwordHash, accountId],
      )
      await connection.query(
        `UPDATE ${this.db}.auth_sessions SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
        [now, accountId, keepTokenHash],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async membership(accountId: string, workspaceId: string): Promise<{
    role: WorkspaceRow['role']
    memberKind: MemberRow['member_kind']
  } | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT role, member_kind FROM ${this.db}.workspace_members
       WHERE workspace_id = ? AND account_id = ?`,
      [workspaceId, accountId],
    )
    const row = rows[0]
    const role = String(row?.role ?? '')
    if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') return null
    const memberKind = row?.member_kind === 'external' || row?.member_kind === 'guest' ? row.member_kind : 'member'
    return { role, memberKind }
  }

  async externallySharedRecords(accountId: string, workspaceId: string) {
    const membership = await this.membership(accountId, workspaceId)
    if (!membership) return []
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.collection, g.record_id, g.subject_id, MAX(g.created_at) AS created_at
       FROM ${this.db}.record_grants g
       JOIN ${this.db}.workspace_members m
         ON m.workspace_id = g.workspace_id
        AND m.account_id = g.subject_id
        AND m.member_kind IN ('external', 'guest')
       WHERE g.workspace_id = ? AND g.subject_type = 'account'
       GROUP BY g.collection, g.record_id, g.subject_id
       ORDER BY created_at DESC`,
      [workspaceId],
    )
    const visible = membership.role === 'owner' || membership.role === 'admin'
      ? rows
      : rows.filter((row) => String(row.subject_id) === accountId)
    return visible.map((row) => ({
      collection: String(row.collection),
      record_id: String(row.record_id),
    }))
  }

  async listWorkspaces(accountId: string): Promise<WorkspaceRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT w.id, w.name, w.owner_id, w.created_at, m.role
       FROM ${this.db}.workspace_members m JOIN ${this.db}.workspaces w ON w.id = m.workspace_id
       WHERE m.account_id = ? ORDER BY w.created_at`,
      [accountId],
    )
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), ownerId: String(row.owner_id),
      role: String(row.role) as WorkspaceRow['role'], createdAt: Number(row.created_at),
    }))
  }

  async createWorkspace(input: { id: string; ownerId: string; name: string; createdAt: number }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`,
        [input.id, input.name, input.ownerId, input.createdAt],
      )
      await connection.query(
        `INSERT INTO ${this.db}.workspace_members
         (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
         VALUES (?, ?, 'owner', ?, '', '', 'member')`,
        [input.id, input.ownerId, input.createdAt],
      )
      await connection.query(`UPDATE ${this.db}.accounts SET active_workspace_id = ? WHERE id = ?`, [input.id, input.ownerId])
      await connection.commit()
      return { ...input, role: 'owner' as const }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async setActiveWorkspace(accountId: string, workspaceId: string) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.accounts a SET active_workspace_id = ?
       WHERE a.id = ? AND EXISTS (
         SELECT 1 FROM ${this.db}.workspace_members m
         WHERE m.workspace_id = ? AND m.account_id = a.id
       )`,
      [workspaceId, accountId, workspaceId],
    )
    return result.affectedRows > 0
  }

  async renameWorkspace(actorId: string, workspaceId: string, name: string) {
    await this.requireManager(actorId, workspaceId)
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.workspaces SET name = ? WHERE id = ?`,
      [name, workspaceId],
    )
    if (!result.affectedRows) throw new Error('workspace not found')
    return (await this.listWorkspaces(actorId)).find((row) => row.id === workspaceId)!
  }

  async deleteWorkspace(actorId: string, workspaceId: string, confirmName: string) {
    await this.requireOwner(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT name FROM ${this.db}.workspaces WHERE id = ? FOR UPDATE`,
        [workspaceId],
      )
      if (!rows[0] || String(rows[0].name) !== confirmName) throw new Error('workspace confirmation does not match')
      const [sessions] = await connection.query<RowDataPacket[]>(
        `SELECT record_id FROM ${this.db}.record_owners
         WHERE workspace_id = ? AND collection = '/sessions'`,
        [workspaceId],
      )
      await connection.query(`DELETE FROM ${this.db}.mcp_credentials WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.mcp_audit_log WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.plugin_audit_log WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.guest_sessions WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.view_grants WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.record_grants WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.resource_policies WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.record_owners WHERE workspace_id = ?`, [workspaceId])
      await connection.query(
        `DELETE gm FROM ${this.db}.workspace_group_members gm
         JOIN ${this.db}.workspace_groups g ON g.id = gm.group_id WHERE g.workspace_id = ?`,
        [workspaceId],
      )
      await connection.query(`DELETE FROM ${this.db}.workspace_groups WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.workspace_invites WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.workspace_members WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.authz_revisions WHERE workspace_id = ?`, [workspaceId])
      await connection.query(`DELETE FROM ${this.db}.workspaces WHERE id = ?`, [workspaceId])
      await connection.query(
        `UPDATE ${this.db}.accounts SET active_workspace_id = ''
         WHERE active_workspace_id = ?`,
        [workspaceId],
      )
      await connection.commit()
      const next = (await this.listWorkspaces(actorId))[0]?.id ?? ''
      if (next) await this.setActiveWorkspace(actorId, next)
      return {
        id: workspaceId,
        deleted: true as const,
        sessionIds: sessions.map((row) => String(row.record_id)),
        activeWorkspaceId: next,
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async members(actorId: string, workspaceId: string): Promise<MemberRow[]> {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT a.id, COALESCE(NULLIF(a.name, ''), NULLIF(a.email, ''), '未设置') AS name,
              m.display_name, COALESCE(a.email, '') AS email, m.role, m.member_kind, m.created_at
       FROM ${this.db}.workspace_members m JOIN ${this.db}.accounts a ON a.id = m.account_id
       WHERE m.workspace_id = ? ORDER BY m.created_at`,
      [workspaceId],
    )
    return rows as MemberRow[]
  }

  async addMemberByEmail(actorId: string, workspaceId: string, email: string, now = Date.now()) {
    await this.requireManager(actorId, workspaceId)
    const account = await this.accountByEmail(email)
    if (!account) return null
    await this.writeMemberWithRevision(workspaceId, account.id, now)
    return this.members(actorId, workspaceId)
  }

  async addMember(actorId: string, workspaceId: string, accountId: string, now = Date.now()) {
    await this.requireManager(actorId, workspaceId)
    if (!(await this.accountById(accountId))) return null
    await this.writeMemberWithRevision(workspaceId, accountId, now)
    return this.members(actorId, workspaceId)
  }

  async updateMemberRole(actorId: string, workspaceId: string, accountId: string, role: WorkspaceRow['role']) {
    await this.requireOwner(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      if (role === 'owner' && accountId !== actorId) {
        await connection.query(
          `UPDATE ${this.db}.workspace_members SET role = 'admin' WHERE workspace_id = ? AND account_id = ?`,
          [workspaceId, actorId],
        )
        await connection.query(
          `UPDATE ${this.db}.workspaces SET owner_id = ? WHERE id = ?`,
          [accountId, workspaceId],
        )
      }
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE ${this.db}.workspace_members SET role = ? WHERE workspace_id = ? AND account_id = ?`,
        [role, workspaceId, accountId],
      )
      if (!result.affectedRows) throw new Error('workspace member not found')
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async removeMember(actorId: string, workspaceId: string, accountId: string) {
    await this.requireManager(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [target] = await connection.query<RowDataPacket[]>(
        `SELECT role FROM ${this.db}.workspace_members
         WHERE workspace_id = ? AND account_id = ? FOR UPDATE`,
        [workspaceId, accountId],
      )
      if (!target[0] || target[0].role === 'owner') throw new Error('workspace member cannot be removed')
      await connection.query(
        `DELETE gm FROM ${this.db}.workspace_group_members gm
         JOIN ${this.db}.workspace_groups g ON g.id = gm.group_id
         WHERE g.workspace_id = ? AND gm.account_id = ?`,
        [workspaceId, accountId],
      )
      await connection.query(
        `DELETE FROM ${this.db}.record_grants WHERE workspace_id = ? AND subject_type = 'account' AND subject_id = ?`,
        [workspaceId, accountId],
      )
      await connection.query(
        `DELETE FROM ${this.db}.view_grants WHERE workspace_id = ? AND subject_type = 'account' AND subject_id = ?`,
        [workspaceId, accountId],
      )
      await connection.query(
        `DELETE FROM ${this.db}.workspace_members WHERE workspace_id = ? AND account_id = ?`,
        [workspaceId, accountId],
      )
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async createInvite(input: {
    id: string; tokenHash: string; workspaceId: string; role: 'member' | 'viewer';
    expiresAt: number; actorId: string; now: number
  }) {
    await this.requireManager(input.actorId, input.workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.workspace_invites
       (id, token_hash, workspace_id, kind, role, collection, record_id, view_id, resource_role,
        expires_at, max_uses, use_count, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, 'workspace', ?, '', '', '', 'viewer', ?, 1, 0, ?, ?, NULL)`,
      [input.id, input.tokenHash, input.workspaceId, input.role, input.expiresAt, input.actorId, input.now],
    )
  }

  async revokeInvite(actorId: string, workspaceId: string, inviteId: string, now = Date.now()) {
    await this.requireManager(actorId, workspaceId)
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.workspace_invites SET revoked_at = ?
       WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
      [now, inviteId, workspaceId],
    )
    if (!result.affectedRows) throw new Error('workspace invite not found')
  }

  async acceptInvite(accountId: string, tokenHash: string, now = Date.now()) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, workspace_id, role, expires_at, max_uses, use_count, revoked_at
         FROM ${this.db}.workspace_invites
         WHERE token_hash = ? AND kind = 'workspace' FOR UPDATE`,
        [tokenHash],
      )
      const invite = rows[0]
      if (!invite || invite.revoked_at || Number(invite.expires_at) <= now
        || Number(invite.use_count) >= Number(invite.max_uses)) {
        throw new Error('workspace invite is invalid or expired')
      }
      await connection.query(
        `INSERT INTO ${this.db}.workspace_members
         (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
         VALUES (?, ?, ?, ?, '', '', 'member')
         ON DUPLICATE KEY UPDATE
         role = IF(member_kind = 'external', VALUES(role), role),
         member_kind = IF(member_kind = 'external', 'member', member_kind)`,
        [invite.workspace_id, accountId, invite.role, now],
      )
      await connection.query(
        `UPDATE ${this.db}.workspace_invites SET use_count = use_count + 1 WHERE id = ?`,
        [invite.id],
      )
      await connection.query(
        `UPDATE ${this.db}.accounts SET active_workspace_id = ? WHERE id = ?`,
        [invite.workspace_id, accountId],
      )
      await this.bumpRevision(connection, String(invite.workspace_id), '*')
      await connection.commit()
      return { workspaceId: String(invite.workspace_id), role: String(invite.role) }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async createGuestInvite(input: {
    id: string; tokenHash: string; actorId: string; workspaceId: string;
    collection: string; recordId: string; viewId: string; role: 'viewer' | 'editor';
    expiresAt: number; now: number
  }) {
    if (input.viewId) await this.requireManager(input.actorId, input.workspaceId)
    else await this.requireGrantManager(input.actorId, input.workspaceId, input.collection, input.recordId)
    await this.pool.query(
      `INSERT INTO ${this.db}.workspace_invites
       (id, token_hash, workspace_id, kind, role, collection, record_id, view_id, resource_role,
        expires_at, max_uses, use_count, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, 'guest', 'viewer', ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)`,
      [
        input.id, input.tokenHash, input.workspaceId, input.collection, input.recordId,
        input.viewId, input.role, input.expiresAt, input.actorId, input.now,
      ],
    )
  }

  async acceptGuestInvite(input: {
    tokenHash: string; accountId: string; sessionId: string; sessionTokenHash: string;
    legacyToken: string; name: string; now: number
  }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM ${this.db}.workspace_invites
         WHERE token_hash = ? AND kind = 'guest' FOR UPDATE`,
        [input.tokenHash],
      )
      const invite = rows[0]
      if (!invite || invite.revoked_at || Number(invite.expires_at) <= input.now
        || Number(invite.use_count) >= Number(invite.max_uses)) {
        throw new Error('guest invite is invalid or expired')
      }
      await connection.query(
        `INSERT INTO ${this.db}.accounts
         (id, name, token, password_hash, created_at, email, active_workspace_id, must_change_password, password_recall)
         VALUES (?, ?, ?, '', ?, NULL, ?, 0, '')`,
        [input.accountId, input.name, input.legacyToken, input.now, invite.workspace_id],
      )
      await connection.query(
        `INSERT INTO ${this.db}.workspace_members
         (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
         VALUES (?, ?, 'viewer', ?, ?, '', 'guest')`,
        [invite.workspace_id, input.accountId, input.now, input.name],
      )
      await connection.query(
        `INSERT INTO ${this.db}.guest_sessions
         (id, account_id, workspace_id, expires_at, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [input.sessionId, input.accountId, invite.workspace_id, invite.expires_at, input.now, input.now],
      )
      await connection.query(
        `INSERT INTO ${this.db}.auth_sessions
         (id, account_id, token_hash, device_name, expires_at, revoked_at, created_at, last_seen_at)
         VALUES (?, ?, ?, 'guest', ?, NULL, ?, ?)`,
        [input.sessionId, input.accountId, input.sessionTokenHash, invite.expires_at, input.now, input.now],
      )
      const table = invite.view_id ? 'view_grants' : 'record_grants'
      const resourceColumn = invite.view_id ? 'view_id' : 'record_id'
      const resourceId = invite.view_id || invite.record_id
      await connection.query(
        `INSERT INTO ${this.db}.${table}
         (workspace_id, collection, ${resourceColumn}, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, 'account', ?, ?, ?, ?)`,
        [
          invite.workspace_id, invite.collection, resourceId, input.accountId,
          invite.resource_role, invite.created_by, input.now,
        ],
      )
      await connection.query(
        `UPDATE ${this.db}.workspace_invites SET use_count = use_count + 1 WHERE id = ?`,
        [invite.id],
      )
      await this.bumpRevision(connection, String(invite.workspace_id), String(invite.collection))
      await connection.commit()
      return {
        id: input.accountId,
        name: input.name,
        email: '',
        workspaceId: String(invite.workspace_id),
        expiresAt: Number(invite.expires_at),
        collection: String(invite.collection),
        recordId: String(invite.record_id),
        viewId: String(invite.view_id),
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async createGroup(input: { id: string; actorId: string; workspaceId: string; name: string; now: number }) {
    await this.requireManager(input.actorId, input.workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.workspace_groups (id, workspace_id, name, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.id, input.workspaceId, input.name, input.actorId, input.now],
    )
  }

  async groups(actorId: string, workspaceId: string) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.id, g.name, g.created_by, g.created_at, COUNT(gm.account_id) AS member_count
       FROM ${this.db}.workspace_groups g
       LEFT JOIN ${this.db}.workspace_group_members gm ON gm.group_id = g.id
       WHERE g.workspace_id = ? GROUP BY g.id, g.name, g.created_by, g.created_at ORDER BY g.created_at`,
      [workspaceId],
    )
    return rows
  }

  async groupMembers(actorId: string, workspaceId: string, groupId: string) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT a.id, COALESCE(NULLIF(m.display_name, ''), NULLIF(a.name, ''), '未设置') AS name,
              COALESCE(a.email, '') AS email
       FROM ${this.db}.workspace_group_members gm
       JOIN ${this.db}.workspace_groups g ON g.id = gm.group_id AND g.workspace_id = ?
       JOIN ${this.db}.accounts a ON a.id = gm.account_id
       LEFT JOIN ${this.db}.workspace_members m
         ON m.workspace_id = g.workspace_id AND m.account_id = a.id
       WHERE gm.group_id = ? ORDER BY gm.created_at`,
      [workspaceId, groupId],
    )
    return rows as Array<Record<string, unknown>>
  }

  async renameGroup(actorId: string, workspaceId: string, groupId: string, name: string) {
    await this.requireManager(actorId, workspaceId)
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.workspace_groups SET name = ? WHERE id = ? AND workspace_id = ?`,
      [name, groupId, workspaceId],
    )
    if (!result.affectedRows) throw new Error('group not found')
  }

  async deleteGroup(actorId: string, workspaceId: string, groupId: string) {
    await this.requireManager(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `DELETE FROM ${this.db}.record_grants
         WHERE workspace_id = ? AND subject_type = 'group' AND subject_id = ?`,
        [workspaceId, groupId],
      )
      await connection.query(`DELETE FROM ${this.db}.workspace_group_members WHERE group_id = ?`, [groupId])
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.db}.workspace_groups WHERE id = ? AND workspace_id = ?`,
        [groupId, workspaceId],
      )
      if (!result.affectedRows) throw new Error('group not found')
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async addGroupMember(actorId: string, workspaceId: string, groupId: string, accountId: string, now = Date.now()) {
    await this.requireManager(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [groups] = await connection.query<RowDataPacket[]>(
        `SELECT 1 AS ok FROM ${this.db}.workspace_groups WHERE id = ? AND workspace_id = ?`,
        [groupId, workspaceId],
      )
      const [members] = await connection.query<RowDataPacket[]>(
        `SELECT 1 AS ok FROM ${this.db}.workspace_members WHERE workspace_id = ? AND account_id = ?`,
        [workspaceId, accountId],
      )
      if (!groups[0] || !members[0]) throw new Error('group or workspace member not found')
      await connection.query(
        `INSERT INTO ${this.db}.workspace_group_members (group_id, account_id, created_at)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE created_at = created_at`,
        [groupId, accountId, now],
      )
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async removeGroupMember(actorId: string, workspaceId: string, groupId: string, accountId: string) {
    await this.requireManager(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE gm FROM ${this.db}.workspace_group_members gm
         JOIN ${this.db}.workspace_groups g ON g.id = gm.group_id
         WHERE g.workspace_id = ? AND gm.group_id = ? AND gm.account_id = ?`,
        [workspaceId, groupId, accountId],
      )
      if (!result.affectedRows) throw new Error('group member not found')
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async claimRecord(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string; now: number
  }) {
    await this.requireMember(input.actorId, input.workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.record_owners
       (workspace_id, collection, record_id, owner_id, version, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [input.workspaceId, input.collection, input.recordId, input.actorId, input.now],
    )
  }

  async ownerWorkspaceIds(collection: string, recordId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT workspace_id FROM ${this.db}.record_owners WHERE collection = ? AND record_id = ?`,
      [collection, recordId],
    )
    return rows.map((row) => String(row.workspace_id))
  }

  async collectionScopeSources(workspaceId: string, collection: string) {
    const [policies] = await this.pool.query<RowDataPacket[]>(
      `SELECT record_id, ownership, access_mode, parent_collection, parent_record_id, owner_account_id
       FROM ${this.db}.resource_policies WHERE workspace_id = ? AND collection = ?`,
      [workspaceId, collection],
    )
    const [owners] = await this.pool.query<RowDataPacket[]>(
      `SELECT record_id FROM ${this.db}.record_owners WHERE workspace_id = ? AND collection = ?`,
      [workspaceId, collection],
    )
    const policyRows: Record<string, {
      ownership: string
      accessMode: string
      parentCollection: string
      parentRecordId: string
      ownerAccountId: string
    }> = {}
    for (const row of policies) {
      policyRows[String(row.record_id)] = {
        ownership: String(row.ownership ?? ''),
        accessMode: String(row.access_mode ?? ''),
        parentCollection: String(row.parent_collection ?? ''),
        parentRecordId: String(row.parent_record_id ?? ''),
        ownerAccountId: String(row.owner_account_id ?? ''),
      }
    }
    return {
      policies: policyRows,
      owners: owners.map((row) => String(row.record_id)),
    }
  }

  async ownedRecordIds(workspaceId: string, collection: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT record_id FROM ${this.db}.record_owners WHERE workspace_id = ? AND collection = ?`,
      [workspaceId, collection],
    )
    return rows.map((row) => String(row.record_id))
  }

  async tenantForRecord(collection: string, recordId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT workspace_id, owner_id FROM ${this.db}.record_owners
       WHERE collection = ? AND record_id = ? LIMIT 2`,
      [collection, recordId],
    )
    if (rows.length !== 1) return null
    return { workspaceId: String(rows[0]!.workspace_id), accountId: String(rows[0]!.owner_id) }
  }

  async sync(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string;
    field: string; value: unknown; expectedVersion: number; now: number
  }) {
    await this.requireMember(input.actorId, input.workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [locks] = await connection.query<RowDataPacket[]>(
        `SELECT account_id, expires_at FROM ${this.db}.edit_locks
         WHERE workspace_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [input.workspaceId, input.collection, input.recordId],
      )
      if (locks[0] && Number(locks[0].expires_at) > input.now && locks[0].account_id !== input.actorId) {
        throw new Error('record is locked by another account')
      }
      const [owners] = await connection.query<RowDataPacket[]>(
        `SELECT owner_id, version FROM ${this.db}.record_owners
         WHERE workspace_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [input.workspaceId, input.collection, input.recordId],
      )
      const current = owners[0]
      const version = Number(current?.version ?? 0)
      if (version !== input.expectedVersion) throw new Error(`version conflict: expected ${input.expectedVersion}, actual ${version}`)
      if (current && !(await this.canWriteRecord(connection, input))) throw new Error('permission denied')
      const next = version + 1
      if (current) {
        await connection.query(
          `UPDATE ${this.db}.record_owners SET version = ?, updated_at = ?
           WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
          [next, input.now, input.workspaceId, input.collection, input.recordId],
        )
      } else {
        await connection.query(
          `INSERT INTO ${this.db}.record_owners
           (workspace_id, collection, record_id, owner_id, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [input.workspaceId, input.collection, input.recordId, input.actorId, next, input.now],
        )
      }
      const [inserted] = await connection.query<ResultSetHeader>(
        `INSERT INTO ${this.db}.sync_ops
         (workspace_id, collection, record_id, field, value_json, version, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.workspaceId, input.collection, input.recordId, input.field,
          JSON.stringify(input.value ?? null), next, input.actorId, input.now,
        ],
      )
      await connection.commit()
      return {
        id: Number(inserted.insertId), workspaceId: input.workspaceId, collection: input.collection,
        recordId: input.recordId, field: input.field, value: input.value ?? null,
        version: next, authorId: input.actorId, createdAt: input.now,
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async opsSince(actorId: string, workspaceId: string, after = 0, visible = false) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT o.id, o.workspace_id, o.collection, o.record_id, o.field, o.value_json,
              o.version, o.author_id, o.created_at
       FROM ${this.db}.sync_ops o
       WHERE o.workspace_id = ? AND o.id > ?
         ${visible ? `AND (
           EXISTS(SELECT 1 FROM ${this.db}.resource_policies p
             WHERE p.workspace_id = o.workspace_id AND p.collection = o.collection
               AND p.record_id = o.record_id AND p.owner_account_id = ?)
           OR EXISTS(SELECT 1 FROM ${this.db}.record_grants g
             WHERE g.workspace_id = o.workspace_id AND g.collection = o.collection
               AND g.record_id = o.record_id AND (
                 (g.subject_type = 'account' AND g.subject_id = ?)
                 OR (g.subject_type = 'group' AND EXISTS(
                   SELECT 1 FROM ${this.db}.workspace_group_members gm
                   WHERE gm.group_id = g.subject_id AND gm.account_id = ?))
               ))
           OR EXISTS(SELECT 1 FROM ${this.db}.resource_policies p
             JOIN ${this.db}.workspace_members m
               ON m.workspace_id = p.workspace_id AND m.account_id = ? AND m.member_kind = 'member'
             WHERE p.workspace_id = o.workspace_id AND p.collection = o.collection
               AND p.record_id = o.record_id AND p.access_mode = 'members')
           OR NOT EXISTS(SELECT 1 FROM ${this.db}.resource_policies p
             WHERE p.workspace_id = o.workspace_id AND p.collection = o.collection AND p.record_id = o.record_id)
         )` : ''}
       ORDER BY o.id LIMIT 200`,
      visible ? [workspaceId, after, actorId, actorId, actorId, actorId] : [workspaceId, after],
    )
    return rows.map((row) => ({
      id: Number(row.id), workspaceId: String(row.workspace_id), collection: String(row.collection),
      recordId: String(row.record_id), field: String(row.field),
      value: mysqlJsonValue(row.value_json),
      version: Number(row.version), authorId: String(row.author_id), createdAt: Number(row.created_at),
    }))
  }

  async acquireLock(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string; ttlMs: number; now: number
  }) {
    await this.requireMember(input.actorId, input.workspaceId)
    const expiresAt = input.now + Math.max(1000, input.ttlMs)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT account_id, expires_at FROM ${this.db}.edit_locks
         WHERE workspace_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [input.workspaceId, input.collection, input.recordId],
      )
      if (rows[0] && Number(rows[0].expires_at) > input.now && rows[0].account_id !== input.actorId) {
        throw new Error('record is locked by another account')
      }
      await connection.query(
        `INSERT INTO ${this.db}.edit_locks
         (workspace_id, collection, record_id, account_id, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), expires_at = VALUES(expires_at)`,
        [input.workspaceId, input.collection, input.recordId, input.actorId, expiresAt],
      )
      await connection.commit()
      return { ...input, expiresAt }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async releaseLock(actorId: string, workspaceId: string, collection: string, recordId: string) {
    await this.requireMember(actorId, workspaceId)
    await this.pool.query(
      `DELETE FROM ${this.db}.edit_locks
       WHERE workspace_id = ? AND collection = ? AND record_id = ? AND account_id = ?`,
      [workspaceId, collection, recordId, actorId],
    )
  }

  async pulse(actorId: string, workspaceId: string, collection: string, recordId: string, now = Date.now()) {
    await this.requireMember(actorId, workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.presence (workspace_id, account_id, collection, record_id, seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE collection = VALUES(collection), record_id = VALUES(record_id), seen_at = VALUES(seen_at)`,
      [workspaceId, actorId, collection, recordId, now],
    )
    return this.presence(actorId, workspaceId, now)
  }

  async presence(actorId: string, workspaceId: string, now = Date.now()) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.workspace_id, p.account_id,
              COALESCE(NULLIF(m.display_name, ''), NULLIF(a.name, ''), '未设置') AS name,
              p.collection, p.record_id, p.seen_at
       FROM ${this.db}.presence p JOIN ${this.db}.accounts a ON a.id = p.account_id
       JOIN ${this.db}.workspace_members m
         ON m.workspace_id = p.workspace_id AND m.account_id = p.account_id
       WHERE p.workspace_id = ? AND p.seen_at >= ? ORDER BY p.seen_at DESC`,
      [workspaceId, now - PRESENCE_STALE_MS],
    )
    return rows
  }

  async attachPolicy(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string;
    ownership: 'personal' | 'workspace' | 'shared';
    accessMode: 'inherit' | 'private' | 'members' | 'restricted';
    memberDefaultRole?: 'viewer' | 'editor'; parentCollection?: string; parentRecordId?: string; now: number
  }) {
    await this.requireMember(input.actorId, input.workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.record_owners
         (workspace_id, collection, record_id, owner_id, version, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE owner_id = owner_id`,
        [input.workspaceId, input.collection, input.recordId, input.actorId, input.now],
      )
      await connection.query(
        `INSERT INTO ${this.db}.resource_policies
         (workspace_id, collection, record_id, ownership, owner_account_id, access_mode,
          member_default_role, parent_collection, parent_record_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE record_id = record_id`,
        [
          input.workspaceId, input.collection, input.recordId, input.ownership, input.actorId,
          input.accessMode, input.memberDefaultRole ?? 'viewer', input.parentCollection ?? '',
          input.parentRecordId ?? '', input.actorId, input.now,
        ],
      )
      await connection.query(
        `INSERT INTO ${this.db}.record_grants
         (workspace_id, collection, record_id, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, 'account', ?, 'owner', ?, ?)
         ON DUPLICATE KEY UPDATE role = 'owner', granted_by = VALUES(granted_by), created_at = VALUES(created_at)`,
        [input.workspaceId, input.collection, input.recordId, input.actorId, input.actorId, input.now],
      )
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async grantRecord(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string;
    subjectType: GrantSubject; subjectId: string; role: GrantRole; now: number
  }) {
    await this.requireGrantManager(input.actorId, input.workspaceId, input.collection, input.recordId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.record_grants
         (workspace_id, collection, record_id, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by), created_at = VALUES(created_at)`,
        [input.workspaceId, input.collection, input.recordId, input.subjectType, input.subjectId, input.role, input.actorId, input.now],
      )
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async revokeRecordGrant(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string;
    subjectType: GrantSubject; subjectId: string
  }) {
    await this.requireGrantManager(input.actorId, input.workspaceId, input.collection, input.recordId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.db}.record_grants
         WHERE workspace_id = ? AND collection = ? AND record_id = ? AND subject_type = ? AND subject_id = ?`,
        [input.workspaceId, input.collection, input.recordId, input.subjectType, input.subjectId],
      )
      if (!result.affectedRows) throw new Error('record grant not found')
      if (input.subjectType === 'account') {
        await this.cleanupExternalMembership(connection, input.workspaceId, input.subjectId)
      }
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async recordGrants(actorId: string, workspaceId: string, collection: string, recordId: string) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.subject_type, g.subject_id, g.role, g.granted_by, g.created_at,
              COALESCE(a.name, '') AS name, COALESCE(a.email, '') AS email
       FROM ${this.db}.record_grants g
       LEFT JOIN ${this.db}.accounts a
         ON g.subject_type = 'account' AND a.id = g.subject_id
       WHERE g.workspace_id = ? AND g.collection = ? AND g.record_id = ?
       ORDER BY g.created_at`,
      [workspaceId, collection, recordId],
    )
    return rows as Array<Record<string, unknown>>
  }

  async recordAccess(actorId: string, workspaceId: string, collection: string, recordId: string) {
    await this.requireMember(actorId, workspaceId)
    const [policies] = await this.pool.query<RowDataPacket[]>(
      `SELECT ownership, owner_account_id, access_mode, member_default_role,
              parent_collection, parent_record_id
       FROM ${this.db}.resource_policies
       WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [workspaceId, collection, recordId],
    )
    const [grants] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.subject_type, g.subject_id, g.role, g.granted_by, g.created_at,
              COALESCE(a.name, '') AS name, COALESCE(a.email, '') AS email,
              COALESCE(m.member_kind, '') AS member_kind, COALESCE(wg.name, '') AS group_name
       FROM ${this.db}.record_grants g
       LEFT JOIN ${this.db}.accounts a ON g.subject_type = 'account' AND a.id = g.subject_id
       LEFT JOIN ${this.db}.workspace_members m
         ON m.workspace_id = g.workspace_id AND m.account_id = a.id
       LEFT JOIN ${this.db}.workspace_groups wg
         ON g.subject_type = 'group' AND wg.id = g.subject_id AND wg.workspace_id = g.workspace_id
       WHERE g.workspace_id = ? AND g.collection = ? AND g.record_id = ?
       ORDER BY g.created_at`,
      [workspaceId, collection, recordId],
    )
    const [views] = await this.pool.query<RowDataPacket[]>(
      `SELECT view_id, subject_type, subject_id, role, granted_by, created_at
       FROM ${this.db}.view_grants WHERE workspace_id = ? AND collection = ?
       ORDER BY created_at`,
      [workspaceId, collection],
    )
    return { policy: policies[0] ?? null, grants, viewGrants: views }
  }

  async shareRecordWithEmail(input: {
    actorId: string; workspaceId: string; collection: string; recordId: string;
    email: string; role: GrantRole; collaboratorKind: 'internal' | 'external'; now: number
  }) {
    await this.requireGrantManager(input.actorId, input.workspaceId, input.collection, input.recordId)
    const target = await this.accountByEmail(input.email)
    if (!target) return null
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [memberships] = await connection.query<RowDataPacket[]>(
        `SELECT member_kind FROM ${this.db}.workspace_members
         WHERE workspace_id = ? AND account_id = ? FOR UPDATE`,
        [input.workspaceId, target.id],
      )
      const membership = memberships[0]
      if (input.collaboratorKind === 'internal' && membership?.member_kind !== 'member') {
        throw new Error('internal collaborator must be a workspace member')
      }
      if (input.collaboratorKind === 'external') {
        if (membership?.member_kind === 'member') throw new Error('account is already an internal member')
        if (membership?.member_kind === 'guest') throw new Error('guest cannot become external collaborator')
        if (!membership) {
          await connection.query(
            `INSERT INTO ${this.db}.workspace_members
             (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
             VALUES (?, ?, 'member', ?, '', '', 'external')`,
            [input.workspaceId, target.id, input.now],
          )
        }
      }
      await connection.query(
        `INSERT INTO ${this.db}.record_grants
         (workspace_id, collection, record_id, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, 'account', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by), created_at = VALUES(created_at)`,
        [
          input.workspaceId, input.collection, input.recordId, target.id,
          input.role, input.actorId, input.now,
        ],
      )
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
      return target
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async grantView(input: {
    actorId: string; workspaceId: string; collection: string; viewId: string;
    subjectType: 'account' | 'member_view'; subjectId: string; role: GrantRole; now: number
  }) {
    await this.requireManager(input.actorId, input.workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.view_grants
         (workspace_id, collection, view_id, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by), created_at = VALUES(created_at)`,
        [input.workspaceId, input.collection, input.viewId, input.subjectType, input.subjectId, input.role, input.actorId, input.now],
      )
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async shareViewWithEmail(input: {
    actorId: string; workspaceId: string; collection: string; viewId: string;
    email: string; role: GrantRole; collaboratorKind: 'internal' | 'external'; now: number
  }) {
    await this.requireManager(input.actorId, input.workspaceId)
    const target = await this.accountByEmail(input.email)
    if (!target) return null
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [memberships] = await connection.query<RowDataPacket[]>(
        `SELECT member_kind FROM ${this.db}.workspace_members
         WHERE workspace_id = ? AND account_id = ? FOR UPDATE`,
        [input.workspaceId, target.id],
      )
      const membership = memberships[0]
      if (input.collaboratorKind === 'internal' && membership?.member_kind !== 'member') {
        throw new Error('internal collaborator must be a workspace member')
      }
      if (input.collaboratorKind === 'external') {
        if (membership?.member_kind === 'member') throw new Error('account is already an internal member')
        if (membership?.member_kind === 'guest') throw new Error('guest cannot become external collaborator')
        if (!membership) {
          await connection.query(
            `INSERT INTO ${this.db}.workspace_members
             (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
             VALUES (?, ?, 'member', ?, '', '', 'external')`,
            [input.workspaceId, target.id, input.now],
          )
        }
      }
      await connection.query(
        `INSERT INTO ${this.db}.view_grants
         (workspace_id, collection, view_id, subject_type, subject_id, role, granted_by, created_at)
         VALUES (?, ?, ?, 'account', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by), created_at = VALUES(created_at)`,
        [input.workspaceId, input.collection, input.viewId, target.id, input.role, input.actorId, input.now],
      )
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
      return target
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async viewAccess(actorId: string, workspaceId: string, collection: string, viewId: string) {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.subject_type, g.subject_id, g.role, g.granted_by, g.created_at,
              COALESCE(a.name, '') AS name, COALESCE(a.email, '') AS email,
              COALESCE(m.member_kind, '') AS member_kind
       FROM ${this.db}.view_grants g
       LEFT JOIN ${this.db}.accounts a ON g.subject_type = 'account' AND a.id = g.subject_id
       LEFT JOIN ${this.db}.workspace_members m
         ON m.workspace_id = g.workspace_id AND m.account_id = a.id
       WHERE g.workspace_id = ? AND g.collection = ? AND g.view_id = ?
       ORDER BY g.created_at`,
      [workspaceId, collection, viewId],
    )
    return { viewId, grants: rows }
  }

  async revokeView(input: {
    actorId: string; workspaceId: string; collection: string; viewId: string;
    subjectType: 'account' | 'member_view'; subjectId: string
  }) {
    await this.requireManager(input.actorId, input.workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.db}.view_grants
         WHERE workspace_id = ? AND collection = ? AND view_id = ? AND subject_type = ? AND subject_id = ?`,
        [input.workspaceId, input.collection, input.viewId, input.subjectType, input.subjectId],
      )
      if (!result.affectedRows) throw new Error('view grant not found')
      if (input.subjectType === 'account') {
        await this.cleanupExternalMembership(connection, input.workspaceId, input.subjectId)
      }
      await this.bumpRevision(connection, input.workspaceId, input.collection)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async workspaceProfile(accountId: string, workspaceId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(a.email, '') AS email, m.display_name AS name, m.avatar
       FROM ${this.db}.workspace_members m JOIN ${this.db}.accounts a ON a.id = m.account_id
       WHERE m.workspace_id = ? AND m.account_id = ?`,
      [workspaceId, accountId],
    )
    if (!rows[0]) throw new Error('workspace membership required')
    return {
      workspaceId,
      email: String(rows[0].email ?? ''),
      name: String(rows[0].name ?? ''),
      avatar: String(rows[0].avatar ?? ''),
    }
  }

  async saveWorkspaceProfile(accountId: string, workspaceId: string, patch: { name?: string; avatar?: string }) {
    const current = await this.workspaceProfile(accountId, workspaceId)
    const name = patch.name === undefined ? current.name : patch.name
    const avatar = patch.avatar === undefined ? current.avatar : patch.avatar
    await this.pool.query(
      `UPDATE ${this.db}.workspace_members SET display_name = ?, avatar = ?
       WHERE workspace_id = ? AND account_id = ?`,
      [name, avatar, workspaceId, accountId],
    )
    return { ...current, name, avatar }
  }

  async issueMcpCredential(input: {
    id: string; tokenHash: string; accountId: string; workspaceId: string;
    allowedTools: string[]; expiresAt: number; now: number
  }) {
    await this.requireMember(input.accountId, input.workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.mcp_credentials
       (id, token_hash, account_id, workspace_id, allowed_tools, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        input.id, input.tokenHash, input.accountId, input.workspaceId,
        JSON.stringify(input.allowedTools), input.expiresAt, input.now,
      ],
    )
  }

  async listMcpCredentials(accountId: string, workspaceId: string) {
    await this.requireMember(accountId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, workspace_id, allowed_tools, expires_at, revoked_at, created_at
       FROM ${this.db}.mcp_credentials
       WHERE account_id = ? AND workspace_id = ? ORDER BY created_at DESC`,
      [accountId, workspaceId],
    )
    return rows.map((row) => ({
      ...row,
      allowed_tools: Array.isArray(row.allowed_tools)
        ? row.allowed_tools
        : JSON.parse(String(row.allowed_tools || '[]')),
    }))
  }

  async revokeMcpCredential(accountId: string, credentialId: string, now = Date.now()) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.db}.mcp_credentials SET revoked_at = ?
       WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
      [now, credentialId, accountId],
    )
    return result.affectedRows > 0
  }

  async listMcpAudit(accountId: string, workspaceId: string, limit = 100) {
    await this.requireManager(accountId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, credential_id, account_id, workspace_id, tool_name, success, created_at
       FROM ${this.db}.mcp_audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`,
      [workspaceId, Math.max(1, Math.min(500, limit))],
    )
    return rows
  }

  async resolveMcpCredential(tokenHash: string, now = Date.now()) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id, c.account_id, c.workspace_id, c.allowed_tools, c.expires_at, c.revoked_at, m.role
       FROM ${this.db}.mcp_credentials c
       JOIN ${this.db}.workspace_members m
         ON m.workspace_id = c.workspace_id AND m.account_id = c.account_id
       WHERE c.token_hash = ? AND c.revoked_at IS NULL
         AND (c.expires_at IS NULL OR c.expires_at > ?)`,
      [tokenHash, now],
    )
    const row = rows[0]
    if (!row) return null
    return {
      credentialId: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      role: String(row.role),
      allowedTools: Array.isArray(row.allowed_tools)
        ? row.allowed_tools.map(String)
        : JSON.parse(String(row.allowed_tools || '[]')) as string[],
    }
  }

  async auditMcp(
    tenant: { credentialId: string; accountId: string; workspaceId: string },
    toolName: string,
    success: boolean,
    now = Date.now(),
  ) {
    await this.pool.query(
      `INSERT INTO ${this.db}.mcp_audit_log
       (credential_id, account_id, workspace_id, tool_name, success, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenant.credentialId, tenant.accountId, tenant.workspaceId, toolName, success ? 1 : 0, now],
    )
  }

  async listPluginAudit(accountId: string, workspaceId: string, limit = 100) {
    await this.requireManager(accountId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, account_id, workspace_id, plugin_id, action, detail_json, created_at
       FROM ${this.db}.plugin_audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`,
      [workspaceId, Math.max(1, Math.min(500, limit))],
    )
    return rows.map((row) => ({
      ...row,
      detail: typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json,
    }))
  }

  /**
   * 插件按账号·空间安装：普通插件只认 account 授权；空间级授权只对内置插件生效。
   * 是否内置由调用方判定（插件注册表在 host-account 层）。
   */
  async canAccessPlugin(
    accountId: string,
    workspaceId: string,
    pluginId: string,
    options: { includeWorkspaceGrant?: boolean } = {},
  ) {
    if (!accountId || !workspaceId || !pluginId) return false
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1 AS ok FROM ${this.db}.workspace_members m
       JOIN ${this.db}.plugin_assignments p ON p.workspace_id = m.workspace_id
       WHERE m.account_id = ? AND m.workspace_id = ? AND p.plugin_id = ?
         AND ((p.subject_type = 'account' AND p.subject_id = m.account_id)
           OR (? = 1 AND p.subject_type = 'workspace' AND p.subject_id = p.workspace_id))
       LIMIT 1`,
      [accountId, workspaceId, pluginId, options.includeWorkspaceGrant ? 1 : 0],
    )
    return Boolean(rows[0])
  }

  async isApprovedPluginPackage(pluginId: string, version: string) {
    if (!pluginId || !version) return false
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1 AS ok FROM ${this.db}.plugin_packages
       WHERE id = ? AND version = ? AND trust_state = 'approved' LIMIT 1`,
      [pluginId, version],
    )
    return Boolean(rows[0])
  }

  async installPluginForAccount(actorId: string, workspaceId: string, pluginId: string, version = '', now = Date.now()) {
    await this.requireMember(actorId, workspaceId)
    const [approved] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1 AS ok FROM ${this.db}.plugin_packages WHERE id = ? AND trust_state = 'approved' LIMIT 1`,
      [pluginId],
    )
    if (!approved[0]) throw new Error('插件未安装或尚未批准')
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.plugin_assignments
         (workspace_id, plugin_id, plugin_version, subject_type, subject_id, created_by, created_at)
         VALUES (?, ?, ?, 'account', ?, ?, ?)
         ON DUPLICATE KEY UPDATE plugin_version = VALUES(plugin_version),
         created_by = VALUES(created_by), created_at = VALUES(created_at)`,
        [workspaceId, pluginId, version, actorId, actorId, now],
      )
      await connection.query(
        `INSERT INTO ${this.db}.plugin_audit_log
         (account_id, workspace_id, plugin_id, action, detail_json, created_at)
         VALUES (?, ?, ?, 'assignment.grant', ?, ?)`,
        [actorId, workspaceId, pluginId, JSON.stringify({ subject: { type: 'account', id: actorId } }), now],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /** 只摘掉当前账号在当前空间的安装与加载，不影响同空间其他成员。 */
  async uninstallPluginForAccount(actorId: string, workspaceId: string, pluginId: string, now = Date.now()) {
    await this.requireMember(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `DELETE FROM ${this.db}.plugin_loads WHERE workspace_id = ? AND account_id = ? AND plugin_id = ?`,
        [workspaceId, actorId, pluginId],
      )
      const [removed] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.db}.plugin_assignments
         WHERE workspace_id = ? AND plugin_id = ? AND subject_type = 'account' AND subject_id = ?`,
        [workspaceId, pluginId, actorId],
      )
      if (!removed.affectedRows) throw new Error('插件授权不存在')
      await connection.query(
        `INSERT INTO ${this.db}.plugin_audit_log
         (account_id, workspace_id, plugin_id, action, detail_json, created_at)
         VALUES (?, ?, ?, 'assignment.revoke', ?, ?)`,
        [actorId, workspaceId, pluginId, JSON.stringify({ subject: { type: 'account', id: actorId } }), now],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async pluginLoadsFor(accountId: string, workspaceId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT plugin_id FROM ${this.db}.plugin_loads
       WHERE workspace_id = ? AND account_id = ? ORDER BY plugin_id`,
      [workspaceId, accountId],
    )
    return rows.map((row) => String(row.plugin_id))
  }

  async loadedPluginIds() {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT plugin_id FROM ${this.db}.plugin_loads ORDER BY plugin_id`,
    )
    return rows.map((row) => String(row.plugin_id))
  }

  async setPluginLoad(
    accountId: string,
    workspaceId: string,
    pluginId: string,
    loaded: boolean,
    now = Date.now(),
    options: { includeWorkspaceGrant?: boolean } = {},
  ) {
    await this.requireMember(accountId, workspaceId)
    if (loaded) {
      if (!(await this.canAccessPlugin(accountId, workspaceId, pluginId, options))) throw new Error('plugin is not assigned')
      await this.pool.query(
        `INSERT INTO ${this.db}.plugin_loads (workspace_id, account_id, plugin_id, loaded_at)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE loaded_at = VALUES(loaded_at)`,
        [workspaceId, accountId, pluginId, now],
      )
    } else {
      await this.pool.query(
        `DELETE FROM ${this.db}.plugin_loads WHERE workspace_id = ? AND account_id = ? AND plugin_id = ?`,
        [workspaceId, accountId, pluginId],
      )
    }
  }

  async recordPluginPackage(actorId: string, input: Record<string, unknown>, now = Date.now()) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
      `INSERT INTO ${this.db}.plugin_packages
       (id, version, package_hash, package_path, source_kind, trust_state, tenant_mode,
        has_web, has_host, manifest_json, installed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE package_hash = VALUES(package_hash), package_path = VALUES(package_path),
       trust_state = VALUES(trust_state), tenant_mode = VALUES(tenant_mode),
       has_web = VALUES(has_web), has_host = VALUES(has_host), manifest_json = VALUES(manifest_json),
       installed_by = VALUES(installed_by), updated_at = VALUES(updated_at)`,
      [
        input.id, input.version, input.packageHash, input.packagePath, input.sourceKind,
        input.trustState, input.tenantMode, input.hasWeb ? 1 : 0, input.hasHost ? 1 : 0,
        JSON.stringify(input.manifest ?? {}), actorId, now, now,
      ],
      )
      await connection.query(
        `INSERT INTO ${this.db}.plugin_audit_log
         (account_id, workspace_id, plugin_id, action, detail_json, created_at)
         VALUES (?, '', ?, 'package.install', ?, ?)`,
        [actorId, input.id, JSON.stringify({ version: input.version }), now],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async installPluginForWorkspace(actorId: string, workspaceId: string, pluginId: string, version = '', now = Date.now()) {
    await this.requireMember(actorId, workspaceId)
    await this.pool.query(
      `INSERT INTO ${this.db}.plugin_assignments
       (workspace_id, plugin_id, plugin_version, subject_type, subject_id, created_by, created_at)
       VALUES (?, ?, ?, 'workspace', ?, ?, ?)
       ON DUPLICATE KEY UPDATE plugin_version = VALUES(plugin_version),
       created_by = VALUES(created_by), created_at = VALUES(created_at)`,
      [workspaceId, pluginId, version, workspaceId, actorId, now],
    )
  }

  async listPluginAssignments(actorId: string, workspaceId: string, pluginId = '') {
    await this.requireMember(actorId, workspaceId)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT workspace_id, plugin_id, plugin_version, subject_type, subject_id, created_by, created_at
       FROM ${this.db}.plugin_assignments
       WHERE workspace_id = ? AND (? = '' OR plugin_id = ?)
       ORDER BY plugin_id, subject_type, subject_id`,
      [workspaceId, pluginId, pluginId],
    )
    return rows
  }

  async grantPluginAssignment(input: {
    actorId: string; workspaceId: string; pluginId: string; pluginVersion?: string;
    subjectType: 'workspace' | 'account' | 'member_view'; subjectId: string; now?: number
  }) {
    await this.requireManager(input.actorId, input.workspaceId)
    const now = input.now ?? Date.now()
    await this.pool.query(
      `INSERT INTO ${this.db}.plugin_assignments
       (workspace_id, plugin_id, plugin_version, subject_type, subject_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE plugin_version = VALUES(plugin_version),
       created_by = VALUES(created_by), created_at = VALUES(created_at)`,
      [
        input.workspaceId, input.pluginId, input.pluginVersion ?? '', input.subjectType,
        input.subjectId, input.actorId, now,
      ],
    )
  }

  async pluginConfig(workspaceId: string, pluginId: string, accountId = '') {
    const [workspaceRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT config_json FROM ${this.db}.plugin_workspace_config WHERE workspace_id = ? AND plugin_id = ?`,
      [workspaceId, pluginId],
    )
    const [accountRows] = accountId
      ? await this.pool.query<RowDataPacket[]>(
          `SELECT config_json FROM ${this.db}.plugin_account_config
           WHERE workspace_id = ? AND plugin_id = ? AND account_id = ?`,
          [workspaceId, pluginId, accountId],
        )
      : [[]]
    const parse = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : (value ?? {})
    return {
      workspace: parse(workspaceRows[0]?.config_json),
      account: parse(accountRows[0]?.config_json),
    }
  }

  async savePluginConfig(input: {
    actorId: string; workspaceId: string; pluginId: string; config: unknown; accountId?: string; now?: number
  }) {
    await this.requireMember(input.actorId, input.workspaceId)
    const now = input.now ?? Date.now()
    if (input.accountId) {
      if (input.accountId !== input.actorId) await this.requireManager(input.actorId, input.workspaceId)
      await this.pool.query(
        `INSERT INTO ${this.db}.plugin_account_config
         (workspace_id, plugin_id, account_id, config_json, updated_at)
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE config_json = VALUES(config_json), updated_at = VALUES(updated_at)`,
        [input.workspaceId, input.pluginId, input.accountId, JSON.stringify(input.config ?? {}), now],
      )
    } else {
      await this.requireManager(input.actorId, input.workspaceId)
      await this.pool.query(
        `INSERT INTO ${this.db}.plugin_workspace_config
         (workspace_id, plugin_id, config_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE config_json = VALUES(config_json),
         updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [input.workspaceId, input.pluginId, JSON.stringify(input.config ?? {}), input.actorId, now],
      )
    }
  }

  async ensurePluginOwnerAssignments(pluginId: string, now = Date.now()) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO ${this.db}.plugin_assignments
       (workspace_id, plugin_id, plugin_version, subject_type, subject_id, created_by, created_at)
       SELECT w.id, ?, '', 'workspace', w.id, w.owner_id, ? FROM ${this.db}.workspaces w`,
      [pluginId, now],
    )
    return result.affectedRows
  }

  async uninstallPluginFromWorkspace(actorId: string, workspaceId: string, pluginId: string) {
    await this.requireMember(actorId, workspaceId)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `DELETE FROM ${this.db}.plugin_loads WHERE workspace_id = ? AND plugin_id = ?`,
        [workspaceId, pluginId],
      )
      await connection.query(
        `DELETE FROM ${this.db}.plugin_assignments
         WHERE workspace_id = ? AND plugin_id = ? AND subject_type = 'workspace' AND subject_id = ?`,
        [workspaceId, pluginId, workspaceId],
      )
      await connection.query(
        `INSERT INTO ${this.db}.plugin_audit_log
         (account_id, workspace_id, plugin_id, action, detail_json, created_at)
         VALUES (?, ?, ?, 'assignment.revoke', '{}', ?)`,
        [actorId, workspaceId, pluginId, Date.now()],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async removePluginPackage(actorId: string, pluginId: string) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(`DELETE FROM ${this.db}.plugin_loads WHERE plugin_id = ?`, [pluginId])
      await connection.query(`DELETE FROM ${this.db}.plugin_assignments WHERE plugin_id = ?`, [pluginId])
      await connection.query(`DELETE FROM ${this.db}.plugin_workspace_config WHERE plugin_id = ?`, [pluginId])
      await connection.query(`DELETE FROM ${this.db}.plugin_account_config WHERE plugin_id = ?`, [pluginId])
      await connection.query(`DELETE FROM ${this.db}.plugin_packages WHERE id = ?`, [pluginId])
      await connection.query(
        `INSERT INTO ${this.db}.plugin_audit_log
         (account_id, workspace_id, plugin_id, action, detail_json, created_at)
         VALUES (?, '', ?, 'package.uninstall', '{}', ?)`,
        [actorId, pluginId, Date.now()],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async cleanupExternalMembership(
    connection: PoolConnection,
    workspaceId: string,
    accountId: string,
  ) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT member_kind,
        EXISTS(SELECT 1 FROM ${this.db}.record_grants
          WHERE workspace_id = ? AND subject_type = 'account' AND subject_id = ?) AS has_record,
        EXISTS(SELECT 1 FROM ${this.db}.view_grants
          WHERE workspace_id = ? AND subject_type = 'account' AND subject_id = ?) AS has_view
       FROM ${this.db}.workspace_members WHERE workspace_id = ? AND account_id = ?`,
      [workspaceId, accountId, workspaceId, accountId, workspaceId, accountId],
    )
    const row = rows[0]
    if (row?.member_kind === 'external' && !row.has_record && !row.has_view) {
      await connection.query(
        `DELETE FROM ${this.db}.workspace_members WHERE workspace_id = ? AND account_id = ?`,
        [workspaceId, accountId],
      )
    }
  }

  private async writeMemberWithRevision(workspaceId: string, accountId: string, now: number) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO ${this.db}.workspace_members
         (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
         VALUES (?, ?, 'member', ?, '', '', 'member')
         ON DUPLICATE KEY UPDATE
         role = IF(member_kind = 'external', 'member', role),
         member_kind = IF(member_kind = 'external', 'member', member_kind)`,
        [workspaceId, accountId, now],
      )
      await this.bumpRevision(connection, workspaceId, '*')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async requireGrantManager(actorId: string, workspaceId: string, collection: string, recordId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1 AS ok
       FROM ${this.db}.workspace_members m
       LEFT JOIN ${this.db}.resource_policies p
         ON p.workspace_id = m.workspace_id AND p.collection = ? AND p.record_id = ?
       WHERE m.workspace_id = ? AND m.account_id = ?
         AND (m.role IN ('owner','admin') OR p.owner_account_id = ?) LIMIT 1`,
      [collection, recordId, workspaceId, actorId, actorId],
    )
    if (!rows[0]) throw new Error('permission denied')
  }

  private async canWriteRecord(
    connection: PoolConnection,
    input: { actorId: string; workspaceId: string; collection: string; recordId: string },
  ) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT 1 AS ok
       FROM ${this.db}.workspace_members m
       LEFT JOIN ${this.db}.resource_policies p
         ON p.workspace_id = m.workspace_id AND p.collection = ? AND p.record_id = ?
       WHERE m.workspace_id = ? AND m.account_id = ?
         AND m.role <> 'viewer'
         AND (
           p.owner_account_id = ?
           OR EXISTS(
             SELECT 1 FROM ${this.db}.record_owners o
             WHERE o.workspace_id = m.workspace_id AND o.collection = ? AND o.record_id = ?
               AND o.owner_id = ?
           )
           OR (p.access_mode = 'members' AND m.member_kind = 'member')
           OR EXISTS(
             SELECT 1 FROM ${this.db}.record_grants g
             WHERE g.workspace_id = m.workspace_id AND g.collection = ? AND g.record_id = ?
               AND g.role IN ('editor','manager','owner')
               AND (
                 (g.subject_type = 'account' AND g.subject_id = ?)
                 OR (g.subject_type = 'workspace_role' AND g.subject_id = m.role)
                 OR (g.subject_type = 'group' AND EXISTS(
                   SELECT 1 FROM ${this.db}.workspace_group_members gm
                   WHERE gm.group_id = g.subject_id AND gm.account_id = ?))
               )
           )
         ) LIMIT 1`,
      [
        input.collection, input.recordId, input.workspaceId, input.actorId, input.actorId,
        input.collection, input.recordId, input.actorId,
        input.collection, input.recordId, input.actorId, input.actorId,
      ],
    )
    return Boolean(rows[0])
  }

  private async requireMember(accountId: string, workspaceId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT role FROM ${this.db}.workspace_members WHERE workspace_id = ? AND account_id = ?`,
      [workspaceId, accountId],
    )
    if (!rows[0]) throw new Error('workspace membership required')
    return String(rows[0].role)
  }

  private async requireManager(accountId: string, workspaceId: string) {
    const role = await this.requireMember(accountId, workspaceId)
    if (role !== 'owner' && role !== 'admin') throw new Error('workspace manager required')
    return role
  }

  private async requireOwner(accountId: string, workspaceId: string) {
    if (await this.requireMember(accountId, workspaceId) !== 'owner') throw new Error('workspace owner required')
  }

  private bumpRevision(connection: PoolConnection, workspaceId: string, collection: string) {
    return connection.query(
      `INSERT INTO ${this.db}.authz_revisions (workspace_id, collection_name, revision, updated_at)
       VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = VALUES(updated_at)`,
      [workspaceId, collection, Date.now()],
    )
  }
}

type AuthzCacheEntry = { revision: number; rows: Array<Record<string, unknown>> }

/**
 * Scoped authorization reader. It never scans an entire collection: queries
 * are constrained by workspace, collection, subject and requested record ids.
 */
export class MysqlAuthorizationRepository {
  private readonly db: string
  private readonly cache = new Map<string, AuthzCacheEntry>()

  constructor(private readonly pool: Pool, database: string) {
    this.db = databaseName(database)
  }

  async grantsForSubject(input: {
    workspaceId: string; collection: string; accountId: string; recordIds: string[]
  }) {
    if (!input.recordIds.length) return []
    const revision = await this.revision(input.workspaceId, input.collection)
    const ids = [...new Set(input.recordIds)]
    const key = `${input.workspaceId}\t${input.collection}\t${input.accountId}\t${ids.slice().sort().join('\0')}`
    const cached = this.cache.get(key)
    if (cached?.revision === revision) return cached.rows
    const placeholders = ids.map(() => '?').join(', ')
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT g.record_id, g.subject_type, g.subject_id, g.role
       FROM ${this.db}.record_grants g
       WHERE g.workspace_id = ? AND g.collection = ? AND g.record_id IN (${placeholders})
         AND (
           (g.subject_type = 'account' AND g.subject_id = ?)
           OR (g.subject_type = 'workspace_role' AND g.subject_id = (
             SELECT m.role FROM ${this.db}.workspace_members m
             WHERE m.workspace_id = g.workspace_id AND m.account_id = ?))
           OR (g.subject_type = 'group' AND EXISTS (
             SELECT 1 FROM ${this.db}.workspace_group_members gm
             JOIN ${this.db}.workspace_groups wg ON wg.id = gm.group_id
             WHERE gm.group_id = g.subject_id AND gm.account_id = ? AND wg.workspace_id = g.workspace_id))
           OR g.subject_type = 'member_view'
         )`,
      [input.workspaceId, input.collection, ...ids, input.accountId, input.accountId, input.accountId],
    )
    const result = rows as Array<Record<string, unknown>>
    this.cache.set(key, { revision, rows: result })
    return result
  }

  async policies(input: { workspaceId: string; collection: string; recordIds: string[] }) {
    if (!input.recordIds.length) return []
    const ids = [...new Set(input.recordIds)]
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT workspace_id, collection, record_id, ownership, owner_account_id, access_mode,
              member_default_role, parent_collection, parent_record_id
       FROM ${this.db}.resource_policies
       WHERE workspace_id = ? AND collection = ? AND record_id IN (${ids.map(() => '?').join(', ')})`,
      [input.workspaceId, input.collection, ...ids],
    )
    return rows as Array<Record<string, unknown>>
  }

  async viewGrants(input: { workspaceId: string; collection: string; accountId: string; viewIds: string[] }) {
    if (!input.viewIds.length) return []
    const ids = [...new Set(input.viewIds)]
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT view_id, subject_type, subject_id, role, granted_by
       FROM ${this.db}.view_grants
       WHERE workspace_id = ? AND collection = ? AND view_id IN (${ids.map(() => '?').join(', ')})
         AND (subject_type = 'member_view' OR (subject_type = 'account' AND subject_id = ?))`,
      [input.workspaceId, input.collection, ...ids, input.accountId],
    )
    return rows as Array<Record<string, unknown>>
  }

  private async revision(workspaceId: string, collection: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(revision), 0) AS revision FROM ${this.db}.authz_revisions
       WHERE workspace_id = ? AND collection_name IN (?, '*')`,
      [workspaceId, collection],
    )
    return Number(rows[0]?.revision) || 0
  }
}

export function resolveAccountControlMode(
  backend: 'sqlite' | 'dual' | 'mysql',
  online: boolean,
  value = process.env.BIU_ACCOUNT_MYSQL_MODE,
) {
  return resolveRuntimeRepositoryMode(backend, online, value, 'BIU_ACCOUNT_MYSQL_MODE')
}
