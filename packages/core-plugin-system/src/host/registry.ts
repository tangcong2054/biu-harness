import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashInstalledPluginCode } from './store.ts'

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/
const VERSION_ID = /^[a-f0-9]{12}$/
const TEXT_FILES = ['manifest.json', 'host.js', 'web.js', 'README.md'] as const
const MEDIA = /^[A-Za-z0-9._-]+\.(mp3|wav|ogg|m4a)$/i
const README_EXCERPT = 400

export type PluginProvide = { kind: string; label: string; aliases: string[] }
export type RegistryReviewStatus = 'pending' | 'approved' | 'rejected' | 'quarantined' | 'withdrawn' | 'unpublished' | 'revoked'
export type RegistryScanStatus = 'clean' | 'warning' | 'blocked'

export type RegistryReview = {
  status: RegistryReviewStatus
  reason: string
  submittedAt: number
  reviewedAt: number
  reviewedBy: string
  scanStatus: RegistryScanStatus
  scanIssues: string[]
}

export type RegistryIndexEntry = {
  id: string
  name: string
  blurb: string
  tags: string[]
  author: string
  headless: boolean
  hasHost: boolean
  hasWeb: boolean
  bytes: number
  updatedAt: number
  codeVersion: string
  ownerId: string
  provides: PluginProvide[]
  readmeExcerpt: string
  reviewStatus: RegistryReviewStatus
  reviewReason: string
  scanStatus: RegistryScanStatus
  scanIssues: string[]
  ownedByRequester?: boolean
}

export type RegistryDetail = RegistryIndexEntry & {
  registryId: string
  readme: string
  versions: string[]
}

export type PluginBundle = {
  id: string
  codeVersion: string
  ownerId: string
  registryId: string
  files: Record<string, string>
  assets: Record<string, string>
}

type OwnerFile = { ownerId: string; tokenHash: string }
type LatestFile = { codeVersion: string; updatedAt: number }
type ReviewInputStatus = Extract<RegistryReviewStatus, 'approved' | 'rejected' | 'quarantined' | 'revoked'>

export function pluginIdOk(id: string) {
  return PLUGIN_ID.test(id)
}

export function generateRegistryToken() {
  return `biu_plug_${randomBytes(24).toString('base64url')}`
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function ownerIdForToken(token: string) {
  return `own_${tokenHash(token).slice(0, 16)}`
}

export function loadRegistryAdminToken(dataDir: string) {
  const fromEnv = String(process.env.BIU_PLUGIN_REGISTRY_ADMIN_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv
  const path = join(dataDir, 'admin-token')
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim()
    if (token) return token
  }
  const token = `biu_registry_admin_${randomBytes(24).toString('base64url')}`
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  return token
}

function tokensMatch(got: string, expectedHash: string) {
  if (!got || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const a = Buffer.from(tokenHash(got), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseProvides(raw: unknown): PluginProvide[] {
  if (!Array.isArray(raw)) return []
  const out: PluginProvide[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const kind = String(row.kind ?? '').trim()
    if (!kind) continue
    const aliases = Array.isArray(row.aliases)
      ? [...new Set(row.aliases.map((alias) => String(alias).trim()).filter(Boolean))].slice(0, 20)
      : []
    out.push({ kind, label: String(row.label ?? kind).trim() || kind, aliases })
    if (out.length >= 20) break
  }
  return out
}

function parseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].slice(0, 32)
}

function scanFiles(files: Record<string, string>, assets: Record<string, string>) {
  const issues: string[] = []
  const code = `${files['host.js'] ?? ''}\n${files['web.js'] ?? ''}`
  if (!files['README.md']?.trim()) issues.push('缺少 README')
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) issues.push('包含动态代码执行')
  if (/child_process|node:child_process/.test(code)) issues.push('包含子进程能力')
  const bytes =
    Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) +
    Object.values(assets).reduce((sum, value) => sum + Buffer.byteLength(value, 'base64'), 0)
  if (bytes > 8 * 1024 * 1024) issues.push('安装包超过 8MB')
  const blocked = issues.some((item) => item === '包含动态代码执行' || item === '安装包超过 8MB')
  return {
    scanStatus: blocked ? 'blocked' as const : issues.length ? 'warning' as const : 'clean' as const,
    scanIssues: issues,
  }
}

export class PluginRegistryStore {
  private readonly adminTokenHash: string

  constructor(
    readonly dataDir: string,
    readonly registryId: string,
    adminToken = loadRegistryAdminToken(dataDir),
  ) {
    if (!pluginIdOk(registryId)) throw new Error(`invalid plugin registry id: ${registryId}`)
    mkdirSync(this.pluginRoot(), { recursive: true })
    this.adminTokenHash = adminToken.trim() ? tokenHash(adminToken.trim()) : ''
    this.assertIdentity()
  }

  private pluginRoot() {
    return join(this.dataDir, 'plugins')
  }

  private assertIdentity() {
    const path = join(this.dataDir, 'registry.json')
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify({ id: this.registryId }, null, 2)}\n`)
      return
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
    const id = String(raw.id ?? '').trim()
    if (id !== this.registryId) {
      throw new Error(`plugin registry dataDir belongs to ${id || 'unknown'}, config id is ${this.registryId}`)
    }
  }

  async search(q = '', tag = '', token = ''): Promise<RegistryIndexEntry[]> {
    const index = await this.readIndex()
    const byId = new Map(index.map((row) => [row.id, row]))
    if (token) {
      const names = existsSync(this.pluginRoot()) ? await readdir(this.pluginRoot()) : []
      for (const id of names) {
        const owner = this.readOwner(id)
        const latest = this.readLatest(id)
        if (!owner || !latest || !tokensMatch(token, owner.tokenHash)) continue
        const own = await this.entryFor(id, latest.codeVersion, latest.updatedAt)
        if (own) byId.set(id, { ...own, ownedByRequester: true })
      }
    }
    const query = q.trim().toLowerCase()
    const wanted = tag.trim().toLowerCase()
    return [...byId.values()].filter((row) => {
      if (row.reviewStatus !== 'approved' && !row.ownedByRequester) return false
      if (wanted && !row.tags.some((item) => item.toLowerCase() === wanted)) return false
      if (!query) return true
      const aliases = row.provides.flatMap((item) => [item.kind, item.label, ...item.aliases])
      const hay = [row.id, row.name, row.blurb, row.readmeExcerpt, ...row.tags, ...aliases].join('\n').toLowerCase()
      return hay.includes(query)
    })
  }

  async detail(id: string, token = ''): Promise<RegistryDetail | null> {
    if (!pluginIdOk(id)) return null
    const owner = this.readOwner(id)
    const latest = this.readLatest(id)
    const owned = Boolean(owner && token && tokensMatch(token, owner.tokenHash))
    const publicRows = await this.readIndex()
    const row = owned && latest
      ? await this.entryFor(id, latest.codeVersion, latest.updatedAt)
      : publicRows.find((item) => item.id === id)
    if (!row) return null
    const versions = await this.versions(id)
    const readme = await this.readText(id, row.codeVersion, 'README.md')
    return { ...row, ...(owned ? { ownedByRequester: true } : {}), registryId: this.registryId, readme, versions }
  }

  async bundle(id: string, version: string, token = ''): Promise<PluginBundle | null> {
    if (!pluginIdOk(id) || !VERSION_ID.test(version)) return null
    const dir = this.versionDir(id, version)
    if (!existsSync(join(dir, 'manifest.json'))) return null
    const owner = this.readOwner(id)
    if (!owner) return null
    const review = this.readReview(id, version)
    if (review.status !== 'approved' && !tokensMatch(token, owner.tokenHash)) return null
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
    return { id, codeVersion: version, ownerId: owner.ownerId, registryId: this.registryId, files, assets }
  }

  async publish(id: string, files: Record<string, string>, assets: Record<string, string>, token: string) {
    if (!pluginIdOk(id)) throw new Error(`invalid plugin id: ${id}`)
    const secret = token.trim()
    if (!secret) throw new Error('publish token required')
    const manifestText = files['manifest.json']
    if (!manifestText) throw new Error('manifest.json required')
    const manifest = JSON.parse(manifestText) as Record<string, unknown>
    if (String(manifest.id ?? '').trim() !== id) throw new Error('manifest.id does not match plugin id')
    if (!String(manifest.name ?? '').trim()) throw new Error('manifest.name required')
    if (!files['host.js'] && !files['web.js']) throw new Error('host.js or web.js required')
    const owner = this.readOwner(id)
    const ownerId = ownerIdForToken(secret)
    if (owner && !tokensMatch(secret, owner.tokenHash)) {
      throw new Error(`plugin id is owned by ${owner.ownerId}`)
    }
    const staging = join(this.dataDir, '.staging', id)
    await rm(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    for (const name of TEXT_FILES) {
      const text = files[name]
      if (text == null) continue
      await writeFile(join(staging, name), text)
    }
    const assetsDir = join(staging, 'assets')
    for (const [name, body] of Object.entries(assets)) {
      if (!MEDIA.test(name)) continue
      mkdirSync(assetsDir, { recursive: true })
      await writeFile(join(assetsDir, name), Buffer.from(body, 'base64'))
    }
    const codeVersion = await hashInstalledPluginCode(staging)
    if (!codeVersion) throw new Error('plugin bundle has no code')
    const dest = this.versionDir(id, codeVersion)
    const isNewVersion = !existsSync(join(dest, 'manifest.json'))
    if (isNewVersion) {
      mkdirSync(join(this.pluginRoot(), id), { recursive: true })
      await rm(dest, { recursive: true, force: true })
      const { rename } = await import('node:fs/promises')
      await rename(staging, dest)
    } else {
      for (const name of ['manifest.json', 'README.md'] as const) {
        const text = files[name]
        if (text != null) await writeFile(join(dest, name), text)
      }
      await rm(staging, { recursive: true, force: true })
    }
    const now = Date.now()
    if (isNewVersion) {
      const scan = scanFiles(files, assets)
      this.writeJson(join(dest, 'review.json'), {
        status: scan.scanStatus === 'blocked' ? 'quarantined' : 'pending',
        reason: scan.scanStatus === 'blocked' ? scan.scanIssues.join('；') : '',
        submittedAt: now,
        reviewedAt: 0,
        reviewedBy: '',
        ...scan,
      } satisfies RegistryReview)
    }
    this.writeJson(join(this.pluginRoot(), id, 'owner.json'), {
      ownerId,
      tokenHash: tokenHash(secret),
    } satisfies OwnerFile)
    this.writeJson(join(this.pluginRoot(), id, 'latest.json'), {
      codeVersion,
      updatedAt: now,
    } satisfies LatestFile)
    await this.rebuildIndex()
    const review = this.readReview(id, codeVersion)
    return { id, codeVersion, ownerId, registryId: this.registryId, updatedAt: now, reviewStatus: review.status }
  }

  async withdraw(id: string, version: string, token: string) {
    const owner = this.requireOwner(id, token)
    const review = this.readReview(id, version)
    if (!['pending', 'rejected', 'quarantined'].includes(review.status)) {
      throw new Error(`cannot withdraw ${review.status} version`)
    }
    this.writeReview(id, version, { ...review, status: 'withdrawn', reason: '上传者已撤回' })
    await this.rebuildIndex()
    return { id, codeVersion: version, ownerId: owner.ownerId, reviewStatus: 'withdrawn' as const }
  }

  async unpublish(id: string, version: string, token: string) {
    const owner = this.requireOwner(id, token)
    const review = this.readReview(id, version)
    if (review.status !== 'approved') throw new Error(`cannot unpublish ${review.status} version`)
    this.writeReview(id, version, { ...review, status: 'unpublished', reason: '上传者已下架' })
    await this.rebuildIndex()
    return { id, codeVersion: version, ownerId: owner.ownerId, reviewStatus: 'unpublished' as const }
  }

  async review(
    id: string,
    version: string,
    status: ReviewInputStatus,
    reason: string,
    adminToken: string,
    reviewer = 'operator',
  ) {
    this.requireAdmin(adminToken)
    if (!pluginIdOk(id) || !VERSION_ID.test(version) || !existsSync(join(this.versionDir(id, version), 'manifest.json'))) {
      throw new Error('unknown registry version')
    }
    const current = this.readReview(id, version)
    const next: RegistryReview = {
      ...current,
      status,
      reason: reason.trim(),
      reviewedAt: Date.now(),
      reviewedBy: reviewer.trim() || 'operator',
    }
    this.writeReview(id, version, next)
    if (status === 'approved') {
      this.writeJson(join(this.pluginRoot(), id, 'approved.json'), {
        codeVersion: version,
        updatedAt: next.reviewedAt,
      } satisfies LatestFile)
    }
    await this.rebuildIndex()
    return { id, codeVersion: version, reviewStatus: status, reviewReason: next.reason }
  }

  async listReviews(adminToken: string, status = '') {
    this.requireAdmin(adminToken)
    const names = existsSync(this.pluginRoot()) ? await readdir(this.pluginRoot()) : []
    const rows: RegistryIndexEntry[] = []
    for (const id of names.sort()) {
      if (!pluginIdOk(id)) continue
      for (const version of await this.versions(id)) {
        const review = this.readReview(id, version)
        const row = await this.entryFor(id, version, Math.max(review.submittedAt, review.reviewedAt))
        if (!row || (status && row.reviewStatus !== status)) continue
        rows.push(row)
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private requireOwner(id: string, token: string) {
    const owner = this.readOwner(id)
    if (!owner || !tokensMatch(token.trim(), owner.tokenHash)) throw new Error('plugin owner token required')
    return owner
  }

  private requireAdmin(token: string) {
    if (!this.adminTokenHash || !tokensMatch(token.trim(), this.adminTokenHash)) {
      throw new Error('registry operator token required')
    }
  }

  private readReview(id: string, version: string): RegistryReview {
    const path = join(this.versionDir(id, version), 'review.json')
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryReview>
        const status = String(raw.status ?? '') as RegistryReviewStatus
        if (['pending', 'approved', 'rejected', 'quarantined', 'withdrawn', 'unpublished', 'revoked'].includes(status)) {
          return {
            status,
            reason: String(raw.reason ?? ''),
            submittedAt: Number(raw.submittedAt) || 0,
            reviewedAt: Number(raw.reviewedAt) || 0,
            reviewedBy: String(raw.reviewedBy ?? ''),
            scanStatus: raw.scanStatus === 'blocked' || raw.scanStatus === 'warning' ? raw.scanStatus : 'clean',
            scanIssues: Array.isArray(raw.scanIssues) ? raw.scanIssues.map(String) : [],
          }
        }
      } catch {
        /* legacy version defaults to approved below */
      }
    }
    return {
      status: 'approved',
      reason: '',
      submittedAt: 0,
      reviewedAt: 0,
      reviewedBy: 'legacy',
      scanStatus: 'clean',
      scanIssues: [],
    }
  }

  private writeReview(id: string, version: string, review: RegistryReview) {
    this.writeJson(join(this.versionDir(id, version), 'review.json'), review)
  }

  private async publicVersion(id: string) {
    const approved = this.readPointer(id, 'approved.json')
    if (approved && this.readReview(id, approved.codeVersion).status === 'approved') {
      return approved.codeVersion
    }
    const latest = this.readLatest(id)
    const versions = await this.versions(id)
    const ordered = [
      ...(latest ? [latest.codeVersion] : []),
      ...versions
        .filter((version) => version !== latest?.codeVersion)
        .sort((a, b) => {
          const left = this.readReview(id, a)
          const right = this.readReview(id, b)
          return Math.max(right.reviewedAt, right.submittedAt) - Math.max(left.reviewedAt, left.submittedAt)
        }),
    ]
    return ordered.find((version) => this.readReview(id, version).status === 'approved') ?? ''
  }

  private async entryFor(id: string, version: string, updatedAt: number): Promise<RegistryIndexEntry | null> {
    const owner = this.readOwner(id)
    const dir = this.versionDir(id, version)
    if (!owner || !existsSync(join(dir, 'manifest.json'))) return null
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const readme = await this.readText(id, version, 'README.md')
    let bytes = 0
    for (const name of TEXT_FILES) {
      const file = join(dir, name)
      if (existsSync(file)) bytes += (await stat(file)).size
    }
    const review = this.readReview(id, version)
    return {
      id,
      name: String(manifest.name ?? id),
      blurb: String(manifest.blurb ?? ''),
      tags: parseTags(manifest.tags),
      author: String(manifest.author ?? ''),
      headless: manifest.headless === true,
      hasHost: existsSync(join(dir, 'host.js')),
      hasWeb: existsSync(join(dir, 'web.js')),
      bytes,
      updatedAt,
      codeVersion: version,
      ownerId: owner.ownerId,
      provides: parseProvides(manifest.provides),
      readmeExcerpt: readme.trim().slice(0, README_EXCERPT),
      reviewStatus: review.status,
      reviewReason: review.reason,
      scanStatus: review.scanStatus,
      scanIssues: review.scanIssues,
    }
  }

  private versionDir(id: string, version: string) {
    return join(this.pluginRoot(), id, version)
  }

  private async versions(id: string) {
    const dir = join(this.pluginRoot(), id)
    if (!existsSync(dir)) return []
    const names = await readdir(dir)
    const versions: string[] = []
    for (const name of names) {
      if (!VERSION_ID.test(name)) continue
      if (existsSync(join(dir, name, 'manifest.json'))) versions.push(name)
    }
    return versions.sort()
  }

  private readOwner(id: string): OwnerFile | null {
    const path = join(this.pluginRoot(), id, 'owner.json')
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerFile>
      const ownerId = String(raw.ownerId ?? '')
      const hash = String(raw.tokenHash ?? '')
      if (!/^own_[a-f0-9]{16}$/.test(ownerId) || !/^[a-f0-9]{64}$/.test(hash)) return null
      return { ownerId, tokenHash: hash }
    } catch {
      return null
    }
  }

  private async readText(id: string, version: string, name: string) {
    const path = join(this.versionDir(id, version), name)
    if (!existsSync(path)) return ''
    return readFile(path, 'utf8')
  }

  private async readIndex(): Promise<RegistryIndexEntry[]> {
    const path = join(this.dataDir, 'index.json')
    if (!existsSync(path)) return this.rebuildIndex()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return Array.isArray(raw)
        ? (raw as RegistryIndexEntry[]).map((row) => ({
            ...row,
            reviewStatus: row.reviewStatus ?? 'approved',
            reviewReason: row.reviewReason ?? '',
            scanStatus: row.scanStatus ?? 'clean',
            scanIssues: row.scanIssues ?? [],
          }))
        : []
    } catch {
      return this.rebuildIndex()
    }
  }

  private async rebuildIndex() {
    const root = this.pluginRoot()
    const names = existsSync(root) ? await readdir(root) : []
    const rows: RegistryIndexEntry[] = []
    for (const id of names.sort()) {
      if (!pluginIdOk(id)) continue
      const version = await this.publicVersion(id)
      if (!version) continue
      const latest = this.readLatest(id)
      const row = await this.entryFor(id, version, latest?.updatedAt ?? 0)
      if (row) rows.push(row)
    }
    this.writeJson(join(this.dataDir, 'index.json'), rows)
    return rows
  }

  private readLatest(id: string): LatestFile | null {
    return this.readPointer(id, 'latest.json')
  }

  private readPointer(id: string, name: string): LatestFile | null {
    const path = join(this.pluginRoot(), id, name)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LatestFile>
      const codeVersion = String(raw.codeVersion ?? '')
      const updatedAt = Number(raw.updatedAt)
      if (!VERSION_ID.test(codeVersion) || !Number.isFinite(updatedAt)) return null
      return { codeVersion, updatedAt }
    } catch {
      return null
    }
  }

  private writeJson(path: string, value: unknown) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}
