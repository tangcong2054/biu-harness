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

export class PluginRegistryStore {
  constructor(
    readonly dataDir: string,
    readonly registryId: string,
  ) {
    if (!pluginIdOk(registryId)) throw new Error(`invalid plugin registry id: ${registryId}`)
    mkdirSync(this.pluginRoot(), { recursive: true })
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

  async search(q = '', tag = ''): Promise<RegistryIndexEntry[]> {
    const index = await this.readIndex()
    const query = q.trim().toLowerCase()
    const wanted = tag.trim().toLowerCase()
    return index.filter((row) => {
      if (wanted && !row.tags.some((item) => item.toLowerCase() === wanted)) return false
      if (!query) return true
      const aliases = row.provides.flatMap((item) => [item.kind, item.label, ...item.aliases])
      const hay = [row.id, row.name, row.blurb, row.readmeExcerpt, ...row.tags, ...aliases].join('\n').toLowerCase()
      return hay.includes(query)
    })
  }

  async detail(id: string): Promise<RegistryDetail | null> {
    if (!pluginIdOk(id)) return null
    const index = await this.readIndex()
    const row = index.find((item) => item.id === id)
    if (!row) return null
    const versions = await this.versions(id)
    const readme = await this.readText(id, row.codeVersion, 'README.md')
    return { ...row, registryId: this.registryId, readme, versions }
  }

  async bundle(id: string, version: string): Promise<PluginBundle | null> {
    if (!pluginIdOk(id) || !VERSION_ID.test(version)) return null
    const dir = this.versionDir(id, version)
    if (!existsSync(join(dir, 'manifest.json'))) return null
    const owner = this.readOwner(id)
    if (!owner) return null
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
    if (!existsSync(join(dest, 'manifest.json'))) {
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
    this.writeJson(join(this.pluginRoot(), id, 'owner.json'), {
      ownerId,
      tokenHash: tokenHash(secret),
    } satisfies OwnerFile)
    this.writeJson(join(this.pluginRoot(), id, 'latest.json'), {
      codeVersion,
      updatedAt: now,
    } satisfies LatestFile)
    await this.rebuildIndex()
    return { id, codeVersion, ownerId, registryId: this.registryId, updatedAt: now }
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
      return Array.isArray(raw) ? raw as RegistryIndexEntry[] : []
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
      const latest = this.readLatest(id)
      const owner = this.readOwner(id)
      if (!latest || !owner) continue
      const dir = this.versionDir(id, latest.codeVersion)
      if (!existsSync(join(dir, 'manifest.json'))) continue
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
      const readme = await this.readText(id, latest.codeVersion, 'README.md')
      let bytes = 0
      for (const name of TEXT_FILES) {
        const file = join(dir, name)
        if (!existsSync(file)) continue
        bytes += (await stat(file)).size
      }
      rows.push({
        id,
        name: String(manifest.name ?? id),
        blurb: String(manifest.blurb ?? ''),
        tags: parseTags(manifest.tags),
        author: String(manifest.author ?? ''),
        headless: manifest.headless === true,
        hasHost: existsSync(join(dir, 'host.js')),
        hasWeb: existsSync(join(dir, 'web.js')),
        bytes,
        updatedAt: latest.updatedAt,
        codeVersion: latest.codeVersion,
        ownerId: owner.ownerId,
        provides: parseProvides(manifest.provides),
        readmeExcerpt: readme.trim().slice(0, README_EXCERPT),
      })
    }
    this.writeJson(join(this.dataDir, 'index.json'), rows)
    return rows
  }

  private readLatest(id: string): LatestFile | null {
    const path = join(this.pluginRoot(), id, 'latest.json')
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
