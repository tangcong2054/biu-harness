import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MysqlOperationsStore } from './mysql-operations-store.ts'

type ProjectionStore = Pick<MysqlOperationsStore, 'upsert' | 'upsertAudit' | 'list'>

export async function syncMysqlOperations(pool: Pick<Pool, 'query'>, database: string, store: ProjectionStore) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database)) throw new Error('unsafe MySQL product database name')
  const table = (name: string) => `\`${database}\`.\`${name}\``
  const select = async (sql: string) => (await pool.query<RowDataPacket[]>(sql))[0]
  const accounts = await select(`SELECT id, name, email, created_at FROM ${table('accounts')}`)
  const workspaces = await select(`SELECT id, name, owner_id, created_at FROM ${table('workspaces')}`)
  const members = await select(`SELECT workspace_id, account_id FROM ${table('workspace_members')}`)
  const sessions = await select(`SELECT id, account_id, device_name, created_at, last_seen_at, revoked_at, expires_at FROM ${table('auth_sessions')}`)
  const presence = await select(`SELECT account_id, MAX(seen_at) AS seen_at FROM ${table('presence')} GROUP BY account_id`)
  const shares = await select(`SELECT token, collection, record_id, allow_copy, created_at FROM ${table('shares')}`)
  const audits = await select(`SELECT id, account_id, workspace_id, plugin_id, action, created_at FROM ${table('plugin_audit_log')} WHERE action IN ('assignment.grant','assignment.revoke') ORDER BY id DESC LIMIT 30`)
  const storage = await select(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (SELECT name, MAX(bytes) AS bytes FROM ${table('attachments')} GROUP BY name) physical_assets`)
  const usage = await select(`SELECT DATE_FORMAT(FROM_UNIXTIME(ts / 1000), '%Y-%m-%d') AS day,
    COUNT(*) AS requests,
    SUM(COALESCE(
      CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.usage.totalTokens')) AS UNSIGNED),
      COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.usage.inputTokens')) AS UNSIGNED), 0) +
      COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.usage.outputTokens')) AS UNSIGNED), 0)
    )) AS tokens, MAX(ts) AS max_ts
    FROM ${table('events')}
    WHERE type = 'assistant/message' AND JSON_VALID(event_json)
      AND JSON_TYPE(JSON_EXTRACT(event_json, '$.usage')) = 'OBJECT'
    GROUP BY day ORDER BY day DESC LIMIT 15`)
  const previousWorkspaces = new Map((await store.list('workspace')).map(w => [w.id, w]))
  const now = Date.now()
  const memberships = new Map<string, Set<string>>()
  const memberCounts = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const m of members) {
    if (m.workspace_id === 'ws_operations') continue
    const spaces = memberships.get(m.account_id) ?? new Set<string>()
    spaces.add(m.workspace_id)
    memberships.set(m.account_id, spaces)
    memberCounts.set(m.workspace_id, (memberCounts.get(m.workspace_id) ?? 0) + 1)
  }
  for (const s of sessions) seen.set(s.account_id, Math.max(seen.get(s.account_id) ?? 0, Number(s.last_seen_at || s.created_at || 0)))
  for (const p of presence) seen.set(p.account_id, Math.max(seen.get(p.account_id) ?? 0, Number(p.seen_at || 0)))
  for (const w of workspaces) {
    if (w.id === 'ws_operations') continue
    const spaces = memberships.get(w.owner_id) ?? new Set<string>()
    spaces.add(w.id)
    memberships.set(w.owner_id, spaces)
    await store.upsert('workspace', {
      id: w.id, name: w.name, ownerId: w.owner_id, location: 'cloud',
      memberCount: memberCounts.get(w.id) ?? 0,
      status: previousWorkspaces.get(w.id)?.status ?? 'active', createdAt: Number(w.created_at),
    }, now)
  }
  for (const a of accounts) {
    if (a.id === 'acc_operations_admin') continue
    await store.upsert('account', {
      id: a.id, email: a.email ?? '', name: a.name,
      workspaceCount: memberships.get(a.id)?.size ?? 0, plan: 'Online',
      lastSeenAt: seen.get(a.id) ?? Number(a.created_at), createdAt: Number(a.created_at),
    }, now)
  }
  const devices = new Map<string, Record<string, unknown>>()
  for (const s of sessions) {
    if (s.account_id === 'acc_operations_admin') continue
    if (s.revoked_at) {
      await store.upsert('security', { id: `sec_revoke_${s.id}`, kind: '会话注销', accountId: s.account_id, summary: 'Online 登录会话已注销', createdAt: Number(s.revoked_at) }, now)
      continue
    }
    const ua = String(s.device_name || '')
    const os = /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Desktop'
    const match = ua.match(/(Electron|Firefox|Chrome)\/([\d.]+)/i)
    const client = match?.[1] ?? 'Node.js'
    const version = match?.[2]?.split('.')[0] ?? ''
    const id = `dev_online_${s.account_id}_${client}`
    const lastSeenAt = Number(s.last_seen_at || s.created_at || 0)
    if (Number(devices.get(id)?.lastSeenAt ?? -1) >= lastSeenAt) continue
    devices.set(id, {
      id, installationId: `${client}:${s.account_id}`, accountId: s.account_id,
      version: `${client} ${version}`, os, lastSeenAt,
      status: s.expires_at && Number(s.expires_at) <= now ? 'expired' : 'active',
    })
  }
  for (const device of devices.values()) await store.upsert('device', device, now)
  for (const s of shares) {
    await store.upsert('security', {
      id: `sec_share_${String(s.token).slice(0, 12)}`, kind: '公开分享链接', accountId: '',
      summary: `${s.collection}/${s.record_id} (${s.allow_copy ? '允许复制' : '只读'})`, createdAt: Number(s.created_at),
    }, now)
  }
  for (const a of audits) {
    if (a.workspace_id === 'ws_operations' || a.plugin_id === 'platform-operations') continue
    await store.upsertAudit(`audit_cloud_${a.id}`, a.account_id, a.action, `${a.plugin_id} @ ${a.workspace_id}`, a.action === 'assignment.grant' ? '授权安装插件到工作区' : '从工作区移除插件授权', Number(a.created_at))
  }
  for (const u of usage) {
    await store.upsert('usage', {
      id: `usage_${u.day}`, day: u.day, accountId: '', workspaceId: '',
      tokens: Number(u.tokens || 0), requests: Number(u.requests || 0), storageBytes: Number(storage[0]?.bytes || 0),
    }, Number(u.max_ts || now))
  }
  return true
}
