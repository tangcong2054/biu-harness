import type { Context } from 'cordis'
import { currentAccountId, currentRequestWorkspaceId, isOnlineRuntime, runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { SessionRecord } from '@biu/type-session'

export type MirrorSnapshot = {
  sessions: Array<SessionRecord & { updatedAt?: number }>
  sessionIds?: string[]
  collections: Array<{
    path: string
    records: Array<Record<string, unknown> & { id: string; updatedAt?: number }>
    recordIds?: string[]
  }>
}

export type SnapshotOptions = {
  since?: number
}

const snapshotWatermarks = new Map<string, number>()

function yieldEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

type ApplyMode = 'cache' | 'adopt'

type SessionStoreLike = {
  listSummaries: () => Promise<Array<{ id: string; updatedAt?: number }>>
  load: (id: string) => Promise<SessionRecord | null | undefined>
  save: (record: SessionRecord & { updatedAt?: number }) => Promise<void>
  delete?: (id: string) => Promise<unknown>
}

type DatabaseLike = {
  syncedRecords: (options?: { since?: number }) => Promise<MirrorSnapshot['collections']>
  applySynced: (path: string, records: MirrorSnapshot['collections'][number]['records']) => Promise<void>
  read?: (path: string) => Promise<{ value?: Record<string, unknown> & { id?: string } }>
  remove?: (path: string, query: { ids: string[] }) => Promise<unknown>
}

type AccountLike = {
  isRemote?: (collection: string, id: string) => boolean
  markRemote?: (collection: string, id: string) => void
  clearPlace?: (collection: string, id: string) => void
  remoteIds?: (collection: string) => string[]
  linkedCloud?: (localAccountId?: string) => { origin: string; token: string } | null
  workspaceLocation?: (workspaceId: string) => 'device' | 'cloud'
  store?: { activeWorkspaceId?: () => string | null }
}

function sessionsOf(ctx: Context) {
  try {
    return ctx.get('sessionStore') as SessionStoreLike | undefined
  } catch {
    return undefined
  }
}

function databaseOf(ctx: Context) {
  try {
    return ctx.get('database') as DatabaseLike | undefined
  } catch {
    return undefined
  }
}

function accountOf(ctx: Context) {
  try {
    return ctx.get('account') as AccountLike | undefined
  } catch {
    return undefined
  }
}

function sessionVisible(ctx: Context, id: string, record?: { id?: unknown }) {
  try {
    const sessions = ctx.get('sessions') as { inWorkspace?: (id: string, record?: { id?: unknown }) => boolean } | undefined
    if (typeof sessions?.inWorkspace === 'function') return sessions.inWorkspace(id, record)
  } catch {
    /* 没有会话服务时按存储里的全部导出，测试走这条 */
  }
  return true
}

function claim(ctx: Context, collection: string, id: string) {
  try {
    const account = ctx.get('account') as
      | { store?: { activeWorkspaceId(): string | null; attach(workspaceId: string, collection: string, recordId: string): void } }
      | undefined
    const workspaceId = account?.store?.activeWorkspaceId()
    if (!workspaceId || !account?.store) return
    account.store.attach(workspaceId, collection, id)
  } catch {
    /* 已经挂在别的空间，或这台机器还没有空间 */
  }
}

function rememberCloud(ctx: Context, collection: string, id: string) {
  accountOf(ctx)?.markRemote?.(collection, id)
}

function desktopCloudWorkspace(ctx: Context) {
  if (isOnlineRuntime()) return null
  const origin = process.env.BIU_REMOTE_ORIGIN?.replace(/\/$/, '')
  if (!origin) return null
  const account = accountOf(ctx)
  const workspaceId = currentRequestWorkspaceId() || account?.store?.activeWorkspaceId() || ''
  if (!workspaceId || account?.workspaceLocation?.(workspaceId) !== 'cloud') return null
  const linked = account?.linkedCloud?.(currentAccountId() || undefined)
  if (!linked?.token) return null
  return { origin: linked.origin || origin, token: linked.token, workspaceId }
}

export async function takeSnapshot(ctx: Context, options?: SnapshotOptions): Promise<MirrorSnapshot> {
  const since = Math.max(0, Number(options?.since) || 0)
  const sessions: MirrorSnapshot['sessions'] = []
  const sessionIds: string[] = []
  const store = sessionsOf(ctx)
  if (store) {
    let loadedCount = 0
    for (const item of await store.listSummaries()) {
      if (!sessionVisible(ctx, item.id, item)) continue
      sessionIds.push(item.id)
      const updatedAt = Number(item.updatedAt) || 0
      if (since > 0 && updatedAt > 0 && updatedAt <= since) continue
      const full = await store.load(item.id)
      if (!full) continue
      sessions.push({ ...full, updatedAt })
      loadedCount += 1
      if (loadedCount % 5 === 0) await yieldEventLoop()
    }
  }
  const rawCollections = ((await databaseOf(ctx)?.syncedRecords(since > 0 ? { since } : undefined)) ?? []).filter(
    (item) => item.path !== '/sessions',
  )
  const collections: MirrorSnapshot['collections'] =
    since > 0
      ? rawCollections.map((item) => ({
          path: item.path,
          recordIds:
            item.recordIds ?? item.records.map((record) => String(record?.id ?? '')).filter(Boolean),
          records: item.records.filter((record) => {
            const updatedAt = Number(record?.updatedAt) || 0
            return updatedAt <= 0 || updatedAt > since
          }),
        }))
      : rawCollections
  return {
    sessions,
    ...(since > 0 ? { sessionIds } : {}),
    collections,
  }
}

export async function applySnapshot(ctx: Context, snapshot: MirrorSnapshot, mode: ApplyMode = 'cache') {
  const account = accountOf(ctx)
  const store = sessionsOf(ctx)
  if (store) {
    const summaries = await store.listSummaries()
    const current = new Set(summaries.map((item) => item.id))
    const currentUpdatedAt = new Map(summaries.map((item) => [item.id, Number(item.updatedAt) || 0]))
    const incoming = new Set<string>(snapshot.sessionIds ?? [])
    let savedCount = 0
    for (const record of snapshot.sessions ?? []) {
      if (!record?.id) continue
      incoming.add(record.id)
      const localHome = current.has(record.id) && !account?.isRemote?.('/sessions', record.id)
      if (mode === 'cache' && localHome) continue
      const incomingAt = Number(record.updatedAt) || 0
      const existingAt = currentUpdatedAt.get(record.id) ?? 0
      if (mode === 'cache' && current.has(record.id) && incomingAt > 0 && existingAt >= incomingAt) {
        claim(ctx, '/sessions', record.id)
        rememberCloud(ctx, '/sessions', record.id)
        continue
      }
      try {
        await store.save(record)
        claim(ctx, '/sessions', record.id)
        if (mode === 'cache') rememberCloud(ctx, '/sessions', record.id)
        savedCount += 1
        if (savedCount % 5 === 0) await yieldEventLoop()
      } catch (error) {
        console.warn('[replica] skip session', record.id, error)
      }
    }
    if (mode === 'cache') {
      for (const id of account?.remoteIds?.('/sessions') ?? []) {
        if (incoming.has(id)) continue
        await store.delete?.(id)
        account?.clearPlace?.('/sessions', id)
      }
    }
  }
  const database = databaseOf(ctx)
  if (!database) return
  for (const collection of snapshot.collections ?? []) {
    if (collection.path === '/sessions') continue
    const incoming = new Set<string>(collection.recordIds ?? [])
    const writable = []
    for (const record of collection.records ?? []) {
      const id = String(record?.id ?? '')
      if (!id) continue
      incoming.add(id)
      if (mode === 'cache' && account?.isRemote && !account.isRemote(collection.path, id)) {
        const existing = await database.read?.(`${collection.path}/${id}`).catch(() => null)
        if (existing?.value?.id) continue
      }
      writable.push(record)
    }
    if (writable.length) {
      await database.applySynced(collection.path, writable)
      for (const record of writable) {
        if (!record?.id) continue
        claim(ctx, collection.path, String(record.id))
        if (mode === 'cache') rememberCloud(ctx, collection.path, String(record.id))
      }
    }
    if (mode === 'cache') {
      for (const id of account?.remoteIds?.(collection.path) ?? []) {
        if (incoming.has(id)) continue
        await database.remove?.(collection.path, { ids: [id] }).catch((error) => {
          console.warn('[replica] drop', collection.path, id, error)
        })
        account?.clearPlace?.(collection.path, id)
      }
    }
  }
}

export async function exchangeSnapshot(
  ctx: Context,
  origin: string,
  token: string,
  accountId: string,
  workspaceId = '',
) {
  const root = origin.replace(/\/$/, '')
  const watermarkKey = `${root}\t${accountId}\t${workspaceId}`
  const since = snapshotWatermarks.get(watermarkKey) ?? 0
  const url = since > 0 ? `${root}/api/replica/snapshot?since=${since}` : `${root}/api/replica/snapshot`
  const headers = {
    authorization: `Bearer ${token}`,
    ...(workspaceId ? { 'x-biu-workspace-id': workspaceId } : {}),
  }
  const pulled = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!pulled.ok) return
  const body = (await pulled.json()) as MirrorSnapshot
  await runWithAccount(accountId, () =>
    workspaceId
      ? runWithRequestWorkspace(workspaceId, () => applySnapshot(ctx, body, 'cache'))
      : applySnapshot(ctx, body, 'cache'),
  )
  let maxUpdatedAt = since
  for (const session of body.sessions ?? []) {
    const ts = Number(session?.updatedAt) || 0
    if (ts > maxUpdatedAt) maxUpdatedAt = ts
  }
  for (const collection of body.collections ?? []) {
    for (const record of collection.records ?? []) {
      const ts = Number(record?.updatedAt) || 0
      if (ts > maxUpdatedAt) maxUpdatedAt = ts
    }
  }
  snapshotWatermarks.set(watermarkKey, maxUpdatedAt > 0 ? maxUpdatedAt : Date.now())
}

export async function forwardCloud(
  ctx: Context,
  _collection: string,
  _id: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown } | null> {
  const cloud = desktopCloudWorkspace(ctx)
  if (!cloud) return null
  const res = await fetch(`${cloud.origin}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      authorization: `Bearer ${cloud.token}`,
      'x-biu-workspace-id': cloud.workspaceId,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
