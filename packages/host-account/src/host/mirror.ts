import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import { currentAccountId, currentRequestWorkspaceId, isOnlineRuntime, runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { SessionRecord } from '@biu/type-session'
import { SnapshotWatermarkStore } from './snapshot-watermarks.ts'

export type MirrorSnapshot = {
  sessions: Array<SessionRecord & { updatedAt?: number }>
  sessionIds?: string[]
  collections: Array<{
    path: string
    records: Array<Record<string, unknown> & { id: string; updatedAt?: number }>
    recordIds?: string[]
  }>
  assets?: SnapshotAsset[]
}

export type SnapshotOptions = {
  since?: number
  includeAssets?: boolean
}

export type SnapshotConflict = {
  collection: string
  id: string
  reason?: string
}

export type SnapshotAsset = {
  name: string
  etag: string
  mime: string
  storage: 'hash' | 'name'
  size: number
  contentHash: string
  bytesBase64: string
}

export type ExchangeSnapshotOptions = {
  watermarkPath?: string
  watermarkCache?: Map<string, number>
}

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
  batchChanges?: <T>(run: () => Promise<T> | T) => Promise<T>
  read?: (path: string) => Promise<{ value?: Record<string, unknown> & { id?: string } }>
  isRecordDeleted?: (path: string, id: string) => boolean | Promise<boolean>
  reviveDeleted?: (path: string, ids: string[]) => Promise<unknown>
  remove?: (path: string, query: { ids: string[] }) => Promise<unknown>
  exportSnapshotAssets?: (records: unknown[]) => Promise<SnapshotAsset[]>
  preflightSnapshotAssets?: (assets: SnapshotAsset[]) => Promise<SnapshotConflict[]>
  restoreSnapshotAssets?: (assets: Array<Omit<SnapshotAsset, 'bytesBase64' | 'size'> & { bytes: Uint8Array }>) => Promise<void>
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

async function sessionVisible(ctx: Context, id: string, record?: { id?: unknown }) {
  try {
    const sessions = ctx.get('sessions') as {
      inWorkspace?: (id: string, record?: { id?: unknown }) => boolean
      inWorkspaceAsync?: (id: string, record?: { id?: unknown }) => Promise<boolean>
    } | undefined
    if (typeof sessions?.inWorkspaceAsync === 'function') return await sessions.inWorkspaceAsync(id, record)
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
    const workspaceId = currentRequestWorkspaceId() || account?.store?.activeWorkspaceId()
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
  const workspaceId = currentRequestWorkspaceId() || account?.store?.activeWorkspaceId?.() || ''
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
      if (!(await sessionVisible(ctx, item.id, item))) continue
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
  const assets = options?.includeAssets
    ? await databaseOf(ctx)?.exportSnapshotAssets?.([
        ...sessions,
        ...collections.flatMap((collection) => collection.records),
      ])
    : undefined
  return {
    sessions,
    ...(since > 0 ? { sessionIds } : {}),
    collections,
    ...(assets ? { assets } : {}),
  }
}

async function applySnapshotNow(ctx: Context, snapshot: MirrorSnapshot, mode: ApplyMode) {
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

export async function applySnapshot(ctx: Context, snapshot: MirrorSnapshot, mode: ApplyMode = 'cache') {
  const database = databaseOf(ctx)
  if (database?.batchChanges) {
    return database.batchChanges(() => applySnapshotNow(ctx, snapshot, mode))
  }
  return applySnapshotNow(ctx, snapshot, mode)
}

/**
 * Restores records the current device workspace is missing, and puts trashed
 * copies back. Live records stay as they are. Asset content conflicts still
 * cancel the restore before the first write.
 */
export async function restoreSnapshotSafely(ctx: Context, snapshot: MirrorSnapshot) {
  const conflicts: SnapshotConflict[] = []
  const decodedAssets: Array<Omit<SnapshotAsset, 'bytesBase64' | 'size'> & { bytes: Uint8Array }> = []
  const assetNames = new Set<string>()
  let decodedBytes = 0
  for (const asset of snapshot.assets ?? []) {
    const name = String(asset?.name ?? '')
    let bytes: Buffer
    try {
      bytes = Buffer.from(String(asset?.bytesBase64 ?? ''), 'base64')
    } catch {
      bytes = Buffer.alloc(0)
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const hashName = /^([a-f0-9]{64})(?:\.[A-Za-z0-9]{1,12})?$/.exec(name)
    const invalid =
      !name ||
      assetNames.has(name) ||
      bytes.toString('base64') !== asset.bytesBase64 ||
      bytes.length !== Number(asset.size) ||
      hash !== asset.contentHash ||
      !['hash', 'name'].includes(asset.storage) ||
      (asset.storage === 'hash' && hashName?.[1] !== hash) ||
      (asset.storage === 'name' && asset.etag !== hash)
    if (invalid) {
      conflicts.push({ collection: '/assets', id: name, reason: 'invalid-or-tampered' })
      continue
    }
    assetNames.add(name)
    decodedBytes += bytes.length
    decodedAssets.push({
      name,
      etag: asset.etag,
      mime: asset.mime,
      storage: asset.storage,
      contentHash: asset.contentHash,
      bytes,
    })
  }
  const itemCount =
    (snapshot.sessions?.length ?? 0) +
    (snapshot.collections ?? []).reduce((sum, collection) => sum + (collection.records?.length ?? 0), 0) +
    decodedAssets.length
  if (decodedBytes > 10 * 1024 * 1024 || itemCount > 20_000) {
    conflicts.push({ collection: '/assets', id: '', reason: 'backup-limit-exceeded' })
  }
  const database = databaseOf(ctx)
  if ((snapshot.assets?.length ?? 0) > 0 && !database?.preflightSnapshotAssets) {
    conflicts.push({ collection: '/assets', id: '', reason: 'asset-service-unavailable' })
  } else if (decodedAssets.length && conflicts.length === 0) {
    conflicts.push(...((await database?.preflightSnapshotAssets?.(snapshot.assets ?? [])) ?? []))
  }
  if (conflicts.length) return { restored: false as const, conflicts }
  const store = sessionsOf(ctx)
  const currentSessions = new Set((await store?.listSummaries())?.map((item) => item.id) ?? [])
  const sessions = (snapshot.sessions ?? []).filter((record) => record?.id && !currentSessions.has(record.id))
  const collections: MirrorSnapshot['collections'] = []
  for (const collection of snapshot.collections ?? []) {
    if (collection.path === '/sessions') continue
    const records = []
    const trashed = []
    for (const record of collection.records ?? []) {
      const id = String(record?.id ?? '')
      if (!id) continue
      const existing = await database?.read?.(`${collection.path}/${id}`).catch(() => null)
      if (existing?.value?.id) continue
      if (await database?.isRecordDeleted?.(collection.path, id)) trashed.push(id)
      records.push(record)
    }
    if (trashed.length) await database?.reviveDeleted?.(collection.path, trashed)
    if (records.length) collections.push({ path: collection.path, records })
  }
  if (decodedAssets.length) await database?.restoreSnapshotAssets?.(decodedAssets)
  await applySnapshot(ctx, { sessions, collections }, 'adopt')
  return { restored: true as const, conflicts: [] as SnapshotConflict[], restoredRecords: sessions.length + collections.reduce((sum, collection) => sum + collection.records.length, 0) }
}

export async function exchangeSnapshot(
  ctx: Context,
  origin: string,
  token: string,
  accountId: string,
  workspaceId = '',
  options?: ExchangeSnapshotOptions,
) {
  if (!workspaceId) return
  const root = origin.replace(/\/$/, '')
  const watermarkKey = { origin: root, accountId, workspaceId }
  const watermarks = new SnapshotWatermarkStore(options?.watermarkPath, options?.watermarkCache)
  const since = watermarks.get(watermarkKey)
  const url = since > 0 ? `${root}/api/replica/snapshot?since=${since}` : `${root}/api/replica/snapshot`
  const headers = {
    authorization: `Bearer ${token}`,
    'x-biu-workspace-id': workspaceId,
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
  watermarks.set(watermarkKey, maxUpdatedAt > 0 ? maxUpdatedAt : Date.now())
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

export async function forwardCloudBytes(
  ctx: Context,
  path: string,
  init: {
    method?: string
    body?: Uint8Array
    headers?: Record<string, string>
  } = {},
): Promise<{ status: number; body: Buffer; headers: Headers } | null> {
  const cloud = desktopCloudWorkspace(ctx)
  if (!cloud) return null
  const res = await fetch(`${cloud.origin}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...init.headers,
      authorization: `Bearer ${cloud.token}`,
      'x-biu-workspace-id': cloud.workspaceId,
    },
    body: init.body === undefined ? undefined : Buffer.from(init.body),
  })
  return {
    status: res.status,
    body: Buffer.from(await res.arrayBuffer()),
    headers: res.headers,
  }
}
