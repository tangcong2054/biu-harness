import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { MysqlAccountRepository } from './mysql-account-repositories.ts'

/**
 * 真实 MySQL：视图协作详情的读取与写入权限。
 * 需要 BIU_VIEW_TEST_MYSQL_URL 指向已初始化的专用测试库（scripts/bootstrap-mysql-test-db.mts）。
 * 每个用例用随机前缀的空间和账号，结束时只删除本次写入的行。
 */
const url = process.env.BIU_VIEW_TEST_MYSQL_URL
const integration = url ? describe : describe.skip

integration('MySQL view access details and view sharing permissions', () => {
  const prefix = `va_${randomBytes(4).toString('hex')}_`
  let database = ''
  let pool: Pool
  let repo: MysqlAccountRepository
  let seq = 0
  let ws = ''
  const id = (name: string) => `${prefix}${seq}_${name}`
  const denied = { status: 403 }

  const account = async (name: string) => {
    await pool.query(
      `INSERT INTO \`${database}\`.accounts (id, name, token, created_at, email, password_recall)
       VALUES (?, ?, ?, ?, ?, '')`,
      [id(name), name, id(`${name}_token`), Date.now(), `${id(name)}@example.test`],
    )
    return id(name)
  }
  const member = async (accountId: string, role: string, kind = 'member') => {
    await pool.query(
      `INSERT INTO \`${database}\`.workspace_members (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
       VALUES (?, ?, ?, ?, '', '', ?)`,
      [ws, accountId, role, Date.now(), kind],
    )
  }
  const savedView = async (viewId: string, payload: Record<string, unknown>) => {
    await pool.query(
      `INSERT INTO \`${database}\`.saved_views (workspace_id, collection, view_id, payload_json, updated_at)
       VALUES (?, '/pages', ?, ?, ?)`,
      [ws, viewId, JSON.stringify({ id: viewId, name: viewId, ...payload }), Date.now()],
    )
  }
  const grant = async (viewId: string, subjectId: string, grantedBy: string) => {
    await pool.query(
      `INSERT INTO \`${database}\`.view_grants (workspace_id, collection, view_id, subject_type, subject_id, role, granted_by, created_at)
       VALUES (?, '/pages', ?, 'account', ?, 'viewer', ?, ?)`,
      [ws, viewId, subjectId, grantedBy, Date.now()],
    )
  }
  const grants = async (viewId: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT subject_id, granted_by FROM \`${database}\`.view_grants WHERE workspace_id = ? AND view_id = ? ORDER BY subject_id`,
      [ws, viewId],
    )
    return rows.map((row) => `${row.subject_id}<-${row.granted_by}`)
  }
  const read = (actor: string, viewId: string) => repo.viewAccess(actor, ws, '/pages', viewId)
  const share = (actor: string, viewId: string, email: string) => repo.shareViewWithEmail({
    actorId: actor, workspaceId: ws, collection: '/pages', viewId, email, role: 'viewer', collaboratorKind: 'internal', now: Date.now(),
  })
  const grantMemberView = (actor: string, viewId: string) => repo.grantView({
    actorId: actor, workspaceId: ws, collection: '/pages', viewId, subjectType: 'member_view', subjectId: 'builtin-member:all', role: 'viewer', now: Date.now(),
  })
  const revoke = (actor: string, viewId: string, subjectId: string) => repo.revokeView({
    actorId: actor, workspaceId: ws, collection: '/pages', viewId, subjectType: 'account', subjectId,
  })

  let owner = ''
  let admin = ''
  let plain = ''
  let outsider = ''
  let friend = ''

  beforeAll(async () => {
    database = decodeURIComponent(new URL(url!).pathname.replace(/^\/+/, ''))
    if (!/^biu_test[A-Za-z0-9_]{0,55}$/.test(database)) throw new Error('BIU_VIEW_TEST_MYSQL_URL must use a biu_test* database')
    pool = createPool({ uri: url!, connectionLimit: 4 })
    repo = new MysqlAccountRepository(pool, database)
  })

  beforeEach(async () => {
    seq += 1
    ws = id('ws')
    owner = await account('owner')
    admin = await account('admin')
    plain = await account('plain')
    outsider = await account('outsider')
    friend = await account('friend')
    await member(owner, 'owner')
    await member(admin, 'admin')
    await member(plain, 'member')
    await member(friend, 'member')
  })

  afterAll(async () => {
    if (!pool) return
    try {
      for (const table of ['view_grants', 'record_grants', 'saved_views', 'workspace_members', 'authz_revisions', 'workspace_invites']) {
        await pool.query(`DELETE FROM \`${database}\`.\`${table}\` WHERE workspace_id LIKE ?`, [`${prefix}%`])
      }
      await pool.query(`DELETE FROM \`${database}\`.accounts WHERE id LIKE ?`, [`${prefix}%`])
    } finally {
      await pool.end()
    }
  })

  it('lets the view creator (a manager) read and change its collaborators', async () => {
    await savedView('mine', { createdBy: admin })
    await share(admin, 'mine', `${friend}@example.test`)
    const access = await read(admin, 'mine')
    expect(access.people.map((row) => row.id)).toEqual([friend])
    await revoke(admin, 'mine', friend)
    expect((await read(admin, 'mine')).people).toEqual([])
  })

  it('does not reveal collaborator names or emails to ordinary members, outsiders or other managers', async () => {
    await savedView('private', { createdBy: admin })
    await grant('private', friend, admin)
    await expect(read(plain, 'private')).rejects.toMatchObject({ ...denied, code: 'ACCESS_DETAILS_DENIED' })
    await expect(read(outsider, 'private')).rejects.toMatchObject({ ...denied, code: 'ACCESS_DETAILS_DENIED' })
    await expect(read(owner, 'private')).rejects.toMatchObject({ ...denied, code: 'ACCESS_DETAILS_DENIED' })
  })

  it('refuses granting, sharing or revoking on another account view, even for the workspace owner', async () => {
    await savedView('theirs', { createdBy: admin })
    await grant('theirs', friend, admin)
    await expect(share(owner, 'theirs', `${plain}@example.test`)).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    await expect(grantMemberView(owner, 'theirs')).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    await expect(revoke(owner, 'theirs', friend)).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    expect(await grants('theirs')).toEqual([`${friend}<-${admin}`])
  })

  it('applies the same rule to scope-wrapped views and rejects malformed wrappers', async () => {
    await savedView('base', { createdBy: admin })
    const wrapped = `builtin-scope:shared:${encodeURIComponent('base')}`
    await share(admin, wrapped, `${friend}@example.test`)
    expect((await read(admin, wrapped)).people.map((row) => row.id)).toEqual([friend])
    await expect(read(owner, wrapped)).rejects.toMatchObject(denied)
    for (const bad of ['builtin-scope:bad:base', 'builtin-scope:shared:%', 'builtin-scope:shared:builtin-scope%3Ashared%3Abase']) {
      await expect(read(admin, bad)).rejects.toMatchObject(denied)
    }
  })

  it('cannot grant on a deleted view, but can still read and clean up leftover grants', async () => {
    await savedView('gone', { createdBy: admin, deletedAt: 1, revision: 3 })
    await grant('gone', friend, admin)
    await expect(share(admin, 'gone', `${plain}@example.test`)).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    expect((await read(admin, 'gone')).people.map((row) => row.id)).toEqual([friend])
    await revoke(admin, 'gone', friend)
    expect(await grants('gone')).toEqual([])
  })

  it('keeps ordinary members out of view sharing as before', async () => {
    await savedView('plain-view', { createdBy: plain })
    await expect(share(plain, 'plain-view', `${friend}@example.test`)).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    await expect(read(plain, 'plain-view')).rejects.toMatchObject(denied)
  })

  it('lets only the workspace owner manage legacy views without an owner', async () => {
    await savedView('legacy', {})
    await grant('legacy', friend, owner)
    expect((await read(owner, 'legacy')).people.map((row) => row.id)).toEqual([friend])
    await expect(read(admin, 'legacy')).rejects.toMatchObject(denied)
  })

  it('shows each manager only their own grants on the per-person "all" view', async () => {
    const all = 'builtin-all:/pages'
    await grant(all, friend, admin)
    await grant(all, plain, owner)
    expect((await read(admin, all)).people.map((row) => row.id)).toEqual([friend])
    expect((await read(owner, all)).people.map((row) => row.id)).toEqual([plain])
    await expect(read(plain, all)).rejects.toMatchObject(denied)
  })

  it('never silently takes over or revokes another manager grant on the "all" view', async () => {
    const all = 'builtin-all:/pages'
    await grant(all, friend, admin)
    await expect(share(owner, all, `${friend}@example.test`)).rejects.toMatchObject({ status: 409, code: 'VIEW_GRANT_TAKEN' })
    await expect(revoke(owner, all, friend)).rejects.toThrow('view grant not found')
    expect(await grants(all)).toEqual([`${friend}<-${admin}`])
    await share(admin, all, `${friend}@example.test`)
    expect(await grants(all)).toEqual([`${friend}<-${admin}`])
  })

  it('only lets the view creator issue a guest link for a custom view', async () => {
    await savedView('guest-view', { createdBy: admin })
    const invite = (actor: string) => repo.createGuestInvite({
      id: id(`inv_${actor.slice(-6)}`), tokenHash: randomBytes(32).toString('hex'), actorId: actor, workspaceId: ws,
      collection: '/pages', recordId: '', viewId: 'guest-view', role: 'viewer', expiresAt: Date.now() + 60_000, now: Date.now(),
    })
    await expect(invite(owner)).rejects.toMatchObject({ ...denied, code: 'VIEW_SHARE_DENIED' })
    await invite(admin)
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT created_by FROM \`${database}\`.workspace_invites WHERE workspace_id = ? AND view_id = 'guest-view'`, [ws],
    )
    expect(rows.map((row) => row.created_by)).toEqual([admin])
  })

  it('reads collection grants for list visibility: direct, by role, view grants and highest role', async () => {
    await pool.query(
      `INSERT INTO \`${database}\`.record_grants (workspace_id, collection, record_id, subject_type, subject_id, role, granted_by, created_at)
       VALUES (?, '/pages', 'p1', 'account', ?, 'viewer', ?, 1), (?, '/pages', 'p1', 'workspace_role', 'member', 'editor', ?, 1),
              (?, '/pages', 'p2', 'account', ?, 'viewer', ?, 1), (?, '/pages', 'p3', 'account', ?, 'superuser', ?, 1)`,
      [ws, friend, owner, ws, owner, ws, plain, owner, ws, friend, owner],
    )
    await savedView('vx', { createdBy: owner, filters: { project: 'X' } })
    await grant('vx', friend, owner)
    const sources = await repo.collectionGrantSources(friend, ws, '/pages')
    expect(sources.records).toEqual({ p1: 'editor' })
    expect(sources.views).toEqual([{ viewId: 'vx', grantedBy: owner, role: 'viewer' }])
    expect(sources.savedViews.map((view) => view.id)).toEqual(['vx'])
    const none = await repo.collectionGrantSources(outsider, ws, '/pages')
    expect(none).toEqual({ records: {}, views: [], savedViews: [] })
    await pool.query(`DELETE FROM \`${database}\`.record_grants WHERE workspace_id = ?`, [ws])
  })

  it('binds view ids as parameters', async () => {
    const injected = "x' OR '1'='1"
    await savedView('real', { createdBy: admin })
    await grant('real', friend, admin)
    const access = await read(admin, injected).catch((error) => error)
    expect(access).toMatchObject({ people: [] })
  })
})
