import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { PRODUCT_MIGRATIONS } from './migrations.ts'

/**
 * 真实 MySQL：第 18 版按 reconcileRecordScope 同一规则补算历史记录归属。
 * 需要 BIU_VIEW_TEST_MYSQL_URL 指向已初始化的专用测试库；只写随机前缀的空间，结束时删除。
 */
const url = process.env.BIU_VIEW_TEST_MYSQL_URL
const integration = url ? describe : describe.skip

integration('migration 18 narrows historical record scope', () => {
  const ws = `mig_${randomBytes(4).toString('hex')}`
  const other = `${ws}_other`
  let database = ''
  let pool: Pool

  const policy = (workspace: string, id: string, ownership: string, access: string) => pool.query(
    `INSERT INTO \`${database}\`.resource_policies
     (workspace_id, collection, record_id, ownership, owner_account_id, access_mode, member_default_role, parent_collection, parent_record_id, created_by, created_at)
     VALUES (?, '/pages', ?, ?, 'ada', ?, 'viewer', '', '', 'ada', 1)`,
    [workspace, id, ownership, access],
  )
  const grant = (id: string, subject: string, type = 'account') => pool.query(
    `INSERT INTO \`${database}\`.record_grants (workspace_id, collection, record_id, subject_type, subject_id, role, granted_by, created_at)
     VALUES (?, '/pages', ?, ?, ?, 'viewer', 'ada', 1)`,
    [ws, id, type, subject],
  )
  const member = (account: string, kind: string) => pool.query(
    `INSERT INTO \`${database}\`.workspace_members (workspace_id, account_id, role, created_at, display_name, avatar, member_kind)
     VALUES (?, ?, 'member', 1, '', '', ?)`,
    [ws, account, kind],
  )
  const publicLink = (id: string) => pool.query(
    `INSERT INTO \`${database}\`.shares
     (token, workspace_id, kind, collection, view_id, record_id, password_salt, password_hash, share_plugins, allow_copy, created_at, updated_at)
     VALUES (?, ?, 'record', '/pages', '', ?, '', '', 0, 1, 1, 1)`,
    [`${ws}-${id}`, ws, id],
  )
  const state = async (workspace = ws) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT record_id, ownership, access_mode FROM \`${database}\`.resource_policies WHERE workspace_id = ? ORDER BY record_id`,
      [workspace],
    )
    return Object.fromEntries(rows.map((row) => [row.record_id, `${row.ownership}/${row.access_mode}`]))
  }
  const migrate = async () => {
    for (const statement of PRODUCT_MIGRATIONS.find((item) => item.version === 18)!.statements) await pool.query(statement)
  }

  beforeAll(async () => {
    database = decodeURIComponent(new URL(url!).pathname.replace(/^\/+/, ''))
    if (!/^biu_test[A-Za-z0-9_]{0,55}$/.test(database)) throw new Error('BIU_VIEW_TEST_MYSQL_URL must use a biu_test* database')
    pool = createPool({ uri: url!, connectionLimit: 2 })
    await member('bob', 'member')
    await member('eve', 'external')
    await policy(ws, 'gone_all', 'shared', 'restricted')
    await policy(ws, 'keeps_external', 'shared', 'restricted')
    await grant('keeps_external', 'eve')
    await policy(ws, 'only_internal', 'shared', 'restricted')
    await grant('only_internal', 'bob')
    await policy(ws, 'group_left', 'shared', 'restricted')
    await grant('group_left', 'team', 'group')
    await policy(ws, 'public_link', 'shared', 'private')
    await publicLink('public_link')
    await policy(ws, 'members_mode', 'shared', 'members')
    await policy(ws, 'workspace_no_one', 'workspace', 'restricted')
    await policy(ws, 'owner_self_grant', 'workspace', 'restricted')
    await grant('owner_self_grant', 'ada')
    await policy(ws, 'team_page', 'workspace', 'members')
    await policy(ws, 'private_page', 'personal', 'private')
    await policy(other, 'gone_all', 'shared', 'restricted')
    await migrate()
  })

  afterAll(async () => {
    if (!pool) return
    try {
      for (const table of ['resource_policies', 'record_grants', 'workspace_members', 'shares']) {
        await pool.query(`DELETE FROM \`${database}\`.\`${table}\` WHERE workspace_id LIKE ?`, [`${ws}%`])
      }
    } finally {
      await pool.end()
    }
  })

  it('narrows records whose collaborators were all removed, keeping real sharing', async () => {
    expect(await state()).toEqual({
      gone_all: 'personal/private',
      keeps_external: 'shared/restricted',
      only_internal: 'workspace/restricted',
      group_left: 'workspace/restricted',
      public_link: 'shared/private',
      members_mode: 'workspace/members',
      workspace_no_one: 'personal/private',
      owner_self_grant: 'personal/private',
      team_page: 'workspace/members',
      private_page: 'personal/private',
    })
  })

  it('applies to every workspace and is idempotent', async () => {
    expect(await state(other)).toEqual({ gone_all: 'personal/private' })
    const before = await state()
    await migrate()
    expect(await state()).toEqual(before)
  })
})
