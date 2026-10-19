import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export type MysqlOperationsKind = 'account' | 'workspace' | 'usage' | 'device' | 'sync' | 'security'

const TABLES: Record<MysqlOperationsKind, string> = {
  account: 'ops_accounts',
  workspace: 'ops_workspaces',
  usage: 'ops_usage_daily',
  device: 'ops_devices',
  sync: 'ops_sync_health',
  security: 'ops_security_events',
}

const SECRET_KEYS = /password|token|apikey|api_key|secret|content|notes|body/i
const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type QueryPool = Pick<Pool, 'query'>

export class MysqlOperationsStore {
  private readonly database: string

  constructor(private readonly pool: QueryPool, database = 'biu_ops') {
    if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database name: ${database}`)
    this.database = `\`${database}\``
  }

  async list(kind: MysqlOperationsKind, q = '') {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.table(TABLES[kind])}`,
    )
    const query = q.trim().toLowerCase()
    return rows
      .map((row) => publicRow(kind, row))
      .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query))
      .sort((a, b) => {
        if (kind === 'account') {
          const difference = Number(b.workspaceCount ?? 0) - Number(a.workspaceCount ?? 0)
          if (difference !== 0) return difference
        }
        return Number(b.updatedAt ?? b.createdAt ?? 0) - Number(a.updatedAt ?? a.createdAt ?? 0)
      })
  }

  async audits(q = '') {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.table('ops_audit_logs')} ORDER BY created_at DESC`,
    )
    const query = q.trim().toLowerCase()
    return rows
      .map((row) => ({
        id: String(row.id),
        title: String(row.action),
        actorId: String(row.actor_id ?? ''),
        action: String(row.action),
        target: String(row.target ?? ''),
        summary: String(row.summary ?? ''),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.created_at),
      }))
      .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query))
  }

  async counts() {
    const names = [
      ['accounts', 'ops_accounts'],
      ['workspaces', 'ops_workspaces'],
      ['usage', 'ops_usage_daily'],
      ['devices', 'ops_devices'],
      ['sync', 'ops_sync_health'],
      ['security', 'ops_security_events'],
      ['audits', 'ops_audit_logs'],
    ] as const
    const values = await Promise.all(
      names.map(async ([key, table]) => {
        const [rows] = await this.pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM ${this.table(table)}`,
        )
        return [key, Number(rows[0]?.n ?? 0)] as const
      }),
    )
    return Object.fromEntries(values) as Record<(typeof names)[number][0], number>
  }

  async upsert(kind: MysqlOperationsKind, input: Record<string, unknown>, now = Date.now()) {
    const clean = sanitize(input)
    const id = String(clean.id ?? '').trim()
    if (!id) throw new Error('运营记录需要 id')
    if (kind === 'account') await this.writeAccount(id, clean, now)
    else if (kind === 'workspace') await this.writeWorkspace(id, clean, now)
    else if (kind === 'usage') await this.writeUsage(id, clean, now)
    else if (kind === 'device') await this.writeDevice(id, clean, now)
    else if (kind === 'sync') await this.writeSync(id, clean, now)
    else await this.writeSecurity(id, clean, now)
    return (await this.list(kind)).find((row) => row.id === id) ?? null
  }

  async setAccountStatus(
    id: string,
    status: 'active' | 'suspended',
    actorId: string,
    now = Date.now(),
  ) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.table('ops_accounts')} SET status = ?, updated_at = ? WHERE id = ?`,
      [status, now, id],
    )
    if (!result.affectedRows) throw new Error('用户不存在')
    await this.pool.query(
      `INSERT INTO ${this.table('ops_account_governance')}
       (account_id, status, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason),
         updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [id, status, status === 'suspended' ? '暂停用户' : '恢复用户', text(actorId), now],
    )
    await this.audit(
      actorId,
      status === 'suspended' ? 'suspend-account' : 'restore-account',
      id,
      status === 'suspended' ? '暂停用户' : '恢复用户',
      now,
    )
    return (await this.list('account')).find((row) => row.id === id) ?? null
  }

  async audit(actorId: string, action: string, target: string, summary: string, now = Date.now()) {
    const id = `audit_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    await this.pool.query(
      `INSERT INTO ${this.table('ops_audit_logs')}
       (id, actor_id, action, target, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, text(actorId), text(action), text(target), text(summary), now],
    )
  }

  async upsertAudit(
    id: string,
    actorId: string,
    action: string,
    target: string,
    summary: string,
    createdAt: number,
  ) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_audit_logs')}
       (id, actor_id, action, target, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE actor_id = VALUES(actor_id), action = VALUES(action),
         target = VALUES(target), summary = VALUES(summary), created_at = VALUES(created_at)`,
      [id, text(actorId), text(action), text(target), text(summary), num(createdAt)],
    )
  }

  async removePlaceholderIdentity() {
    await Promise.all([
      this.pool.query(
        `DELETE FROM ${this.table('ops_accounts')} WHERE id = 'acc_operations_admin'`,
      ),
      this.pool.query(
        `DELETE FROM ${this.table('ops_workspaces')} WHERE id = 'ws_operations'`,
      ),
    ])
  }

  private table(name: string) {
    return `${this.database}.\`${name}\``
  }

  private async writeAccount(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_accounts')}
       (id, email, name, status, workspace_count, plan, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name),
         status = IF(? = 1, VALUES(status), status),
         workspace_count = VALUES(workspace_count), plan = VALUES(plan),
         last_seen_at = VALUES(last_seen_at), updated_at = VALUES(updated_at)`,
      [
        id, text(input.email), text(input.name || input.email), text(input.status || 'active'),
        num(input.workspaceCount), text(input.plan), num(input.lastSeenAt),
        num(input.createdAt || now), now, input.status ? 1 : 0,
      ],
    )
  }

  private async writeWorkspace(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_workspaces')}
       (id, name, owner_id, location, member_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), owner_id = VALUES(owner_id),
         location = VALUES(location), member_count = VALUES(member_count),
         status = VALUES(status), updated_at = VALUES(updated_at)`,
      [id, text(input.name || id), text(input.ownerId), text(input.location || 'cloud'),
        num(input.memberCount), text(input.status || 'active'), num(input.createdAt || now), now],
    )
  }

  private async writeUsage(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_usage_daily')}
       (id, day, account_id, workspace_id, tokens, requests, storage_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE day = VALUES(day), account_id = VALUES(account_id),
         workspace_id = VALUES(workspace_id), tokens = VALUES(tokens),
         requests = VALUES(requests), storage_bytes = VALUES(storage_bytes),
         updated_at = VALUES(updated_at)`,
      [id, text(input.day), text(input.accountId), text(input.workspaceId), num(input.tokens),
        num(input.requests), num(input.storageBytes), now],
    )
  }

  private async writeDevice(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_devices')}
       (id, installation_id, account_id, version, os, status, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE installation_id = VALUES(installation_id),
         account_id = VALUES(account_id), version = VALUES(version), os = VALUES(os),
         status = VALUES(status), last_seen_at = VALUES(last_seen_at), updated_at = VALUES(updated_at)`,
      [id, text(input.installationId || id), text(input.accountId), text(input.version),
        text(input.os), text(input.status || 'online'), num(input.lastSeenAt || now), now],
    )
  }

  private async writeSync(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_sync_health')}
       (id, installation_id, status, pending_ops, last_error, last_sync_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), pending_ops = VALUES(pending_ops),
         last_error = VALUES(last_error), last_sync_at = VALUES(last_sync_at),
         updated_at = VALUES(updated_at)`,
      [id, text(input.installationId || id), text(input.status || 'idle'),
        num(input.pendingOps), text(input.lastError), num(input.lastSyncAt), now],
    )
  }

  private async writeSecurity(id: string, input: Record<string, unknown>, now: number) {
    await this.pool.query(
      `INSERT INTO ${this.table('ops_security_events')}
       (id, kind, account_id, summary, created_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), summary = VALUES(summary)`,
      [id, text(input.kind || 'event'), text(input.accountId), text(input.summary),
        num(input.createdAt || now)],
    )
  }
}

function sanitize(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !SECRET_KEYS.test(key)))
}

function text(value: unknown) {
  return String(value ?? '').slice(0, 500)
}

function num(value: unknown) {
  const next = Number(value ?? 0)
  return Number.isFinite(next) ? next : 0
}

function publicRow(kind: MysqlOperationsKind, row: Record<string, unknown>) {
  const updatedAt = Number(row.updated_at ?? row.created_at ?? 0)
  const createdAt = Number(row.created_at ?? updatedAt)
  if (kind === 'account') {
    return { id: String(row.id), title: String(row.email || row.name), email: String(row.email ?? ''), name: String(row.name ?? ''), status: String(row.status), workspaceCount: Number(row.workspace_count), plan: String(row.plan ?? ''), lastSeenAt: Number(row.last_seen_at), createdAt, updatedAt }
  }
  if (kind === 'workspace') {
    return { id: String(row.id), title: String(row.name), name: String(row.name), ownerId: String(row.owner_id ?? ''), location: String(row.location), memberCount: Number(row.member_count), status: String(row.status), createdAt, updatedAt }
  }
  if (kind === 'usage') {
    return { id: String(row.id), title: String(row.day), day: String(row.day), accountId: String(row.account_id ?? ''), workspaceId: String(row.workspace_id ?? ''), tokens: Number(row.tokens), requests: Number(row.requests), storageBytes: Number(row.storage_bytes), createdAt: updatedAt, updatedAt }
  }
  if (kind === 'device') {
    return { id: String(row.id), title: String(row.installation_id), installationId: String(row.installation_id), accountId: String(row.account_id ?? ''), version: String(row.version ?? ''), os: String(row.os ?? ''), status: String(row.status), lastSeenAt: Number(row.last_seen_at), createdAt: updatedAt, updatedAt }
  }
  if (kind === 'sync') {
    return { id: String(row.id), title: String(row.installation_id), installationId: String(row.installation_id), status: String(row.status), pendingOps: Number(row.pending_ops), lastError: String(row.last_error ?? ''), lastSyncAt: Number(row.last_sync_at), createdAt: updatedAt, updatedAt }
  }
  return { id: String(row.id), title: String(row.kind), kind: String(row.kind), accountId: String(row.account_id ?? ''), summary: String(row.summary ?? ''), createdAt, updatedAt: createdAt }
}
