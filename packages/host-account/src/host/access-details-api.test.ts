import { Context, Service } from 'cordis'
import { expect, test, vi } from 'vitest'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { apply } from './index.ts'

class Route {
  req = { headers: { authorization: 'Bearer test' }, method: 'GET' }
  res = { setHeader: () => undefined }
  query = new URLSearchParams({ collection: '/pages', recordId: 'p1' })
  params = {}
  status = 0
  payload: unknown
  body: Record<string, unknown> = {}
  async json() { return this.body }
  send(status: number, payload: unknown) { this.status = status; this.payload = payload }
}

class Http extends Service {
  routes = new Map<string, (route: Route) => Promise<void>>()
  constructor(ctx: Context) { super(ctx, 'http') }
  route(method: string, path: string, handler: (route: Route) => Promise<void>) {
    this.routes.set(`${method} ${path}`, handler)
  }
}

test('access detail GET uses the request workspace and returns 403 without collaborator data', async () => {
  const previous = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '1'
  const ctx = new Context()
  try {
    const denial = Object.assign(new Error('denied'), { code: 'ACCESS_DETAILS_DENIED', status: 403 })
    const recordAccess = vi.fn().mockRejectedValue(denial)
    const revokeRecordGrant = vi.fn().mockResolvedValue(undefined)
    const grantRecord = vi.fn().mockResolvedValue(undefined)
    const shareRecordWithEmail = vi.fn().mockResolvedValue({ id: 'recipient' })
    class Cloud extends Service {
      accountMode = 'mysql'
      accountRepository = {
        accountByTokenHash: async () => ({ id: 'bob', activeWorkspaceId: 'default-workspace' }),
        isSuspended: async () => false,
        recordAccess,
        revokeRecordGrant,
        grantRecord,
        shareRecordWithEmail,
      }
      constructor(ctx: Context) { super(ctx, 'cloudStorage') }
    }
    new Cloud(ctx)
    const http = new Http(ctx)
    apply(ctx, { sqlitePath: ':memory:' })
    const route = new Route()
    await runWithRequestWorkspace('requested-workspace', () => http.routes.get('GET /api/account/access')!(route))
    expect(recordAccess).toHaveBeenCalledWith('bob', 'requested-workspace', '/pages', 'p1')
    expect(route.status).toBe(403)
    expect(route.payload).toEqual({ code: 'ACCESS_DETAILS_DENIED', error: 'denied' })
    recordAccess.mockResolvedValue({ scope: 'personal', people: [] })
    await runWithRequestWorkspace('requested-workspace', () => http.routes.get('GET /api/account/access')!(route))
    expect(route.status).toBe(200)
    recordAccess.mockRejectedValue(denial)
    for (const [method, extra] of [
      ['DELETE', { subjectType: 'account', subjectId: 'bob' }],
      ['POST', { groupId: 'group' }],
      ['POST', { email: 'recipient@example.test' }],
    ] as const) {
      route.body = { collection: '/pages', recordId: 'p1', ...extra }
      await runWithRequestWorkspace('requested-workspace', () => http.routes.get(`${method} /api/account/access`)!(route))
      expect(route.status).toBe(200)
      expect(route.payload).toEqual({ ok: true, access: null })
    }
    expect(revokeRecordGrant).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'requested-workspace' }))
    expect(grantRecord).toHaveBeenCalledOnce()
    expect(shareRecordWithEmail).toHaveBeenCalledOnce()
    revokeRecordGrant.mockRejectedValueOnce(denial)
    await runWithRequestWorkspace('requested-workspace', () => http.routes.get('DELETE /api/account/access')!(route))
    expect(route.status).toBe(403)
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previous
  }
})
