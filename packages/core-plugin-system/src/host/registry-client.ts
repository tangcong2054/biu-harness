import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { currentAccountId, dataHome, dataPath, DATA_DIR_NAME } from '@biu/host-plugin-loader/data-dir'
import {
  generateRegistryToken,
  ownerIdForToken,
  PluginRegistryStore,
  type PluginBundle,
  type RegistryDetail,
  type RegistryIndexEntry,
  type RegistryReviewStatus,
} from './registry.ts'
import { hashInstalledPluginCode, type PluginStoreService, type RemoteFlag } from './store.ts'

const TEXT_FILES = ['manifest.json', 'host.js', 'web.js', 'README.md'] as const
const MEDIA = /^[A-Za-z0-9._-]+\.(mp3|wav|ogg|m4a)$/i
type OperatorReviewStatus = Extract<RegistryReviewStatus, 'approved' | 'rejected' | 'quarantined' | 'revoked'>

export type RegistryTransport = {
  search(q?: string, tag?: string, token?: string): Promise<{ registryId: string; plugins: RegistryIndexEntry[] }>
  detail(id: string, token?: string): Promise<RegistryDetail | null>
  bundle(id: string, version: string, token?: string): Promise<PluginBundle | null>
  publish(id: string, files: Record<string, string>, assets: Record<string, string>, token: string): Promise<{
    codeVersion: string
    ownerId: string
    registryId: string
  }>
  withdraw(id: string, version: string, token: string): Promise<unknown>
  unpublish(id: string, version: string, token: string): Promise<unknown>
  reviews(status: string, adminToken: string): Promise<RegistryIndexEntry[]>
  review(id: string, version: string, status: OperatorReviewStatus, reason: string, adminToken: string): Promise<unknown>
}

type TokenFile = { token: string }

export function registryTokenPath(workspace: string, accountId = '') {
  const safe = accountId.trim().replace(/[^a-zA-Z0-9_-]/g, '')
  return safe
    ? join(workspace, DATA_DIR_NAME, 'plugin-registry', `${safe}.json`)
    : join(workspace, DATA_DIR_NAME, 'plugin-registry.json')
}

export function loadOrCreateRegistryToken(path: string) {
  const fromEnv = String(process.env.BIU_PLUGIN_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TokenFile>
      const token = String(raw.token ?? '').trim()
      if (token) return token
    } catch {
      /* rewrite below */
    }
  }
  const token = generateRegistryToken()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`)
  return token
}

export function localRegistryTransport(registry: PluginRegistryStore): RegistryTransport {
  return {
    async search(q, tag, token) {
      return { registryId: registry.registryId, plugins: await registry.search(q, tag, token) }
    },
    detail: (id, token) => registry.detail(id, token),
    bundle: (id, version, token) => registry.bundle(id, version, token),
    publish: (id, files, assets, token) => registry.publish(id, files, assets, token),
    withdraw: (id, version, token) => registry.withdraw(id, version, token),
    unpublish: (id, version, token) => registry.unpublish(id, version, token),
    reviews: (status, adminToken) => registry.listReviews(adminToken, status),
    review: (id, version, status, reason, adminToken) =>
      registry.review(id, version, status, reason, adminToken),
  }
}

export function httpRegistryTransport(url: string, fetchImpl: typeof fetch = fetch): RegistryTransport {
  const root = url.replace(/\/+$/, '')
  const auth = (token?: string) => token ? { authorization: `Bearer ${token}` } : {}
  return {
    async search(q, tag, token) {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (tag) params.set('tag', tag)
      const suffix = params.toString() ? `?${params}` : ''
      const res = await fetchImpl(`${root}/plugins${suffix}`, { headers: auth(token) })
      if (!res.ok) throw new Error(`plugin registry search failed: ${res.status}`)
      const body = await res.json() as { registryId?: string; plugins?: RegistryIndexEntry[] }
      return { registryId: String(body.registryId ?? ''), plugins: Array.isArray(body.plugins) ? body.plugins : [] }
    },
    async detail(id, token) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}`, { headers: auth(token) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`plugin registry detail failed: ${res.status}`)
      return await res.json() as RegistryDetail
    },
    async bundle(id, version, token) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}`, { headers: auth(token) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`plugin registry download failed: ${res.status}`)
      return await res.json() as PluginBundle
    },
    async publish(id, files, assets, token) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ files, assets }),
      })
      const body = await res.json() as { error?: string; codeVersion?: string; ownerId?: string; registryId?: string }
      if (!res.ok) throw new Error(body.error || `plugin registry publish failed: ${res.status}`)
      return {
        codeVersion: String(body.codeVersion ?? ''),
        ownerId: String(body.ownerId ?? ''),
        registryId: String(body.registryId ?? ''),
      }
    },
    async withdraw(id, version, token) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}/withdraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
      })
      const body = await res.json() as { error?: string }
      if (!res.ok) throw new Error(body.error || `plugin registry withdraw failed: ${res.status}`)
      return body
    },
    async unpublish(id, version, token) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}/unpublish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
      })
      const body = await res.json() as { error?: string }
      if (!res.ok) throw new Error(body.error || `plugin registry unpublish failed: ${res.status}`)
      return body
    },
    async reviews(status, adminToken) {
      const params = status ? `?status=${encodeURIComponent(status)}` : ''
      const res = await fetchImpl(`${root}/reviews${params}`, { headers: auth(adminToken) })
      const body = await res.json() as { error?: string; plugins?: RegistryIndexEntry[] }
      if (!res.ok) throw new Error(body.error || `plugin registry reviews failed: ${res.status}`)
      return Array.isArray(body.plugins) ? body.plugins : []
    },
    async review(id, version, status, reason, adminToken) {
      const res = await fetchImpl(`${root}/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(adminToken) },
        body: JSON.stringify({ status, reason }),
      })
      const body = await res.json() as { error?: string }
      if (!res.ok) throw new Error(body.error || `plugin registry review failed: ${res.status}`)
      return body
    },
  }
}

async function readPackedFiles(dir: string) {
  const files: Record<string, string> = {}
  for (const name of TEXT_FILES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    files[name] = await readFile(path, 'utf8')
  }
  const assets: Record<string, string> = {}
  const assetsDir = join(dir, 'assets')
  if (existsSync(assetsDir)) {
    for (const name of await readdir(assetsDir)) {
      if (!MEDIA.test(name)) continue
      const file = join(assetsDir, name)
      if (!(await stat(file)).isFile()) continue
      assets[name] = (await readFile(file)).toString('base64')
    }
  }
  return { files, assets }
}

export class PluginRegistryClient {
  constructor(
    private readonly store: PluginStoreService,
    private readonly transport: RegistryTransport,
    readonly registryId: string,
    private readonly defaultTokenPath: string,
    private readonly adminToken = '',
  ) {}

  private token() {
    const accountId = currentAccountId()
    const path = accountId
      ? registryTokenPath(dirname(dirname(this.defaultTokenPath)), accountId)
      : this.defaultTokenPath
    return loadOrCreateRegistryToken(path)
  }

  isOperator() {
    const accountId = currentAccountId()
    let fileOperators: string[] = []
    try {
      const raw = JSON.parse(readFileSync(dataPath(dataHome(), 'plugin-registry-operators.json'), 'utf8')) as { accountIds?: unknown }
      fileOperators = Array.isArray(raw.accountIds) ? raw.accountIds.map(String) : []
    } catch {
      /* optional local operator config */
    }
    const allowed = [
      ...String(process.env.BIU_PLUGIN_REGISTRY_OPERATORS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
      ...fileOperators,
    ]
    return Boolean(accountId && (allowed.includes('*') || allowed.includes(accountId)))
  }

  private async index() {
    const listed = await this.transport.search('', '', this.token())
    return listed
  }

  async search(q?: string, tag?: string) {
    return this.transport.search(q, tag, this.token())
  }

  detail(id: string) {
    return this.transport.detail(id, this.token())
  }

  async flags(): Promise<Record<string, RemoteFlag>> {
    const listed = await this.index()
    const registryId = listed.registryId || this.registryId
    const installed = await this.store.list()
    const sandboxes = await this.store.listSandboxes()
    const byInstalled = new Map(installed.map((row) => [row.id, row]))
    const sandboxIds = new Set(sandboxes.map((row) => row.id))
    const flags: Record<string, RemoteFlag> = {}
    for (const row of listed.plugins) {
      const local = byInstalled.get(row.id)
      const origin = this.store.originOf(row.id)
      const owned = Boolean(origin && origin.registryId === registryId && origin.ownerId === row.ownerId)
      const localCodeVersion = local?.codeVersion ?? ''
      const present = Boolean(local) || sandboxIds.has(row.id)
      const installedForWorkspace = this.store.isInstalledForCurrentWorkspace(row.id)
      flags[row.id] = {
        remoteCodeVersion: row.codeVersion,
        localCodeVersion,
        cached: Boolean(local),
        installed: installedForWorkspace,
        updateAvailable: Boolean(installedForWorkspace && local && owned && localCodeVersion && localCodeVersion !== row.codeVersion),
        idConflict: Boolean(present && !owned),
        ownerId: row.ownerId,
      }
    }
    return flags
  }

  async install(id: string, version?: string) {
    const token = this.token()
    const detail = await this.transport.detail(id, token)
    if (!detail) throw new Error(`unknown registry plugin: ${id}`)
    const codeVersion = String(version ?? '').trim() || detail.codeVersion
    const bundle = await this.transport.bundle(id, codeVersion, token)
    if (!bundle) throw new Error(`unknown registry version: ${id}@${codeVersion}`)
    return this.store.installBundle(bundle)
  }

  async update(id: string) {
    const token = this.token()
    const detail = await this.transport.detail(id, token)
    if (!detail) throw new Error(`unknown registry plugin: ${id}`)
    const local = (await this.store.list()).find((row) => row.id === id)
    if (local?.codeVersion === detail.codeVersion) return { id, updated: false, codeVersion: detail.codeVersion }
    const bundle = await this.transport.bundle(id, detail.codeVersion, token)
    if (!bundle) throw new Error(`unknown registry version: ${id}@${detail.codeVersion}`)
    const installed = await this.store.installBundle(bundle)
    return { id, updated: true, codeVersion: installed.codeVersion }
  }

  uninstall(id: string) {
    return this.store.uninstall(id)
  }

  async publish(id: string) {
    if (existsSync(join(this.store.sandboxPath(id), 'manifest.json'))) await this.store.pack(id)
    const dir = this.store.pluginPath(id)
    if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`plugin is not packed: ${id}`)
    const { files, assets } = await readPackedFiles(dir)
    const token = this.token()
    const published = await this.transport.publish(id, files, assets, token)
    const codeVersion = await hashInstalledPluginCode(dir)
    this.store.rememberOrigin(id, {
      registryId: published.registryId || this.registryId,
      ownerId: published.ownerId || ownerIdForToken(token),
    })
    return { ...published, codeVersion }
  }

  async withdraw(id: string) {
    const detail = await this.detail(id)
    if (!detail?.ownedByRequester) throw new Error('only the uploader can withdraw this plugin')
    return this.transport.withdraw(id, detail.codeVersion, this.token())
  }

  async unpublish(id: string) {
    const detail = await this.detail(id)
    if (!detail?.ownedByRequester) throw new Error('only the uploader can unpublish this plugin')
    return this.transport.unpublish(id, detail.codeVersion, this.token())
  }

  async reviews(status = '') {
    if (!this.isOperator()) return []
    const token = this.adminToken || String(process.env.BIU_PLUGIN_REGISTRY_ADMIN_TOKEN ?? '').trim()
    if (!token) throw new Error('registry operator token is not configured')
    return this.transport.reviews(status, token)
  }

  async review(id: string, version: string, status: OperatorReviewStatus, reason = '') {
    if (!this.isOperator()) throw new Error('registry operator permission required')
    const token = this.adminToken || String(process.env.BIU_PLUGIN_REGISTRY_ADMIN_TOKEN ?? '').trim()
    if (!token) throw new Error('registry operator token is not configured')
    return this.transport.review(id, version, status, reason, token)
  }
}
