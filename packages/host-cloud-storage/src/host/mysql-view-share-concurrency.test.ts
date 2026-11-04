import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import type { SavedViewMutation } from '@biu/host-plugin-loader/metadata-runtime'
import { MysqlFileSystemMetadataRepository } from './mysql-runtime-repositories.ts'

/**
 * 真实 MySQL 并发测试：视图增量保存与分享逐行写入。
 * 需要 BIU_VIEW_TEST_MYSQL_URL 指向已初始化的专用测试库（scripts/bootstrap-mysql-test-db.mts）。
 * 每次运行使用随机工作区前缀，结束时只删除本次写入的行。
 */
const url = process.env.BIU_VIEW_TEST_MYSQL_URL
const integration = url ? describe : describe.skip

integration('MySQL saved views and shares under real concurrency', () => {
  const prefix = `t_${randomBytes(4).toString('hex')}_`
  let database = ''
  let pool: Pool
  let ws = ''
  let wsSeq = 0

  const repoFor = (workspace: string) => new MysqlFileSystemMetadataRepository(pool, database, () => workspace)
  const create = (id: string, name = id): SavedViewMutation => ({ type: 'create', collection: '/pages', id, view: { name } })
  const update = (id: string, expectedRevision: number, name = id): SavedViewMutation => ({ type: 'update', collection: '/pages', id, expectedRevision, view: { name } })
  const remove = (id: string, expectedRevision: number): SavedViewMutation => ({ type: 'delete', collection: '/pages', id, expectedRevision })
  const shareRow = (token: string, extra: Record<string, unknown> = {}) => ({
    token, kind: 'view', collection: '/pages', view_id: '', record_id: '', password_salt: '', password_hash: '',
    share_plugins: 0, allow_copy: 1, created_at: 1, updated_at: 1, created_by: '', ...extra,
  })
  const readView = async (workspace: string, id: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT payload_json FROM \`${database}\`.saved_views WHERE workspace_id = ? AND collection = '/pages' AND view_id = ?`,
      [workspace, id],
    )
    return rows[0] ? JSON.parse(String(rows[0].payload_json)) : null
  }
  const shareTokens = async (workspace: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT token FROM \`${database}\`.shares WHERE workspace_id = ? ORDER BY token`, [workspace],
    )
    return rows.map((row) => String(row.token))
  }
  const addMember = async (workspace: string, account: string) => {
    await pool.query(
      `INSERT INTO \`${database}\`.workspace_members (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
       VALUES (?, ?, 'owner', ?, '', '', 'member')`,
      [workspace, account, Date.now()],
    )
  }
  const settle = <T>(tasks: Array<Promise<T>>) => Promise.allSettled(tasks)
  const codes = (results: PromiseSettledResult<unknown>[]) => results
    .map((result) => result.status === 'fulfilled' ? 'ok' : String((result.reason as { code?: string })?.code ?? result.reason))
    .sort()

  beforeAll(async () => {
    database = decodeURIComponent(new URL(url!).pathname.replace(/^\/+/, ''))
    if (!/^biu_test[A-Za-z0-9_]{0,55}$/.test(database)) throw new Error('BIU_VIEW_TEST_MYSQL_URL must use a biu_test* database')
    pool = createPool({ uri: url!, connectionLimit: 12 })
    const [tables] = await pool.query<RowDataPacket[]>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('saved_views', 'shares', 'workspace_members')`,
      [database],
    )
    if (tables.length !== 3) throw new Error(`${database} is not initialized; run scripts/bootstrap-mysql-test-db.mts`)
  })

  beforeEach(async () => {
    ws = `${prefix}${++wsSeq}`
    await addMember(ws, 'owner')
    await addMember(ws, 'other')
  })

  afterAll(async () => {
    if (!pool) return
    try {
      for (const table of ['saved_views', 'shares', 'workspace_members']) {
        await pool.query(`DELETE FROM \`${database}\`.\`${table}\` WHERE workspace_id LIKE ?`, [`${prefix}%`])
      }
    } finally {
      await pool.end()
    }
  })

  it('two windows saving the same version: exactly one wins, the other gets a conflict', async () => {
    const repo = repoFor(ws)
    await repo.mutateSavedViews('owner', [create('a')])
    const results = await settle(Array.from({ length: 6 }, (_, i) => repoFor(ws).mutateSavedViews('owner', [update('a', 1, `window ${i}`)])))
    expect(codes(results)).toEqual(['SAVED_VIEW_CONFLICT', 'SAVED_VIEW_CONFLICT', 'SAVED_VIEW_CONFLICT', 'SAVED_VIEW_CONFLICT', 'SAVED_VIEW_CONFLICT', 'ok'])
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    expect(await readView(ws, 'a')).toMatchObject({ name: `window ${winner}`, revision: 2 })
  })

  it('concurrent creates of different views all survive', async () => {
    const results = await settle(Array.from({ length: 10 }, (_, i) => repoFor(ws).mutateSavedViews('owner', [create(`v${i}`)])))
    expect(codes(results).every((code) => code === 'ok')).toBe(true)
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM \`${database}\`.saved_views WHERE workspace_id = ?`, [ws],
    )
    expect(Number(rows[0]?.n)).toBe(10)
  })

  it('concurrent creates of the same id: one succeeds, the rest conflict without overwriting', async () => {
    const results = await settle(Array.from({ length: 5 }, (_, i) => repoFor(ws).mutateSavedViews('owner', [create('same', `n${i}`)])))
    expect(codes(results).filter((code) => code === 'ok')).toHaveLength(1)
    expect(codes(results).filter((code) => code === 'SAVED_VIEW_CONFLICT')).toHaveLength(4)
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    expect(await readView(ws, 'same')).toMatchObject({ name: `n${winner}`, revision: 1 })
  })

  it('delete racing an update never revives the view', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = `race${round}`
      await repoFor(ws).mutateSavedViews('owner', [create(id)])
      const [deleted, updated] = await settle([
        repoFor(ws).mutateSavedViews('owner', [remove(id, 1)]),
        repoFor(ws).mutateSavedViews('owner', [update(id, 1, 'late edit')]),
      ])
      expect([deleted.status, updated.status].filter((status) => status === 'fulfilled')).toHaveLength(1)
      const stored = await readView(ws, id)
      if (deleted.status === 'fulfilled') {
        expect(stored).toEqual({ id, createdBy: 'owner', revision: 2, deletedAt: expect.any(Number) })
        await expect(repoFor(ws).mutateSavedViews('owner', [create(id)])).rejects.toMatchObject({ code: 'SAVED_VIEW_CONFLICT' })
      } else {
        expect(stored).toMatchObject({ name: 'late edit', revision: 2 })
        expect(stored.deletedAt).toBeUndefined()
      }
    }
  })

  it('opposite-order batches do not deadlock into unexpected errors', async () => {
    await repoFor(ws).mutateSavedViews('owner', [create('a'), create('b')])
    const results = await settle([
      repoFor(ws).mutateSavedViews('owner', [update('a', 1, 'x'), update('b', 1, 'x')]),
      repoFor(ws).mutateSavedViews('owner', [update('b', 1, 'y'), update('a', 1, 'y')]),
    ])
    expect(codes(results)).toEqual(['SAVED_VIEW_CONFLICT', 'ok'])
    const a = await readView(ws, 'a')
    const b = await readView(ws, 'b')
    expect(a.name).toBe(b.name)
    expect([a.revision, b.revision]).toEqual([2, 2])
  })

  it('deleting a view atomically revokes its links and scope links, leaving others intact', async () => {
    await repoFor(ws).mutateSavedViews('owner', [create('a'), create('b')])
    const repo = repoFor(ws)
    await repo.saveShare(shareRow(`${ws}-a`, { view_id: 'a' }), null)
    await repo.saveShare(shareRow(`${ws}-scope`, { view_id: 'builtin-scope:shared:a' }), null)
    await repo.saveShare(shareRow(`${ws}-b`, { view_id: 'b' }), null)
    await repo.mutateSavedViews('owner', [remove('a', 1)])
    expect(await shareTokens(ws)).toEqual([`${ws}-b`])
  })

  it('a share cannot be created for a deleted view, even by a stale window', async () => {
    const repo = repoFor(ws)
    await repo.mutateSavedViews('owner', [create('a')])
    await repo.mutateSavedViews('owner', [remove('a', 1)])
    await expect(repo.saveShare(shareRow(`${ws}-late`, { view_id: 'a' }), null)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(await shareTokens(ws)).toEqual([])
  })

  it('a stale share update after revocation does not resurrect the link', async () => {
    const repo = repoFor(ws)
    const original = shareRow(`${ws}-link`)
    await repo.saveShare(original, null)
    await repo.deleteShares({ token: original.token })
    await expect(repo.saveShare({ ...original, allow_copy: 0, updated_at: 2 }, original)).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
    expect(await shareTokens(ws)).toEqual([])
  })

  it('concurrent share edits from the same baseline: one wins, no lost password', async () => {
    const repo = repoFor(ws)
    const original = shareRow(`${ws}-pw`)
    await repo.saveShare(original, null)
    const results = await settle([
      repoFor(ws).saveShare({ ...original, password_salt: 's', password_hash: 'h', updated_at: 2 }, original),
      repoFor(ws).saveShare({ ...original, allow_copy: 0, updated_at: 2 }, original),
    ])
    expect(codes(results)).toEqual(['SHARE_CONFLICT', 'ok'])
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT password_hash, allow_copy FROM \`${database}\`.shares WHERE token = ?`, [original.token],
    )
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    expect(rows[0]).toEqual(winner === 0 ? { password_hash: 'h', allow_copy: 1 } : { password_hash: '', allow_copy: 0 })
  })

  it('two workspaces can share the same target independently', async () => {
    const other = `${prefix}other_${wsSeq}`
    await addMember(other, 'owner')
    await repoFor(ws).saveShare(shareRow(`${ws}-whole`), null)
    await repoFor(other).saveShare(shareRow(`${other}-whole`), null)
    expect(await shareTokens(ws)).toEqual([`${ws}-whole`])
    expect(await shareTokens(other)).toEqual([`${other}-whole`])
  })

  it('revoking a target in one workspace leaves the same target in another workspace', async () => {
    const other = `${prefix}iso_${wsSeq}`
    await addMember(other, 'owner')
    await repoFor(ws).saveShare(shareRow(`${ws}-rec`, { kind: 'record', record_id: 'p1' }), null)
    await repoFor(other).saveShare(shareRow(`${other}-rec`, { kind: 'record', record_id: 'p1' }), null)
    await repoFor(ws).deleteShares({ kind: 'record', collection: '/pages', record_id: 'p1' })
    expect(await shareTokens(ws)).toEqual([])
    expect(await shareTokens(other)).toEqual([`${other}-rec`])
  })
})
