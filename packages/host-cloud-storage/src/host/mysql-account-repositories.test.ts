import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
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
const integration = mysqlUrl ? describe : describe.skip

integration('MySQL account/workspace/authz integration', () => {
  const database = `biu_account_test_${process.pid}_${randomBytes(4).toString('hex')}`
  let pool: Pool
  let accounts: MysqlAccountRepository
  let authz: MysqlAuthorizationRepository

  beforeAll(async () => {
    pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 })
    await pool.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    for (const migration of PRODUCT_MIGRATIONS.filter((item) => item.version >= 8 && item.version <= 10)) {
      for (const statement of migration.statements) {
        await pool.query(statement.replaceAll('CREATE TABLE IF NOT EXISTS ', `CREATE TABLE IF NOT EXISTS \`${database}\`.`)
          .replaceAll('ALTER TABLE ', `ALTER TABLE \`${database}\`.`))
      }
    }
    accounts = new MysqlAccountRepository(pool, database)
    authz = new MysqlAuthorizationRepository(pool, database)
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await pool.end()
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
    expect((await accounts.viewAccess('acc_owner', 'ws_a', '/pages', 'view_1')).grants).toHaveLength(1)
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
    expect((await accounts.viewAccess('acc_owner', 'ws_a', '/pages', 'view_1')).grants).toHaveLength(0)
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
    expect(await accounts.canAccessPlugin('acc_owner', 'ws_a', 'plugin-a')).toBe(true)
    await accounts.setPluginLoad('acc_owner', 'ws_a', 'plugin-a', true, now)
    expect(await accounts.pluginLoadsFor('acc_owner', 'ws_a')).toEqual(['plugin-a'])
  })
})
