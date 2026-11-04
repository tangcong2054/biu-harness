import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { PRODUCT_MIGRATIONS } from './migrations.ts'
import {
  MysqlAccountRepository,
  MysqlAuthorizationRepository,
  resolveAccountControlMode,
} from './mysql-account-repositories.ts'

describe('account control mode', () => {
  it('keeps Offline on SQLite and validates Online dual mode', () => {
    expect(resolveAccountControlMode('dual', false, 'mysql')).toBe('sqlite')
    expect(resolveAccountControlMode('dual', true, 'shadow')).toBe('shadow')
    expect(resolveAccountControlMode('dual', true, 'mysql')).toBe('mysql')
    expect(() => resolveAccountControlMode('dual', true, 'invalid')).toThrow(/BIU_ACCOUNT_MYSQL_MODE/)
  })
})

const mysqlUrl = process.env.BIU_TEST_MYSQL_URL
/** 设置后直接使用这个已授权的专用库，不需要建库删库权限；该库必须为空。 */
const existingDatabase = process.env.BIU_TEST_MYSQL_DATABASE?.trim() || ''
const integration = mysqlUrl ? describe : describe.skip

integration('MySQL account/workspace/authz integration', () => {
  const database = existingDatabase || `biu_account_test_${process.pid}_${randomBytes(4).toString('hex')}`
  let pool: Pool
  let accounts: MysqlAccountRepository
  let authz: MysqlAuthorizationRepository
  let ownsTables = false

  const listTables = async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
      [database],
    )
    return rows.map((row) => String(row.name))
  }

  beforeAll(async () => {
    if (existingDatabase && !/^[A-Za-z0-9_]{1,64}$/.test(existingDatabase)) {
      throw new Error('BIU_TEST_MYSQL_DATABASE must be a plain database name')
    }
    pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 })
    if (existingDatabase) {
      const leftovers = await listTables()
      if (leftovers.length) {
        throw new Error(`BIU_TEST_MYSQL_DATABASE ${database} must be empty; found: ${leftovers.slice(0, 5).join(', ')}`)
      }
    } else {
      await pool.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    }
    ownsTables = true
    for (const migration of PRODUCT_MIGRATIONS.filter((item) => (item.version >= 8 && item.version <= 10) || item.version === 12)) {
      for (const statement of migration.statements) {
        await pool.query(statement.replaceAll('CREATE TABLE IF NOT EXISTS ', `CREATE TABLE IF NOT EXISTS \`${database}\`.`)
          .replaceAll('ALTER TABLE ', `ALTER TABLE \`${database}\`.`))
      }
    }
    await pool.query(`CREATE TABLE \`${database}\`.shares (
      token VARCHAR(128) NOT NULL PRIMARY KEY,
      workspace_id VARCHAR(64) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      collection VARCHAR(128) NOT NULL,
      record_id VARCHAR(128) NOT NULL,
      view_id VARCHAR(128) NOT NULL DEFAULT ''
    )`)
    await pool.query(`CREATE TABLE \`${database}\`.saved_views (
      workspace_id VARCHAR(64) NOT NULL,
      collection VARCHAR(128) NOT NULL,
      view_id VARCHAR(128) NOT NULL,
      payload_json LONGTEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, collection, view_id)
    )`)
    accounts = new MysqlAccountRepository(pool, database)
    authz = new MysqlAuthorizationRepository(pool, database)
  })

  afterAll(async () => {
    if (!pool) return
    try {
      if (!ownsTables) return
      if (existingDatabase) {
        const connection = await pool.getConnection()
        try {
          await connection.query('SET FOREIGN_KEY_CHECKS = 0')
          for (const table of await listTables()) {
            await connection.query(`DROP TABLE IF EXISTS \`${database}\`.\`${table.replaceAll('`', '``')}\``)
          }
        } finally {
          await connection.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {})
          connection.release()
        }
      } else {
        await pool.query(`DROP DATABASE IF EXISTS \`${database}\``)
      }
    } finally {
      await pool.end()
    }
  })

  it('supports login session, workspace membership, grant/revoke and tenant isolation', async () => {
    const now = Date.now()
    await accounts.register({
      accountId: 'acc_owner',
      name: 'Owner',
      email: 'owner@example.test',
      passwordHash: 'hash',
      accountToken: 'legacy-owner',
      workspaceId: 'ws_a',
      workspaceName: 'A',
      sessionId: 'ses_owner',
      sessionTokenHash: 'a'.repeat(64),
      deviceName: 'test',
      expiresAt: now + 60_000,
      now,
    })
    await accounts.register({
      accountId: 'acc_member',
      name: 'Member',
      email: 'member@example.test',
      passwordHash: 'hash',
      accountToken: 'legacy-member',
      workspaceId: 'ws_b',
      workspaceName: 'B',
      sessionId: 'ses_member',
      sessionTokenHash: 'b'.repeat(64),
      deviceName: 'test',
      expiresAt: now + 60_000,
      now,
    })

    expect((await accounts.accountByTokenHash('a'.repeat(64), now))?.id).toBe('acc_owner')
    expect((await accounts.listWorkspaces('acc_owner')).map((item) => item.id)).toEqual(['ws_a'])
    expect(await accounts.membership('acc_owner', 'ws_a')).toEqual({ role: 'owner', memberKind: 'member' })
    expect(await accounts.membership('acc_member', 'ws_a')).toBeNull()
    expect(await accounts.externallySharedRecords('acc_stranger', 'ws_a')).toEqual([])
    expect(await accounts.addMemberByEmail('acc_owner', 'ws_a', 'member@example.test', now)).toHaveLength(2)

    await accounts.claimRecord({
      actorId: 'acc_owner', workspaceId: 'ws_a', collection: '/pages', recordId: 'page_1', now,
    })
    await pool.query(
      `INSERT INTO \`${database}\`.resource_policies
       (workspace_id, collection, record_id, ownership, owner_account_id, access_mode,
        member_default_role, parent_collection, parent_record_id, created_by, created_at)
       VALUES ('ws_a', '/pages', 'page_1', 'personal', 'acc_owner', 'private',
               'viewer', '', '', 'acc_owner', ?)`,
      [now],
    )
    await accounts.grantRecord({
      actorId: 'acc_owner',
      workspaceId: 'ws_a',
      collection: '/pages',
      recordId: 'page_1',
      subjectType: 'account',
      subjectId: 'acc_member',
      role: 'editor',
      now,
    })
    expect(await authz.grantsForSubject({
      workspaceId: 'ws_a', collection: '/pages', accountId: 'acc_member', recordIds: ['page_1'],
    })).toHaveLength(1)
    expect(await authz.grantsForSubject({
      workspaceId: 'ws_b', collection: '/pages', accountId: 'acc_member', recordIds: ['page_1'],
    })).toHaveLength(0)
    const shared = await accounts.recordAccess('acc_owner', 'ws_a', '/pages', 'page_1')
    expect(shared.scope).toBe('workspace')
    expect(shared.ownerId).toBe('acc_owner')
    expect(shared).not.toHaveProperty('policy')
    expect(shared).not.toHaveProperty('grants')
    expect(shared.roleChain).toEqual([{ id: 'ws_a\t/pages\tpage_1', title: '这条内容', detail: '你是创建者', role: 'owner' }])
    expect(shared.private).toBe(false)
    expect(shared.people.find((row) => row.id === 'acc_member')).toMatchObject({
      email: 'member@example.test',
      role: 'editor',
      memberKind: 'member',
    })
    expect(Array.isArray(shared.viewGrants)).toBe(true)

    await accounts.revokeRecordGrant({
      actorId: 'acc_owner',
      workspaceId: 'ws_a',
      collection: '/pages',
      recordId: 'page_1',
      subjectType: 'account',
      subjectId: 'acc_member',
    })
    expect(await authz.grantsForSubject({
      workspaceId: 'ws_a', collection: '/pages', accountId: 'acc_member', recordIds: ['page_1'],
    })).toHaveLength(0)
    const [policies] = await pool.query(
      `SELECT ownership, access_mode FROM \`${database}\`.resource_policies
       WHERE workspace_id = 'ws_a' AND collection = '/pages' AND record_id = 'page_1'`,
    )
    expect((policies as Array<Record<string, unknown>>)[0]).toMatchObject({ ownership: 'personal', access_mode: 'private' })
    expect((await accounts.recordAccess('acc_owner', 'ws_a', '/pages', 'page_1')).scope).toBe('personal')

    // 记录已有主人时，别的成员“挂归属”不能把自己升成主人（以前会写一条 owner 授权）。
    const attach = (actorId: string, recordId: string) => accounts.attachPolicy({
      actorId, workspaceId: 'ws_a', collection: '/plugins', recordId, ownership: 'personal', accessMode: 'private', now,
    })
    const ownerGrants = async (recordId: string) => {
      const [rows] = await pool.query(
        `SELECT subject_id FROM \`${database}\`.record_grants
         WHERE workspace_id = 'ws_a' AND collection = '/plugins' AND record_id = ? AND role = 'owner' ORDER BY subject_id`,
        [recordId],
      )
      return (rows as Array<{ subject_id: string }>).map((row) => row.subject_id)
    }
    await attach('acc_owner', 'plug_1')
    await attach('acc_member', 'plug_1')
    expect(await ownerGrants('plug_1')).toEqual(['acc_owner'])
    expect(await accounts.recordOwnerships('/plugins', 'plug_1')).toEqual([{ workspaceId: 'ws_a', ownerId: 'acc_owner' }])
    // 只有旧 record_owners、还没有策略：新策略沿用原创建者，调用者拿不到主人。
    await pool.query(
      `INSERT INTO \`${database}\`.record_owners (workspace_id, collection, record_id, owner_id, version, updated_at)
       VALUES ('ws_a', '/plugins', 'plug_2', 'acc_owner', 0, ?)`,
      [now],
    )
    await attach('acc_member', 'plug_2')
    expect(await ownerGrants('plug_2')).toEqual([])
    const [legacyPolicy] = await pool.query(
      `SELECT owner_account_id FROM \`${database}\`.resource_policies
       WHERE workspace_id = 'ws_a' AND collection = '/plugins' AND record_id = 'plug_2'`,
    )
    expect((legacyPolicy as Array<Record<string, unknown>>)[0]).toMatchObject({ owner_account_id: 'acc_owner' })
    expect(await accounts.recordOwnerships('/plugins', 'missing')).toEqual([])

    await accounts.attachPolicy({ actorId: 'acc_owner', workspaceId: 'ws_a', collection: '/pages', recordId: 'move_child', ownership: 'personal', accessMode: 'inherit', now })
    const beforeMove = await accounts.authzWorkspaceRevision('ws_a')
    await accounts.moveRecordPolicy('ws_a', '/pages', 'move_child', 'page_1')
    const sources = await accounts.collectionScopeSources('ws_a', '/pages')
    expect(sources.policies.move_child).toMatchObject({ parentCollection: '/pages', parentRecordId: 'page_1' })
    expect(await accounts.authzWorkspaceRevision('ws_a')).toBeGreaterThan(beforeMove)
    await expect(accounts.moveRecordPolicy('ws_a', '/pages', 'page_1', 'move_child')).rejects.toThrow('resource parent cycle')
    await accounts.moveRecordPolicy('ws_a', '/pages', 'move_child', '')
    expect((await accounts.collectionScopeSources('ws_a', '/pages')).policies.move_child).toMatchObject({ parentRecordId: '' })
  })

  it('covers workspace invites, groups and view grants with revision invalidation', async () => {
    const now = Date.now()
    await accounts.createInvite({
      id: 'inv_1',
      tokenHash: 'c'.repeat(64),
      workspaceId: 'ws_a',
      role: 'viewer',
      expiresAt: now + 60_000,
      actorId: 'acc_owner',
      now,
    })
    expect(await accounts.acceptInvite('acc_member', 'c'.repeat(64), now)).toEqual({
      workspaceId: 'ws_a',
      role: 'viewer',
    })

    await accounts.createGroup({
      id: 'grp_1', actorId: 'acc_owner', workspaceId: 'ws_a', name: 'Reviewers', now,
    })
    await accounts.addGroupMember('acc_owner', 'ws_a', 'grp_1', 'acc_member', now)
    expect(await accounts.groupMembers('acc_owner', 'ws_a', 'grp_1')).toHaveLength(1)

    await pool.query(
      `INSERT INTO \`${database}\`.saved_views (workspace_id, collection, view_id, payload_json, updated_at)
       VALUES ('ws_a', '/pages', 'view_1', ?, ?)`,
      [JSON.stringify({ id: 'view_1', name: 'View 1', createdBy: 'acc_owner', revision: 1 }), now],
    )
    await accounts.grantView({
      actorId: 'acc_owner',
      workspaceId: 'ws_a',
      collection: '/pages',
      viewId: 'view_1',
      subjectType: 'account',
      subjectId: 'acc_member',
      role: 'viewer',
      now,
    })
    const viewShared = await accounts.viewAccess('acc_owner', 'ws_a', '/pages', 'view_1')
    // 只返回契约字段，不再带原始授权行（里面有其他协作者的邮箱与授权人）。
    expect(viewShared).not.toHaveProperty('grants')
    expect(viewShared.people.map((row) => row.id)).toEqual(['acc_member'])
    expect(await authz.viewGrants({
      workspaceId: 'ws_a',
      collection: '/pages',
      accountId: 'acc_member',
      viewIds: ['view_1'],
    })).toHaveLength(1)
    await accounts.revokeView({
      actorId: 'acc_owner',
      workspaceId: 'ws_a',
      collection: '/pages',
      viewId: 'view_1',
      subjectType: 'account',
      subjectId: 'acc_member',
    })
    expect((await accounts.viewAccess('acc_owner', 'ws_a', '/pages', 'view_1')).people).toHaveLength(0)
  })

  it('covers sync, locks, presence, tenant lookup and plugin metadata', async () => {
    const now = Date.now()
    const op = await accounts.sync({
      actorId: 'acc_owner',
      workspaceId: 'ws_a',
      collection: '/tasks',
      recordId: 'task_1',
      field: 'title',
      value: 'One',
      expectedVersion: 0,
      now,
    })
    expect(op.version).toBe(1)
    expect(await accounts.opsSince('acc_owner', 'ws_a', 0)).toHaveLength(1)
    expect(await accounts.tenantForRecord('/tasks', 'task_1')).toEqual({
      workspaceId: 'ws_a',
      accountId: 'acc_owner',
    })
    expect((await accounts.acquireLock({
      actorId: 'acc_owner', workspaceId: 'ws_a', collection: '/tasks',
      recordId: 'task_1', ttlMs: 10_000, now,
    })).expiresAt).toBe(now + 10_000)
    expect(await accounts.pulse('acc_owner', 'ws_a', '/tasks', 'task_1', now)).toHaveLength(1)

    await accounts.recordPluginPackage('acc_owner', {
      id: 'plugin-a', version: 'v1', packageHash: 'a'.repeat(64), packagePath: '/tmp/plugin-a',
      sourceKind: 'test', trustState: 'approved', tenantMode: 'assigned',
      hasWeb: true, hasHost: true, manifest: { id: 'plugin-a' },
    }, now)
    await accounts.installPluginForWorkspace('acc_owner', 'ws_a', 'plugin-a', 'v1', now)
    // 空间级授权只对内置插件生效；普通插件必须按账号安装。
    expect(await accounts.canAccessPlugin('acc_owner', 'ws_a', 'plugin-a')).toBe(false)
    expect(await accounts.canAccessPlugin('acc_owner', 'ws_a', 'plugin-a', { includeWorkspaceGrant: true })).toBe(true)
    expect(await accounts.isApprovedPluginPackage('plugin-a', 'v1')).toBe(true)
    expect(await accounts.isApprovedPluginPackage('plugin-a', 'other')).toBe(false)
    await accounts.installPluginForAccount('acc_owner', 'ws_a', 'plugin-a', 'v1', now)
    expect(await accounts.canAccessPlugin('acc_owner', 'ws_a', 'plugin-a')).toBe(true)
    await accounts.setPluginLoad('acc_owner', 'ws_a', 'plugin-a', true, now)
    expect(await accounts.pluginLoadsFor('acc_owner', 'ws_a')).toEqual(['plugin-a'])
    await accounts.uninstallPluginForAccount('acc_owner', 'ws_a', 'plugin-a', now)
    expect(await accounts.canAccessPlugin('acc_owner', 'ws_a', 'plugin-a')).toBe(false)
    expect(await accounts.pluginLoadsFor('acc_owner', 'ws_a')).toEqual([])
  })

  it('claiming a record bumps the authz revision other instances key their caches on', async () => {
    const now = Date.now()
    const before = await accounts.authzRevision('ws_a', ['/pages'])
    const wide = await accounts.authzWorkspaceRevision('ws_a')
    await accounts.claimRecord({ actorId: 'acc_owner', workspaceId: 'ws_a', collection: '/pages', recordId: 'page_rev', now })
    expect(await accounts.authzRevision('ws_a', ['/pages'])).toBeGreaterThan(before)
    expect(await accounts.authzWorkspaceRevision('ws_a')).toBeGreaterThan(wide)
  })

  it('execution leases are exclusive per session and expire', async () => {
    const now = Date.now()
    const lease = await accounts.acquireExecutionLease('acc_owner', 'sess_1', 'laptop', 60_000, now)
    expect(await accounts.hasExecutionLease('sess_1', now)).toBe(true)
    await expect(accounts.acquireExecutionLease('acc_member', 'sess_1', 'desktop', 60_000, now)).rejects.toMatchObject({ status: 409 })
    await accounts.renewExecutionLease('acc_owner', 'sess_1', lease.leaseId, 60_000, now)
    await accounts.requireExecutionLease('acc_owner', 'sess_1', lease.leaseId, now)
    await expect(accounts.requireExecutionLease('acc_member', 'sess_1', lease.leaseId, now)).rejects.toMatchObject({ status: 409 })
    // 过期后别人可以接管。
    const later = now + 10 * 60_000
    expect(await accounts.hasExecutionLease('sess_1', later)).toBe(false)
    const next = await accounts.acquireExecutionLease('acc_member', 'sess_1', 'desktop', 60_000, later)
    await accounts.releaseExecutionLease('acc_member', 'sess_1', next.leaseId)
    expect(await accounts.hasExecutionLease('sess_1', later)).toBe(false)
  })
})
