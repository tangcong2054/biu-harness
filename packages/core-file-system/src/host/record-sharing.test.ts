import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context, Service } from 'cordis'
import { AccountService } from '@biu/host-account'
import { runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { DatabaseService } from './index.ts'
import { AgentDbCompact } from './agent-payload.ts'
import { parseSharingAction, parseSharingUpdate, RECORD_SHARING_ACTIONS, RECORD_SHARING_SCHEMA } from './record-sharing.ts'
import { withBuiltinFields, type DbRecord } from '@biu/type-file-system'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function setupSharing() {
  vi.stubEnv('BIU_ONLINE', '1')
  vi.stubEnv('BIU_REMOTE_ORIGIN', '')
  const ctx = new Context()
  contexts.push(ctx)
  const db = new DatabaseService(ctx)
  const rows = new Map<string, DbRecord>([['n1', { id: 'n1', title: 'Note' }]])
  const update = vi.fn((id: string, patch: Record<string, unknown>) => {
    const next = { ...rows.get(id)!, ...patch }
    rows.set(id, next)
    return next
  })
  db.register({
    id: 'notes', path: '/notes', records: { update: true },
    schema: { fields: withBuiltinFields({ title: { type: 'string', writable: true } }) },
    get: (id) => rows.get(id), list: () => [...rows.values()], update,
  })
  const account = new AccountService(ctx, { sqlitePath: ':memory:' })
  const ada = account.store.register('Ada', Date.now(), randomUUID(), 'ada@example.test')
  const bob = account.store.register('Bob', Date.now(), randomUUID(), 'bob@example.test')
  const carol = account.store.register('Carol', Date.now(), randomUUID(), 'carol@example.test')
  const workspace = account.store.createWorkspace(ada.id, 'Shared')
  account.store.addMemberByEmail(ada.id, workspace.id, bob.email)
  account.store.setActive(ada.id, workspace.id)
  account.store.setActive(bob.id, workspace.id)
  const as = <T>(id: string, run: () => T) => runWithAccount(id, () => runWithRequestWorkspace(workspace.id, run))
  as(ada.id, () => account.store.attach(workspace.id, '/notes', 'n1'))
  const resource = { type: 'record' as const, workspaceId: workspace.id, collection: '/notes', recordId: 'n1' }
  return { ctx, db, account, ada, bob, carol, workspace, as, resource, update }
}

describe('record sharing service', () => {
  it('updates public links without touching business fields and keeps unspecified settings', async () => {
    const { db, ada, as, update } = setupSharing()
    const password = randomUUID()
    const first = await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true, password, allowCopy: false } } }))
    const share = as(ada.id, () => db.shares.findRecord('/notes', 'n1'))!
    expect(first.result).toMatchObject({ sharing: { publicLink: { enabled: true, hasPassword: true, allowCopy: false, token: share.token } } })
    expect(JSON.stringify(first.result)).not.toContain(password)
    expect(update).not.toHaveBeenCalled()
    await as(ada.id, () => db.update('/notes/n1', JSON.stringify({ sharing: { publicLink: { sharePlugins: true } } })))
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))).toMatchObject({ token: share.token, allowCopy: false, hasPassword: true, sharePlugins: true })
    await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { password: null } } }))
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))?.hasPassword).toBe(false)
    const closed = await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: false } } }))
    expect(closed.result).toEqual({ sharing: { publicLink: { enabled: false } } })
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))).toBeNull()
  })

  it('rejects implicit publication, mixed updates and writes to computed sharing fields', async () => {
    const { db, ada, as, update } = setupSharing()
    for (const content of [
      { sharing: { publicLink: { allowCopy: false } } },
      { title: 'Changed', sharing: { publicLink: { enabled: true } } },
      { shareScope: '共享' },
      { shareRole: '管理' },
    ]) await expect(as(ada.id, () => db.update('/notes/n1', content))).rejects.toThrow()
    expect(update).not.toHaveBeenCalled()
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))).toBeNull()
  })

  it('requires share permission rather than ordinary editor permission', async () => {
    const { db, account, ada, bob, carol, as, resource } = setupSharing()
    as(ada.id, () => account.authorization.grant(ada.id, resource, 'account', bob.id, 'editor'))
    await as(bob.id, () => db.update('/notes/n1', { title: 'Edited' }))
    await expect(as(bob.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } }))).rejects.toThrow(/permission denied|unknown record/)
    for (const [action, args] of [
      ['sharing_get', {}],
      ['sharing_invite', { email: carol.email }],
      ['sharing_revoke', { accountId: ada.id }],
    ] as const) await expect(as(bob.id, () => db.action('/notes/n1', action, args))).rejects.toThrow(/permission denied|unknown record/)
    await expect(db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } })).rejects.toThrow()
  })

  it('invites a registered collaborator, reports permissions and revokes only direct access', async () => {
    const { db, account, ada, carol, as, resource } = setupSharing()
    await as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: carol.email }))
    expect(as(ada.id, () => account.store.recordAccess(ada.id, '/notes', 'n1')).people).toEqual(expect.arrayContaining([expect.objectContaining({ id: carol.id, role: 'viewer' })]))
    const state = await as(ada.id, () => db.action('/notes/n1', 'sharing_get'))
    expect(state.result).toMatchObject({ sharing: { collaborationAvailable: true, publicLink: { enabled: false } } })
    await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } }))
    await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: false } } }))
    expect(as(carol.id, () => account.authorization.requireCurrent('resource:read', resource))).toBeDefined()
    await as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: carol.email, role: 'editor' }))
    await as(carol.id, () => db.update('/notes/n1', { title: 'Collaborative edit' }))
    await as(ada.id, () => db.action('/notes/n1', 'sharing_revoke', { accountId: carol.id }))
    expect(as(ada.id, () => account.store.recordAccess(ada.id, '/notes', 'n1')).people).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: carol.id })]))
    await expect(as(carol.id, () => db.action('/notes/n1', 'sharing_get'))).rejects.toThrow()
  })

  it('grants internal members access without converting membership or implicitly joining outsiders', async () => {
    const { db, account, ada, bob, carol, as, workspace } = setupSharing()
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: bob.email }))).rejects.toThrow(/内部空间成员/)
    await as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: bob.email, role: 'editor', collaboratorKind: 'internal' }))
    expect(as(ada.id, () => account.store.recordAccess(ada.id, '/notes', 'n1')).people).toEqual(expect.arrayContaining([expect.objectContaining({ id: bob.id, role: 'editor' })]))
    await as(bob.id, () => db.update('/notes/n1', { title: 'Internal edit' }))
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: carol.email, collaboratorKind: 'internal' }))).rejects.toThrow(/必须先加入当前空间/)
    expect(account.store.isMember(carol.id, workspace.id)).toBe(false)
    await as(ada.id, () => db.action('/notes/n1', 'sharing_revoke', { accountId: bob.id }))
    expect(account.store.isMember(bob.id, workspace.id)).toBe(true)
  })

  it('rejects unknown emails and owner grants without changing access', async () => {
    const { db, ada, as } = setupSharing()
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: 'missing@example.test' }))).rejects.toThrow()
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: 'bob@example.test', role: 'owner' }))).rejects.toThrow()
    await expect(as(ada.id, () => db.action('/notes/missing', 'sharing_invite', { email: 'bob@example.test' }))).rejects.toThrow(/unknown record/)
  })

  it('advertises sharing through db_stat without adding business columns', async () => {
    const { db, ada, as } = setupSharing()
    const stat = await as(ada.id, () => db.stat('/notes'))
    expect(stat.schema?.sharing).toEqual(RECORD_SHARING_SCHEMA)
    expect(stat.schema?.fields.sharing).toBeUndefined()
    expect(stat.schema?.actions?.filter((action) => action.id.startsWith('sharing_'))).toHaveLength(3)
    expect(stat.schema?.fields.shareScope.writable).toBe(false)
  })

  it('forwards direct agent calls with scoped credentials and never falls back after a remote failure', async () => {
    const { db, account, ada, as, workspace, update } = setupSharing()
    vi.stubEnv('BIU_ONLINE', '0')
    vi.stubEnv('BIU_REMOTE_ORIGIN', 'https://cloud.example.test')
    vi.spyOn(account, 'workspaceLocation').mockReturnValue('cloud')
    const token = randomUUID()
    vi.spyOn(account, 'linkedCloud').mockReturnValue({
      localAccountId: ada.id, origin: 'https://cloud.example.test', remoteAccountId: 'remote-ada',
      remoteName: 'Ada', remoteEmail: ada.email, token, connectedAt: Date.now(),
    })
    const remoteResult = { kind: 'record', path: '/notes/n1', value: { id: 'n1' }, result: { sharing: { publicLink: { enabled: true, url: 'https://cloud.example.test/share/link' } } } }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(remoteResult)))
    const content = { sharing: { publicLink: { enabled: true } } }
    expect(await as(ada.id, () => db.update('/notes/n1', content))).toEqual(remoteResult)
    expect(fetcher).toHaveBeenLastCalledWith('https://cloud.example.test/api/db/update', expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${token}`, 'x-biu-workspace-id': workspace.id }),
      body: JSON.stringify({ path: '/notes/n1', content }),
    }))
    await as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: 'bob@example.test' }))
    expect(fetcher).toHaveBeenLastCalledWith('https://cloud.example.test/api/db/action', expect.objectContaining({
      body: JSON.stringify({ path: '/notes/n1', action: 'sharing_invite', args: { email: 'bob@example.test' } }),
    }))
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: 'denied', code: 'FORBIDDEN' }), { status: 403 }))
    await expect(as(ada.id, () => db.update('/notes/n1', content))).rejects.toThrow('denied')
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_revoke', { accountId: 'bob' }))).rejects.toThrow('denied')
    expect(update).not.toHaveBeenCalled()
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))).toBeNull()
  })

  it('uses MySQL permissions and request tenancy for invitations, reads and revocations', async () => {
    vi.stubEnv('BIU_ONLINE', '1')
    vi.stubEnv('BIU_REMOTE_ORIGIN', '')
    const ctx = new Context()
    contexts.push(ctx)
    const shareRecordWithEmail = vi.fn().mockResolvedValue({ id: 'carol' })
    const revokeRecordGrant = vi.fn().mockResolvedValue(undefined)
    const recordAccess = vi.fn().mockResolvedValue({ scope: 'personal', ownerId: 'ada', people: [] })
    class Cloud extends Service {
      accountMode = 'mysql'
      accountRepository = {
        membership: async (accountId: string, workspaceId: string) => workspaceId === 'ws-a'
          ? { role: accountId === 'ada' ? 'owner' : 'member', memberKind: 'member' } : null,
        collectionScopeSources: async () => ({
          policies: { n1: { ownership: 'workspace', accessMode: 'members', ownerAccountId: 'ada', memberDefaultRole: 'editor', parentCollection: '', parentRecordId: '' } },
          owners: ['n1'],
        }),
        collectionGrantSources: async () => ({ records: {}, views: [], savedViews: [] }),
        shareRecordWithEmail, revokeRecordGrant, recordAccess,
      }
      constructor() { super(ctx, 'cloudStorage') }
    }
    new Cloud()
    new AccountService(ctx, { sqlitePath: ':memory:' })
    const db = new DatabaseService(ctx)
    db.register({
      id: 'notes', path: '/notes', schema: { fields: withBuiltinFields({}) },
      get: (id) => id === 'n1' ? { id } : null, list: () => [{ id: 'n1' }],
    })
    const as = <T>(id: string, workspace: string, run: () => T) => runWithAccount(id, () => runWithRequestWorkspace(workspace, run))
    await as('ada', 'ws-a', () => db.action('/notes/n1', 'sharing_invite', { email: 'carol@example.test' }))
    expect(shareRecordWithEmail).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'ada', workspaceId: 'ws-a', collection: '/notes', recordId: 'n1', role: 'viewer' }))
    await as('ada', 'ws-a', () => db.action('/notes/n1', 'sharing_get'))
    expect(recordAccess).toHaveBeenCalledWith('ada', 'ws-a', '/notes', 'n1')
    await as('ada', 'ws-a', () => db.action('/notes/n1', 'sharing_revoke', { accountId: 'carol' }))
    expect(revokeRecordGrant).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'ada', workspaceId: 'ws-a', subjectType: 'account', subjectId: 'carol' }))
    await expect(as('bob', 'ws-a', () => db.action('/notes/n1', 'sharing_invite', { email: 'carol@example.test' }))).rejects.toThrow()
    await expect(as('ada', 'ws-other', () => db.action('/notes/n1', 'sharing_revoke', { accountId: 'carol' }))).rejects.toThrow()
    await expect(as('bob', 'ws-a', () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } }))).rejects.toThrow()
    expect(shareRecordWithEmail).toHaveBeenCalledTimes(1)
    expect(revokeRecordGrant).toHaveBeenCalledTimes(1)
    recordAccess.mockRejectedValue(Object.assign(new Error('lost access'), { code: 'ACCESS_DETAILS_DENIED', status: 403 }))
    const revoked = await as('ada', 'ws-a', () => db.action('/notes/n1', 'sharing_revoke', { accountId: 'ada' }))
    expect(revoked.result).toEqual({ sharing: { access: { ok: true, access: null } } })
  })

  it('fails closed on desktop cloud workspaces without a linked credential', async () => {
    const { db, account, ada, as } = setupSharing()
    vi.stubEnv('BIU_ONLINE', '0')
    vi.spyOn(account, 'workspaceLocation').mockReturnValue('cloud')
    await expect(as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } }))).rejects.toThrow(/云端账号/)
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: 'bob@example.test' }))).rejects.toThrow(/云端账号/)
    expect(as(ada.id, () => db.shares.findRecord('/notes', 'n1'))).toBeNull()
  })

  it('supports device link sharing but rejects device collaborator invitations', async () => {
    const { db, account, ada, as } = setupSharing()
    vi.stubEnv('BIU_ONLINE', '0')
    vi.spyOn(account, 'workspaceLocation').mockReturnValue('device')
    await as(ada.id, () => db.update('/notes/n1', { sharing: { publicLink: { enabled: true } } }))
    const state = await as(ada.id, () => db.action('/notes/n1', 'sharing_get'))
    expect(state.result).toMatchObject({ sharing: { collaborationAvailable: false, publicLink: { enabled: true }, access: null } })
    await expect(as(ada.id, () => db.action('/notes/n1', 'sharing_invite', { email: 'bob@example.test' }))).rejects.toThrow(/本机空间/)
  })
})

describe('record sharing protocol', () => {
  it('preserves omitted link settings and accepts explicit password removal', () => {
    expect(parseSharingUpdate({ sharing: { publicLink: { allowCopy: false } } })).toEqual({ allowCopy: false })
    expect(parseSharingUpdate({ sharing: { publicLink: { enabled: true, password: null } } })).toEqual({ enabled: true, password: null })
  })

  it.each([
    { title: 'changed', sharing: { publicLink: { enabled: true } } },
    { banner: null, sharing: { publicLink: { enabled: true } } },
    { sharing: null },
    { sharing: {} },
    { sharing: { publicLink: [] } },
    { sharing: { publicLink: {} } },
    { sharing: { publicLink: { enabled: 'false' } } },
    { sharing: { publicLink: { allowCopy: 1 } } },
    { sharing: { publicLink: { password: 123 } } },
    { sharing: { publicLink: { password: 'x'.repeat(1025) } } },
    { sharing: { publicLink: { enabled: false, allowCopy: false } } },
    { sharing: { publicLink: { enabled: true }, role: 'owner' } },
    { sharing: { publicLink: { enabled: true, workspaceId: 'other' } } },
  ])('rejects malformed or ambiguous sharing updates: %j', (content) => {
    expect(() => parseSharingUpdate(content)).toThrow()
  })

  it('defaults invitations to viewer and accepts only explicit collaborative roles', () => {
    expect(parseSharingAction('sharing_invite', { email: ' ADA@example.com ' })).toEqual({ email: 'ada@example.com', role: 'viewer', collaboratorKind: 'external' })
    expect(parseSharingAction('sharing_invite', { email: 'ada@example.com', role: 'editor', collaboratorKind: 'internal' })).toEqual({ email: 'ada@example.com', role: 'editor', collaboratorKind: 'internal' })
    expect(() => parseSharingAction('sharing_invite', { email: 'ada@example.com', collaboratorKind: 'guest' })).toThrow()
    expect(() => parseSharingAction('sharing_invite', { email: 'ada@example.com', role: 'owner' })).toThrow()
    expect(() => parseSharingAction('sharing_invite', { email: 'bad-email' })).toThrow()
    expect(() => parseSharingAction('sharing_invite', { email: 'ada@example.com', workspaceId: 'other' })).toThrow()
  })

  it('requires a specific account for revocation and rejects additional read parameters', () => {
    expect(parseSharingAction('sharing_revoke', { accountId: 'ada' })).toEqual({ accountId: 'ada' })
    expect(() => parseSharingAction('sharing_revoke', {})).toThrow()
    expect(() => parseSharingAction('sharing_revoke', { accountId: 'ada', all: true })).toThrow()
    expect(parseSharingAction('sharing_get')).toEqual({})
    expect(() => parseSharingAction('sharing_get', { workspaceId: 'other' })).toThrow()
  })

  it('keeps sharing instructions, action schemas and operation results in agent payloads', () => {
    const compact = new AgentDbCompact()
    const schema = compact.schema({ fields: withBuiltinFields({}), sharing: RECORD_SHARING_SCHEMA, actions: RECORD_SHARING_ACTIONS })
    expect(schema.sharing).toEqual(RECORD_SHARING_SCHEMA)
    expect(schema.actions).toHaveLength(3)
    expect(compact.write({ kind: 'record', path: '/notes/n1', result: { sharing: { publicLink: { enabled: false } } } })).toEqual({
      ok: true,
      path: '/notes/n1',
      result: { sharing: { publicLink: { enabled: false } } },
    })
  })
})
