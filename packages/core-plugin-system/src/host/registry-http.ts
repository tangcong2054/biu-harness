import type { Context } from 'cordis'
import { PluginRegistryStore, type PluginBundle, type RegistryReviewStatus } from './registry.ts'

function bearer(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header
  const match = /^Bearer\s+(\S+)/i.exec(String(raw ?? '').trim())
  return match?.[1] ?? ''
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/owned by/.test(message)) return { status: 409, body: { error: message } }
  if (/token required/.test(message)) return { status: 401, body: { error: message } }
  return { status: 400, body: { error: message } }
}

export function registerRegistryRoutes(
  ctx: Context,
  registry: PluginRegistryStore,
  options: { operations?: boolean } = {},
) {
  ctx.http.route('GET', '/api/plugin-registry/v1/plugins', async (route) => {
    const rows = await registry.search(route.query.get('q') ?? '', route.query.get('tag') ?? '', bearer(route.req.headers.authorization))
    route.send(200, { ok: true, registryId: registry.registryId, plugins: rows })
  })

  ctx.http.route('GET', '/api/plugin-registry/v1/plugins/:id/:version', async (route) => {
    const bundle = await registry.bundle(route.params.id, route.params.version, bearer(route.req.headers.authorization))
    if (!bundle) {
      route.send(404, { error: 'not found' })
      return
    }
    route.send(200, bundle)
  })

  ctx.http.route('GET', '/api/plugin-registry/v1/plugins/:id', async (route) => {
    const row = await registry.detail(route.params.id, bearer(route.req.headers.authorization))
    if (!row) {
      route.send(404, { error: 'not found' })
      return
    }
    route.send(200, row)
  })

  ctx.http.route('PUT', '/api/plugin-registry/v1/plugins/:id', async (route) => {
    try {
      const body = await route.json<Partial<PluginBundle>>()
      const files = body?.files && typeof body.files === 'object' ? body.files : {}
      const assets = body?.assets && typeof body.assets === 'object' ? body.assets : {}
      if (Buffer.byteLength(JSON.stringify(body ?? {})) > 8 * 1024 * 1024) {
        route.send(413, { error: 'plugin bundle too large' })
        return
      }
      const published = await registry.publish(route.params.id, files, assets, bearer(route.req.headers.authorization))
      route.send(200, { ok: true, ...published })
    } catch (error) {
      const result = fail(error)
      route.send(result.status, result.body)
    }
  })

  ctx.http.route('POST', '/api/plugin-registry/v1/plugins/:id/:version/withdraw', async (route) => {
    try {
      route.send(200, { ok: true, ...await registry.withdraw(route.params.id, route.params.version, bearer(route.req.headers.authorization)) })
    } catch (error) {
      const result = fail(error)
      route.send(result.status, result.body)
    }
  })

  ctx.http.route('POST', '/api/plugin-registry/v1/plugins/:id/:version/unpublish', async (route) => {
    try {
      route.send(200, { ok: true, ...await registry.unpublish(route.params.id, route.params.version, bearer(route.req.headers.authorization)) })
    } catch (error) {
      const result = fail(error)
      route.send(result.status, result.body)
    }
  })

  if (options.operations) {
    ctx.http.route('GET', '/api/plugin-registry/v1/reviews', async (route) => {
      try {
        const plugins = await registry.listReviews(bearer(route.req.headers.authorization), route.query.get('status') ?? '')
        route.send(200, { ok: true, registryId: registry.registryId, plugins })
      } catch (error) {
        const result = fail(error)
        route.send(result.status, result.body)
      }
    })

    ctx.http.route('POST', '/api/plugin-registry/v1/plugins/:id/:version/review', async (route) => {
      try {
        const body = await route.json<{ status?: RegistryReviewStatus; reason?: string; reviewer?: string }>()
        const status =
          body.status === 'approved' || body.status === 'rejected' || body.status === 'quarantined' || body.status === 'revoked'
            ? body.status
            : 'rejected'
        route.send(200, {
          ok: true,
          ...await registry.review(
            route.params.id,
            route.params.version,
            status,
            String(body.reason ?? ''),
            bearer(route.req.headers.authorization),
            String(body.reviewer ?? 'operator'),
          ),
        })
      } catch (error) {
        const result = fail(error)
        route.send(result.status, result.body)
      }
    })
  }
}
