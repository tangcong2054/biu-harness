import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { loadRegistryConfig } from './registry-config.ts'
import { PluginRegistryStore, type PluginBundle, type RegistryReviewStatus } from './registry.ts'

const API_PREFIX = '/api/plugin-registry/v1'
const MAX_BODY_BYTES = 8 * 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown) {
  const json = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'cache-control': 'no-store',
  })
  res.end(json)
}

function bearer(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header
  return /^Bearer\s+(\S+)/i.exec(String(raw ?? '').trim())?.[1] ?? ''
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.from(chunk)
    bytes += part.length
    if (bytes > MAX_BODY_BYTES) throw new Error('plugin bundle too large')
    chunks.push(part)
  }
  if (!bytes) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/too large/.test(message)) return { status: 413, body: { error: message } }
  if (/owned by/.test(message)) return { status: 409, body: { error: message } }
  if (/token required/.test(message)) return { status: 401, body: { error: message } }
  return { status: 400, body: { error: message } }
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

export function createRegistryServer(registry: PluginRegistryStore) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        send(res, 204, null)
        return
      }
      const url = new URL(req.url ?? '/', 'http://registry.local')
      if (req.method === 'GET' && url.pathname === `${API_PREFIX}/health`) {
        send(res, 200, { ok: true, registryId: registry.registryId })
        return
      }
      if (req.method === 'GET' && url.pathname === `${API_PREFIX}/plugins`) {
        const plugins = await registry.search(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('tag') ?? '',
          bearer(req.headers.authorization),
        )
        send(res, 200, { ok: true, registryId: registry.registryId, plugins })
        return
      }
      if (req.method === 'GET' && url.pathname === `${API_PREFIX}/reviews`) {
        const plugins = await registry.listReviews(
          bearer(req.headers.authorization),
          url.searchParams.get('status') ?? '',
        )
        send(res, 200, { ok: true, registryId: registry.registryId, plugins })
        return
      }
      const actionMatch = new RegExp(`^${API_PREFIX}/plugins/([^/]+)/([^/]+)/(withdraw|unpublish|review)$`).exec(url.pathname)
      if (req.method === 'POST' && actionMatch) {
        const id = decode(actionMatch[1] ?? '')
        const version = decode(actionMatch[2] ?? '')
        const action = actionMatch[3]
        const token = bearer(req.headers.authorization)
        if (action === 'withdraw') {
          send(res, 200, { ok: true, ...await registry.withdraw(id, version, token) })
          return
        }
        if (action === 'unpublish') {
          send(res, 200, { ok: true, ...await registry.unpublish(id, version, token) })
          return
        }
        const body = await readJson(req) as { status?: RegistryReviewStatus; reason?: string; reviewer?: string }
        const status =
          body.status === 'approved' || body.status === 'rejected' || body.status === 'quarantined' || body.status === 'revoked'
            ? body.status
            : 'rejected'
        send(res, 200, {
          ok: true,
          ...await registry.review(
            id,
            version,
            status,
            String(body.reason ?? ''),
            token,
            String(body.reviewer ?? 'operator'),
          ),
        })
        return
      }
      const match = new RegExp(`^${API_PREFIX}/plugins/([^/]+)(?:/([^/]+))?$`).exec(url.pathname)
      if (!match) {
        send(res, 404, { error: 'not found' })
        return
      }
      const id = decode(match[1] ?? '')
      const version = decode(match[2] ?? '')
      if (req.method === 'GET' && version) {
        const bundle = await registry.bundle(id, version, bearer(req.headers.authorization))
        send(res, bundle ? 200 : 404, bundle ?? { error: 'not found' })
        return
      }
      if (req.method === 'GET') {
        const detail = await registry.detail(id, bearer(req.headers.authorization))
        send(res, detail ? 200 : 404, detail ?? { error: 'not found' })
        return
      }
      if (req.method === 'PUT' && !version) {
        const raw = await readJson(req)
        const body = raw && typeof raw === 'object' ? raw as Partial<PluginBundle> : {}
        const files = body.files && typeof body.files === 'object' ? body.files : {}
        const assets = body.assets && typeof body.assets === 'object' ? body.assets : {}
        const published = await registry.publish(id, files, assets, bearer(req.headers.authorization))
        send(res, 200, { ok: true, ...published })
        return
      }
      send(res, 405, { error: 'method not allowed' })
    } catch (error) {
      const result = errorResponse(error)
      send(res, result.status, result.body)
    }
  })
}

export async function startRegistryServer() {
  const config = loadRegistryConfig()
  const registry = new PluginRegistryStore(config.dataDir, config.id)
  const server = createRegistryServer(registry)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listenPort, config.listenHost, () => resolve())
  })
  console.log(
    `plugin registry ${config.id} listening on http://${config.listenHost}:${config.listenPort}${API_PREFIX}`,
  )
  console.log(`plugin registry data: ${config.dataDir}`)
  return server
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void startRegistryServer().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
