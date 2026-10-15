import type { DatabaseSync } from 'node:sqlite'
import { dataPath, openSqlite } from '@biu/host-plugin-loader/data-dir'

export type OperationsKind = 'account' | 'workspace' | 'usage' | 'device' | 'sync' | 'security'

const TABLES: Record<OperationsKind, string> = {
  account: 'ops_accounts',
  workspace: 'ops_workspaces',
  usage: 'ops_usage_daily',
  device: 'ops_devices',
  sync: 'ops_sync_health',
  security: 'ops_security_events',
}

const SECRET_KEYS = /password|token|apikey|api_key|secret|content|notes|body/i

export class OperationsStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ops_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        workspace_count INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT 'cloud',
        member_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_usage_daily (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL DEFAULT '',
        tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_devices (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'online',
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_sync_health (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        pending_ops INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        last_sync_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_security_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `)
  }

  static open(path = dataPath('ops.sqlite')) {
    return new OperationsStore(openSqlite(path))
  }

  list(kind: OperationsKind, q = '') {
    const table = TABLES[kind]
    const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    const query = q.trim().toLowerCase()
    return rows
      .map((row) => publicRow(kind, row))
      .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query))
      .sort((a, b) => {
        if (kind === 'account') {
          const wsDiff = Number((b as { workspaceCount?: number }).workspaceCount ?? 0) - Number((a as { workspaceCount?: number }).workspaceCount ?? 0)
          if (wsDiff !== 0) return wsDiff
        }
        return Number(b.updatedAt ?? b.createdAt ?? 0) - Number(a.updatedAt ?? a.createdAt ?? 0)
      })
  }

  audits(q = '') {
    const rows = this.db.prepare('SELECT * FROM ops_audit_logs ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
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

  counts() {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    return {
      accounts: count('ops_accounts'),
      workspaces: count('ops_workspaces'),
      usage: count('ops_usage_daily'),
      devices: count('ops_devices'),
      sync: count('ops_sync_health'),
      security: count('ops_security_events'),
      audits: count('ops_audit_logs'),
    }
  }

  upsert(kind: OperationsKind, input: Record<string, unknown>, now = Date.now()) {
    const clean = sanitize(input)
    const id = String(clean.id ?? '').trim()
    if (!id) throw new Error('运营记录需要 id')
    if (kind === 'account') this.writeAccount(id, clean, now)
    else if (kind === 'workspace') this.writeWorkspace(id, clean, now)
    else if (kind === 'usage') this.writeUsage(id, clean, now)
    else if (kind === 'device') this.writeDevice(id, clean, now)
    else if (kind === 'sync') this.writeSync(id, clean, now)
    else this.writeSecurity(id, clean, now)
    return this.list(kind).find((row) => row.id === id) ?? null
  }

  setAccountStatus(id: string, status: 'active' | 'suspended', actorId: string, now = Date.now()) {
    const current = this.db.prepare('SELECT id FROM ops_accounts WHERE id = ?').get(id)
    if (!current) throw new Error('用户不存在')
    this.db.prepare('UPDATE ops_accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
    this.audit(actorId, status === 'suspended' ? 'suspend-account' : 'restore-account', id, status === 'suspended' ? '暂停用户' : '恢复用户', now)
    return this.list('account').find((row) => row.id === id) ?? null
  }

  audit(actorId: string, action: string, target: string, summary: string, now = Date.now()) {
    const id = `audit_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare('INSERT INTO ops_audit_logs (id, actor_id, action, target, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, actorId, action, target, summary, now)
  }

  upsertAudit(id: string, actorId: string, action: string, target: string, summary: string, createdAt: number) {
    this.db
      .prepare(
        `INSERT INTO ops_audit_logs (id, actor_id, action, target, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           actor_id = excluded.actor_id,
           action = excluded.action,
           target = excluded.target,
           summary = excluded.summary,
           created_at = excluded.created_at`,
      )
      .run(id, text(actorId), text(action), text(target), text(summary), num(createdAt))
  }

  removePlaceholderIdentity() {
    this.db.prepare("DELETE FROM ops_accounts WHERE id = 'acc_operations_admin'").run()
    this.db.prepare("DELETE FROM ops_workspaces WHERE id = 'ws_operations'").run()
  }

  private writeAccount(id: string, input: Record<string, unknown>, now: number) {
    const existing = this.db.prepare('SELECT status FROM ops_accounts WHERE id = ?').get(id) as { status?: string } | undefined
    const status = text(input.status || existing?.status || 'active')
    this.db.prepare(
      `INSERT INTO ops_accounts (id, email, name, status, workspace_count, plan, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email, name = excluded.name, status = excluded.status,
         workspace_count = excluded.workspace_count, plan = excluded.plan,
         last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
    ).run(id, text(input.email), text(input.name || input.email), status, num(input.workspaceCount), text(input.plan), num(input.lastSeenAt), num(input.createdAt || now), now)
  }

  private writeWorkspace(id: string, input: Record<string, unknown>, now: number) {
    this.db.prepare(
      `INSERT INTO ops_workspaces (id, name, owner_id, location, member_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, owner_id = excluded.owner_id, location = excluded.location,
         member_count = excluded.member_count, status = excluded.status, updated_at = excluded.updated_at`,
    ).run(id, text(input.name || id), text(input.ownerId), text(input.location || 'cloud'), num(input.memberCount), text(input.status || 'active'), num(input.createdAt || now), now)
  }

  private writeUsage(id: string, input: Record<string, unknown>, now: number) {
    this.db.prepare(
      `INSERT INTO ops_usage_daily (id, day, account_id, workspace_id, tokens, requests, storage_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         day = excluded.day, account_id = excluded.account_id, workspace_id = excluded.workspace_id,
         tokens = excluded.tokens, requests = excluded.requests,
         storage_bytes = excluded.storage_bytes, updated_at = excluded.updated_at`,
    ).run(id, text(input.day), text(input.accountId), text(input.workspaceId), num(input.tokens), num(input.requests), num(input.storageBytes), now)
  }

  private writeDevice(id: string, input: Record<string, unknown>, now: number) {
    this.db.prepare(
      `INSERT INTO ops_devices (id, installation_id, account_id, version, os, status, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         installation_id = excluded.installation_id, account_id = excluded.account_id,
         version = excluded.version, os = excluded.os, status = excluded.status,
         last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
    ).run(id, text(input.installationId || id), text(input.accountId), text(input.version), text(input.os), text(input.status || 'online'), num(input.lastSeenAt || now), now)
  }

  private writeSync(id: string, input: Record<string, unknown>, now: number) {
    this.db.prepare(
      `INSERT INTO ops_sync_health (id, installation_id, status, pending_ops, last_error, last_sync_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, pending_ops = excluded.pending_ops, last_error = excluded.last_error,
         last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at`,
    ).run(id, text(input.installationId || id), text(input.status || 'idle'), num(input.pendingOps), text(input.lastError), num(input.lastSyncAt), now)
  }

  private writeSecurity(id: string, input: Record<string, unknown>, now: number) {
    this.db.prepare(
      `INSERT INTO ops_security_events (id, kind, account_id, summary, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary`,
    ).run(id, text(input.kind || 'event'), text(input.accountId), text(input.summary), num(input.createdAt || now))
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

function publicRow(kind: OperationsKind, row: Record<string, unknown>) {
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
