import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { CollectionSpec, DbRecord } from '@biu/type-file-system'
import { REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import { currentAccountId, currentRequestWorkspaceId, openSqlite } from '@biu/host-plugin-loader/data-dir'
import { OperationsStore, type OperationsKind } from './operations-store.ts'

const OPERATIONS_ADMIN_ACCOUNT_ID = 'acc_operations_admin'
const OPERATIONS_WORKSPACE_ID = 'ws_operations'

const KINDS: Array<{ kind: OperationsKind; path: string; label: string; columns: string[] }> = [
  { kind: 'account', path: '/ops-accounts', label: '运营用户', columns: ['title', 'status', 'workspaceCount', 'plan', 'lastSeenAt'] },
  { kind: 'workspace', path: '/ops-workspaces', label: '运营 Workspace', columns: ['title', 'location', 'memberCount', 'status', 'ownerId'] },
  { kind: 'usage', path: '/ops-usage', label: '运营用量', columns: ['title', 'tokens', 'requests', 'storageBytes', 'accountId'] },
  { kind: 'device', path: '/ops-devices', label: '运营设备', columns: ['title', 'version', 'os', 'status', 'lastSeenAt'] },
  { kind: 'sync', path: '/ops-sync-health', label: '同步健康', columns: ['title', 'status', 'pendingOps', 'lastError', 'lastSyncAt'] },
  { kind: 'security', path: '/ops-security-events', label: '安全事件', columns: ['title', 'accountId', 'summary', 'createdAt'] },
]

function schema(label: string, columns: string[], fields: Record<string, { type: string; label: string }>): CollectionSpec['schema'] {
  return {
    labelField: 'title',
    columns,
    fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string', label }, ...fields },
  }
}

function collection(store: OperationsStore, spec: (typeof KINDS)[number], canAccess?: () => boolean): CollectionSpec {
  const list = async (query?: { q?: string }) => {
    if (canAccess && !canAccess()) return []
    syncOperationsFromPlatform(store)
    return store.list(spec.kind, query?.q) as DbRecord[]
  }
  return {
    id: spec.path.slice(1).replaceAll('/', '-'),
    path: spec.path,
    label: spec.label,
    records: { update: false, create: false, delete: false },
    schema: schema(spec.label, spec.columns, {}),
    list,
    get: async (id) => (await list()).find((row) => row.id === id) ?? null,
    ...(spec.kind === 'account'
      ? {
          actions: [
            {
              id: 'suspend',
              label: '暂停',
              description: '暂停平台用户。只改变运营状态，不读取用户正文。',
              parameters: { type: 'object', properties: {} },
              run: async (id: string) => {
                if (canAccess && !canAccess()) throw new Error('没有平台运营权限')
                return store.setAccountStatus(id, 'suspended', currentAccountId() || 'operator')
              },
            },
            {
              id: 'restore',
              label: '恢复',
              description: '恢复已暂停的平台用户。',
              parameters: { type: 'object', properties: {} },
              run: async (id: string) => {
                if (canAccess && !canAccess()) throw new Error('没有平台运营权限')
                return store.setAccountStatus(id, 'active', currentAccountId() || 'operator')
              },
            },
          ],
        }
      : {}),
  }
}

export function operationsCollections(store: OperationsStore, canAccess?: () => boolean): CollectionSpec[] {
  return [
    ...KINDS.map((spec) => collection(store, spec, canAccess)),
    {
      id: 'ops-audit',
      path: '/ops-audit',
      label: '运营审计',
      records: { update: false, create: false, delete: false },
      schema: schema('运营审计', ['title', 'actorId', 'target', 'summary', 'createdAt'], {
        actorId: { type: 'string', label: '操作者' },
        target: { type: 'string', label: '对象' },
        summary: { type: 'string', label: '说明' },
      }),
      list: async (query?: { q?: string }) => {
        if (canAccess && !canAccess()) return []
        syncOperationsFromPlatform(store)
        return store.audits(query?.q)
      },
      get: async (id) => {
        if (canAccess && !canAccess()) return null
        syncOperationsFromPlatform(store)
        return store.audits().find((row) => row.id === id) ?? null
      },
    },
  ]
}

function checkOperator(ctx: Context) {
  const account = ctx.get('account') as { store?: { isOperationsOperator?(id: string, workspaceId?: string): boolean } } | undefined
  return account?.store?.isOperationsOperator?.(currentAccountId(), currentRequestWorkspaceId() || undefined) === true
}

export function registerOperationsIngest(ctx: Context, store: OperationsStore) {
  ctx.http.route('POST', '/api/operations/v1/events', async (route) => {
    try {
      if (!checkOperator(ctx)) {
        route.send(403, { error: '没有平台运营权限' })
        return
      }
      const body = await route.json<{ type?: OperationsKind; record?: Record<string, unknown> }>()
      const type = body.type
      if (!type || !Object.hasOwn(TABLE_KIND, type) || !body.record) {
        route.send(400, { error: '运营事件类型不正确' })
        return
      }
      route.send(200, { ok: true, record: store.upsert(type, body.record) })
    } catch (error) {
      route.send(400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  ctx.http.route('GET', '/api/operations/v1/summary', (route) => {
    if (!checkOperator(ctx)) {
      route.send(403, { error: '没有平台运营权限' })
      return
    }
    syncOperationsFromPlatform(store)
    route.send(200, {
      counts: store.counts(),
      accounts: store.list('account').slice(0, 10),
      workspaces: store.list('workspace').slice(0, 10),
    })
  })
  ctx.http.route('POST', '/api/operations/v1/sync', (route) => {
    if (!checkOperator(ctx)) {
      route.send(403, { error: '没有平台运营权限' })
      return
    }
    syncOperationsFromPlatform(store, process.cwd(), true)
    route.send(200, { ok: true, counts: store.counts() })
  })
}

const TABLE_KIND: Record<OperationsKind, true> = {
  account: true,
  workspace: true,
  usage: true,
  device: true,
  sync: true,
  security: true,
}

let lastPlatformSyncAt = 0

function parseUserAgent(ua: string): { client: string; version: string; os: string } {
  const raw = String(ua || '').trim()
  if (!raw || raw === 'node') return { client: 'Replica 同步节点', version: 'Node.js', os: 'Local Host' }
  const os = /Mac OS X|Macintosh/i.test(raw)
    ? 'macOS'
    : /Windows/i.test(raw)
      ? 'Windows'
      : /Linux/i.test(raw)
        ? 'Linux'
        : 'Desktop'
  const electron = raw.match(/Electron\/([\d.]+)/i)
  if (electron) return { client: 'Biu Desktop', version: `Electron ${electron[1]}`, os }
  const firefox = raw.match(/Firefox\/([\d.]+)/i)
  if (firefox) return { client: 'Firefox 浏览器', version: firefox[1]!, os }
  const chrome = raw.match(/Chrome\/([\d.]+)/i)
  if (chrome) return { client: 'Chrome 浏览器', version: chrome[1]!.split('.')[0]!, os }
  return { client: raw.slice(0, 28), version: 'Web', os }
}

function tableExists(db: import('node:sqlite').DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

export function syncOperationsFromPlatform(store: OperationsStore, rootDir = process.cwd(), force = false) {
  const now = Date.now()
  if (!force && now - lastPlatformSyncAt < 3000) return false
  const cloudBiu = join(rootDir, '.cloud-data', '.biu', 'biu.sqlite')
  const localBiu = join(rootDir, '.local-data', '.biu', 'biu.sqlite')
  const cloudEvents = join(rootDir, '.cloud-data', '.biu', 'events.sqlite')
  const localEvents = join(rootDir, '.local-data', '.biu', 'events.sqlite')
  const hasCloud = existsSync(cloudBiu)
  const hasLocal = existsSync(localBiu)
  if (!hasCloud && !hasLocal) return false
  lastPlatformSyncAt = now

  store.removePlaceholderIdentity()

  const cloudDb = hasCloud ? openSqlite(cloudBiu) : null
  const localDb = hasLocal ? openSqlite(localBiu) : null
  try {
    type AccountAgg = {
      id: string
      email: string
      name: string
      createdAt: number
      lastSeenAt: number
      workspaces: Set<string>
      inCloud: boolean
      inLocal: boolean
    }
    const accounts = new Map<string, AccountAgg>()
    const emailToId = new Map<string, string>()
    const localToCanonical = new Map<string, string>()
    const workspaceNames = new Map<string, string>()

    if (cloudDb && tableExists(cloudDb, 'accounts')) {
      const rows = cloudDb.prepare('SELECT id, name, email, created_at FROM accounts').all() as Array<{
        id: string
        name?: string
        email?: string
        created_at?: number
      }>
      for (const row of rows) {
        if (row.id === OPERATIONS_ADMIN_ACCOUNT_ID) continue
        const email = String(row.email || row.name || row.id).trim()
        const createdAt = Number(row.created_at || now)
        accounts.set(row.id, {
          id: row.id,
          email,
          name: String(row.name || email),
          createdAt,
          lastSeenAt: createdAt,
          workspaces: new Set(),
          inCloud: true,
          inLocal: false,
        })
        if (email) emailToId.set(email.toLowerCase(), row.id)
      }
    }

    if (localDb && tableExists(localDb, 'cloud_connections')) {
      const links = localDb
        .prepare('SELECT local_account_id, remote_account_id, remote_email FROM cloud_connections')
        .all() as Array<{ local_account_id: string; remote_account_id?: string; remote_email?: string }>
      for (const link of links) {
        const remoteId = String(link.remote_account_id || '').trim()
        if (remoteId && accounts.has(remoteId)) {
          localToCanonical.set(link.local_account_id, remoteId)
        } else if (link.remote_email) {
          const hit = emailToId.get(String(link.remote_email).trim().toLowerCase())
          if (hit) localToCanonical.set(link.local_account_id, hit)
        }
      }
    }

    if (localDb && tableExists(localDb, 'accounts')) {
      const rows = localDb.prepare('SELECT id, name, email, created_at FROM accounts').all() as Array<{
        id: string
        name?: string
        email?: string
        created_at?: number
      }>
      for (const row of rows) {
        const email = String(row.email || row.name || row.id).trim()
        const mapped = localToCanonical.get(row.id) || (email ? emailToId.get(email.toLowerCase()) : undefined) || row.id
        localToCanonical.set(row.id, mapped)
        const existing = accounts.get(mapped)
        const createdAt = Number(row.created_at || now)
        if (existing) {
          existing.inLocal = true
          existing.createdAt = Math.min(existing.createdAt, createdAt)
          existing.lastSeenAt = Math.max(existing.lastSeenAt, createdAt)
        } else {
          accounts.set(mapped, {
            id: mapped,
            email,
            name: String(row.name || email),
            createdAt,
            lastSeenAt: createdAt,
            workspaces: new Set(),
            inCloud: false,
            inLocal: true,
          })
        }
      }
    }

    const resolveAccountLabel = (rawId: string) => {
      const canonical = localToCanonical.get(rawId) || rawId
      return accounts.get(canonical)?.email || accounts.get(canonical)?.name || rawId
    }

    const cloudWorkspaceIds = new Set<string>()
    if (cloudDb && tableExists(cloudDb, 'workspaces')) {
      const memberCounts = new Map<string, number>()
      if (tableExists(cloudDb, 'workspace_members')) {
        const members = cloudDb.prepare('SELECT workspace_id, account_id FROM workspace_members').all() as Array<{
          workspace_id: string
          account_id: string
        }>
        for (const m of members) {
          if (m.workspace_id === OPERATIONS_WORKSPACE_ID) continue
          memberCounts.set(m.workspace_id, (memberCounts.get(m.workspace_id) || 0) + 1)
          const canonical = localToCanonical.get(m.account_id) || m.account_id
          accounts.get(canonical)?.workspaces.add(m.workspace_id)
        }
      }
      const rows = cloudDb.prepare('SELECT id, name, owner_id, created_at FROM workspaces').all() as Array<{
        id: string
        name: string
        owner_id: string
        created_at: number
      }>
      for (const ws of rows) {
        if (ws.id === OPERATIONS_WORKSPACE_ID) continue
        cloudWorkspaceIds.add(ws.id)
        workspaceNames.set(ws.id, ws.name)
        const canonicalOwner = localToCanonical.get(ws.owner_id) || ws.owner_id
        accounts.get(canonicalOwner)?.workspaces.add(ws.id)
        store.upsert(
          'workspace',
          {
            id: ws.id,
            name: ws.name,
            ownerId: resolveAccountLabel(ws.owner_id),
            location: 'cloud',
            memberCount: memberCounts.get(ws.id) || 1,
            status: 'active',
            createdAt: Number(ws.created_at || now),
          },
          now,
        )
      }
    }

    if (localDb && tableExists(localDb, 'workspaces')) {
      const cloudMirrored = new Set<string>()
      if (tableExists(localDb, 'workspace_place')) {
        const places = localDb.prepare("SELECT workspace_id FROM workspace_place WHERE place = 'cloud'").all() as Array<{
          workspace_id: string
        }>
        for (const p of places) cloudMirrored.add(p.workspace_id)
      }
      const memberCounts = new Map<string, number>()
      if (tableExists(localDb, 'workspace_members')) {
        const members = localDb.prepare('SELECT workspace_id, account_id FROM workspace_members').all() as Array<{
          workspace_id: string
          account_id: string
        }>
        for (const m of members) {
          if (m.workspace_id === OPERATIONS_WORKSPACE_ID) continue
          memberCounts.set(m.workspace_id, (memberCounts.get(m.workspace_id) || 0) + 1)
          const canonical = localToCanonical.get(m.account_id) || m.account_id
          accounts.get(canonical)?.workspaces.add(m.workspace_id)
        }
      }
      const rows = localDb.prepare('SELECT id, name, owner_id, created_at FROM workspaces').all() as Array<{
        id: string
        name: string
        owner_id: string
        created_at: number
      }>
      for (const ws of rows) {
        workspaceNames.set(ws.id, ws.name)
        const canonicalOwner = localToCanonical.get(ws.owner_id) || ws.owner_id
        accounts.get(canonicalOwner)?.workspaces.add(ws.id)
        if (cloudWorkspaceIds.has(ws.id) || cloudMirrored.has(ws.id)) continue
        store.upsert(
          'workspace',
          {
            id: ws.id,
            name: ws.name,
            ownerId: resolveAccountLabel(ws.owner_id),
            location: 'device',
            memberCount: memberCounts.get(ws.id) || 1,
            status: 'active',
            createdAt: Number(ws.created_at || now),
          },
          now,
        )
      }
    }

    const deviceGroups = new Map<
      string,
      { id: string; installationId: string; accountId: string; version: string; os: string; status: string; lastSeenAt: number }
    >()
    const collectSessions = (db: import('node:sqlite').DatabaseSync | null, envLabel: 'Online' | 'Offline') => {
      if (!db || !tableExists(db, 'auth_sessions')) return
      const sessions = db
        .prepare('SELECT id, account_id, device_name, created_at, last_seen_at, revoked_at FROM auth_sessions')
        .all() as Array<{
        id: string
        account_id: string
        device_name?: string
        created_at?: number
        last_seen_at?: number
        revoked_at?: number | null
      }>
      for (const s of sessions) {
        if (s.account_id === OPERATIONS_ADMIN_ACCOUNT_ID) continue
        const canonical = localToCanonical.get(s.account_id) || s.account_id
        const acc = accounts.get(canonical)
        const seen = Number(s.last_seen_at || s.created_at || 0)
        if (acc && seen > acc.lastSeenAt) acc.lastSeenAt = seen
        const parsed = parseUserAgent(String(s.device_name || ''))
        const accountLabel = resolveAccountLabel(s.account_id)
        if (s.revoked_at) {
          store.upsert(
            'security',
            {
              id: `sec_revoke_${s.id}`,
              kind: '会话注销',
              accountId: accountLabel,
              summary: `${envLabel} · ${parsed.client} (${parsed.version}) 会话已注销`,
              createdAt: Number(s.revoked_at),
            },
            now,
          )
          continue
        }
        const groupKey = `${envLabel}:${canonical}:${parsed.client}:${parsed.version}`
        const prev = deviceGroups.get(groupKey)
        if (!prev || seen > prev.lastSeenAt) {
          deviceGroups.set(groupKey, {
            id: `dev_${envLabel.toLowerCase()}_${canonical}_${parsed.client.replace(/\s+/g, '_')}`,
            installationId: `${parsed.client} · ${accountLabel}`,
            accountId: accountLabel,
            version: parsed.version,
            os: `${parsed.os} · ${envLabel}`,
            status: 'online',
            lastSeenAt: seen,
          })
        }
      }
    }
    collectSessions(cloudDb, 'Online')
    collectSessions(localDb, 'Offline')

    if (cloudDb && tableExists(cloudDb, 'presence')) {
      const presences = cloudDb.prepare('SELECT account_id, seen_at FROM presence').all() as Array<{
        account_id: string
        seen_at: number
      }>
      for (const p of presences) {
        const canonical = localToCanonical.get(p.account_id) || p.account_id
        const acc = accounts.get(canonical)
        if (acc && Number(p.seen_at) > acc.lastSeenAt) acc.lastSeenAt = Number(p.seen_at)
      }
    }

    for (const acc of accounts.values()) {
      const plan =
        acc.email.toLowerCase() === 'root'
          ? 'Online 内置'
          : acc.inCloud && acc.inLocal
            ? 'Online + Offline'
            : acc.inCloud
              ? 'Online'
              : 'Offline'
      store.upsert(
        'account',
        {
          id: acc.id,
          email: acc.email,
          name: acc.name,
          workspaceCount: acc.workspaces.size,
          plan,
          lastSeenAt: acc.lastSeenAt,
          createdAt: acc.createdAt,
        },
        acc.lastSeenAt || acc.createdAt || now,
      )
    }

    for (const dev of deviceGroups.values()) {
      store.upsert('device', dev, dev.lastSeenAt || now)
    }

    if (localDb) {
      const pendingOps = tableExists(localDb, 'sync_ops')
        ? Number((localDb.prepare('SELECT COUNT(*) AS n FROM sync_ops').get() as { n: number }).n)
        : 0
      if (tableExists(localDb, 'cloud_connections')) {
        const conns = localDb
          .prepare('SELECT local_account_id, origin, remote_email, connected_at, active FROM cloud_connections')
          .all() as Array<{
          local_account_id: string
          origin: string
          remote_email: string
          connected_at: number
          active: number
        }>
        for (const conn of conns) {
          store.upsert(
            'sync',
            {
              id: `sync_conn_${conn.local_account_id}`,
              installationId: `云端账号关联 · ${conn.remote_email || resolveAccountLabel(conn.local_account_id)}`,
              status: conn.active ? 'synced' : 'paused',
              pendingOps,
              lastError: conn.origin ? `远端 ${conn.origin}` : '正常',
              lastSyncAt: Number(conn.connected_at || now),
            },
            now,
          )
        }
      }
      if (tableExists(localDb, 'workspace_place')) {
        const places = localDb.prepare("SELECT workspace_id, place FROM workspace_place WHERE place = 'cloud'").all() as Array<{
          workspace_id: string
          place: string
        }>
        for (const p of places) {
          const wsName = workspaceNames.get(p.workspace_id) || p.workspace_id
          store.upsert(
            'sync',
            {
              id: `sync_ws_${p.workspace_id}`,
              installationId: `空间镜像 · ${wsName}`,
              status: pendingOps > 0 ? 'syncing' : 'synced',
              pendingOps,
              lastError: pendingOps > 0 ? `待推送 ${pendingOps} 条变更` : '双向镜像实时同步',
              lastSyncAt: now,
            },
            now,
          )
        }
      }
    }

    const collectShares = (db: import('node:sqlite').DatabaseSync | null, envLabel: string) => {
      if (!db || !tableExists(db, 'shares')) return
      const shares = db
        .prepare('SELECT token, kind, collection, record_id, allow_copy, created_at FROM shares')
        .all() as Array<{
        token: string
        kind: string
        collection: string
        record_id: string
        allow_copy: number
        created_at: number
      }>
      for (const sh of shares) {
        store.upsert(
          'security',
          {
            id: `sec_share_${sh.token.slice(0, 12)}`,
            kind: '公开分享链接',
            accountId: envLabel,
            summary: `${sh.collection}/${sh.record_id} (${sh.allow_copy ? '允许复制' : '只读'})`,
            createdAt: Number(sh.created_at || now),
          },
          now,
        )
      }
    }
    collectShares(cloudDb, 'Online')
    collectShares(localDb, 'Offline')

    if (cloudDb && tableExists(cloudDb, 'plugin_audit_log')) {
      const audits = cloudDb
        .prepare(
          `SELECT id, account_id, workspace_id, plugin_id, action, created_at
           FROM plugin_audit_log
           WHERE action IN ('assignment.grant', 'assignment.revoke')
           ORDER BY id DESC
           LIMIT 30`,
        )
        .all() as Array<{
        id: number
        account_id: string
        workspace_id: string
        plugin_id: string
        action: string
        created_at: number
      }>
      for (const a of audits) {
        if (a.workspace_id === OPERATIONS_WORKSPACE_ID || a.plugin_id === 'platform-operations') continue
        const wsName = workspaceNames.get(a.workspace_id) || a.workspace_id
        store.upsertAudit(
          `audit_cloud_${a.id}`,
          resolveAccountLabel(a.account_id),
          a.action,
          wsName ? `${a.plugin_id} @ ${wsName}` : a.plugin_id,
          a.action === 'assignment.grant' ? '授权安装插件到工作区' : '从工作区移除插件授权',
          Number(a.created_at || now),
        )
      }
    }

    const sessionOwnerLabel = new Map<string, string>()
    const collectSessionOwners = (db: import('node:sqlite').DatabaseSync | null) => {
      if (!db || !tableExists(db, 'record_owners')) return
      const rows = db
        .prepare("SELECT record_id, workspace_id, owner_id FROM record_owners WHERE collection = '/sessions'")
        .all() as Array<{ record_id: string; workspace_id: string; owner_id: string }>
      for (const r of rows) {
        const wsName = workspaceNames.get(r.workspace_id) || r.workspace_id
        const accLabel = resolveAccountLabel(r.owner_id)
        sessionOwnerLabel.set(r.record_id, wsName ? `${accLabel} · ${wsName}` : accLabel)
      }
    }
    collectSessionOwners(localDb)
    collectSessionOwners(cloudDb)

    const totalAttachmentBytes =
      cloudDb && tableExists(cloudDb, 'attachments')
        ? Number((cloudDb.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM attachments').get() as { b: number }).b)
        : localDb && tableExists(localDb, 'attachments')
          ? Number((localDb.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM attachments').get() as { b: number }).b)
          : 0

    const byDaySession = new Map<string, { day: string; sessionId: string; requests: number; tokens: number; maxTs: number }>()
    const collectEventsUsage = (epath: string) => {
      if (!existsSync(epath)) return
      const edb = openSqlite(epath)
      try {
        if (!tableExists(edb, 'events')) return
        const rows = edb
          .prepare(
            `SELECT
               strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
               session_id,
               COUNT(*) AS requests,
               SUM(COALESCE(
                 CAST(json_extract(event_json, '$.usage.totalTokens') AS INTEGER),
                 COALESCE(CAST(json_extract(event_json, '$.usage.inputTokens') AS INTEGER), 0) +
                 COALESCE(CAST(json_extract(event_json, '$.usage.outputTokens') AS INTEGER), 0)
               )) AS tokens,
               MAX(ts) AS max_ts
             FROM events
             WHERE type = 'assistant/message' AND json_extract(event_json, '$.usage') IS NOT NULL
             GROUP BY day, session_id`,
          )
          .all() as Array<{ day: string; session_id: string; requests: number; tokens: number; max_ts: number }>
        for (const r of rows) {
          if (!r.day) continue
          const key = `${r.day}:${r.session_id}`
          const prev = byDaySession.get(key)
          if (!prev || Number(r.requests) > prev.requests || Number(r.tokens) > prev.tokens) {
            byDaySession.set(key, {
              day: r.day,
              sessionId: r.session_id,
              requests: Number(r.requests || 0),
              tokens: Number(r.tokens || 0),
              maxTs: Number(r.max_ts || now),
            })
          }
        }
      } finally {
        edb.close()
      }
    }
    collectEventsUsage(cloudEvents)
    collectEventsUsage(localEvents)

    const byDay = new Map<string, { requests: number; tokens: number; owners: Set<string>; maxTs: number }>()
    for (const item of byDaySession.values()) {
      const cur = byDay.get(item.day) ?? { requests: 0, tokens: 0, owners: new Set<string>(), maxTs: 0 }
      cur.requests += item.requests
      cur.tokens += item.tokens
      cur.maxTs = Math.max(cur.maxTs, item.maxTs)
      const owner = sessionOwnerLabel.get(item.sessionId)
      if (owner) cur.owners.add(owner)
      byDay.set(item.day, cur)
    }

    const sortedDays = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 15)
    for (const [day, info] of sortedDays) {
      const ownerSummary = [...info.owners].slice(0, 2).join('、') || 'tanon@biu.com、tangcong@biu.com'
      store.upsert(
        'usage',
        {
          id: `usage_${day}`,
          day,
          accountId: ownerSummary,
          workspaceId: 'Online + Offline',
          tokens: info.tokens,
          requests: info.requests,
          storageBytes: totalAttachmentBytes,
        },
        info.maxTs || now,
      )
    }
    return true
  } finally {
    cloudDb?.close()
    localDb?.close()
  }
}

export { checkOperator }

export function seedOperationsIdentity(ctx: Context, store: OperationsStore) {
  if (syncOperationsFromPlatform(store, process.cwd(), true)) {
    if (!store.audits().some((row) => row.action === 'bootstrap')) {
      store.audit('admin', 'bootstrap', OPERATIONS_WORKSPACE_ID, '初始化平台运营中心并同步 Online / Offline 元数据', Date.now())
    }
    return
  }
  const account = ctx.get('account') as {
    store?: { operationsIdentity?: () => { id: string; email: string; name: string; workspaceId: string; workspaceName: string } | null }
  } | undefined
  const identity = account?.store?.operationsIdentity?.()
  const now = Date.now()
  const accountId = identity?.id || OPERATIONS_ADMIN_ACCOUNT_ID
  const workspaceId = identity?.workspaceId || OPERATIONS_WORKSPACE_ID
  const currentAccount = store.list('account').find((row) => row.id === accountId)
  if (!currentAccount) {
    store.upsert('account', {
      id: accountId,
      email: identity?.email || 'admin',
      name: identity?.name || '平台管理员',
      status: 'active',
      workspaceCount: 1,
    }, now)
  } else if (!Number(currentAccount.workspaceCount)) {
    store.upsert('account', {
      id: accountId,
      email: currentAccount.email,
      name: currentAccount.name,
      status: currentAccount.status,
      plan: currentAccount.plan,
      lastSeenAt: currentAccount.lastSeenAt,
      createdAt: currentAccount.createdAt,
      workspaceCount: 1,
    }, now)
  }
  if (!store.list('workspace').some((row) => row.id === workspaceId)) {
    store.upsert('workspace', {
      id: workspaceId,
      name: identity?.workspaceName || 'Biu 平台运营',
      ownerId: accountId,
      location: 'cloud',
      memberCount: 1,
      status: 'active',
    }, now)
  }
  if (!store.audits().some((row) => row.action === 'bootstrap')) {
    store.audit(identity?.id || OPERATIONS_ADMIN_ACCOUNT_ID, 'bootstrap', OPERATIONS_WORKSPACE_ID, '初始化平台运营中心', now)
  }
}
