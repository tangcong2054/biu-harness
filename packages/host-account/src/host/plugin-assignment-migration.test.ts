import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { openAndMigrateBiu, runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { CollabStore, OPERATIONS_ADMIN_ACCOUNT_ID, OPERATIONS_WORKSPACE_ID, isRegisteredBuiltinPlugin, registerBuiltinPluginLookup } from './store.ts'

/**
 * 上游把插件安装关系从「整个空间」改成「账号 · 空间」。SQLite 里已经存在的
 * `subject_type='workspace'` 授权对普通插件不再生效，MySQL 里由导入器搬过去的历史
 * 数据同理。这个文件把「旧数据在新语义下是什么样」以及「修数据要修成什么样」
 * 固化下来，作为本次合并需要重处理 MySQL 数据的依据。
 *
 * 注意：这里只用本机 SQLite 复现规则，不连 MySQL；MySQL 侧要执行的等价操作见
 * docs 里的迁移说明（把 workspace 级授权按当前成员展开为 account 级授权）。
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'biu-plugin-migration-'))
  dirs.push(dir)
  const db = openAndMigrateBiu(join(dir, 'biu.sqlite'))
  return new CollabStore(db)
}

function approve(collab: CollabStore, accountId: string, id: string, version = 'v1') {
  collab.recordPluginPackage(accountId, {
    id,
    version,
    packageHash: version,
    packagePath: `/tmp/${id}`,
    sourceKind: 'registry',
    trustState: 'approved',
    tenantMode: 'assigned',
    hasWeb: true,
    hasHost: true,
    manifest: { id },
  })
}

test('旧的 workspace 级授权在新语义下对所有人都不可见，需要按成员展开', () => {
  const collab = store()
  const owner = collab.register('Owner')
  const member = collab.register('Member')
  const outsider = collab.register('Outsider')
  const workspace = collab.createWorkspace(owner.id, 'Notes')
  collab.addMember(owner.id, workspace.id, member.id)
  approve(collab, owner.id, 'shared-plugin')

  // 迁移前的数据长这样：一条 workspace 级授权。
  collab.installPluginForWorkspace(owner.id, workspace.id, 'shared-plugin', 'v1')
  assert.equal(collab.canAccessPlugin(owner.id, workspace.id, 'shared-plugin'), false)
  assert.equal(collab.canAccessPlugin(member.id, workspace.id, 'shared-plugin'), false)

  // 修复动作：给当前成员各补一条 account 级授权。非成员不在展开范围内。
  for (const accountId of [owner.id, member.id]) {
    collab.installPluginForAccount(accountId, workspace.id, 'shared-plugin', 'v1')
  }
  assert.equal(collab.canAccessPlugin(owner.id, workspace.id, 'shared-plugin'), true)
  assert.equal(collab.canAccessPlugin(member.id, workspace.id, 'shared-plugin'), true)
  assert.equal(collab.canAccessPlugin(outsider.id, workspace.id, 'shared-plugin'), false)

  // 展开后卸载是账号级的，不会摘掉别人的安装关系。
  collab.setPluginLoad(owner.id, workspace.id, 'shared-plugin', true)
  collab.uninstallPluginForAccount(owner.id, workspace.id, 'shared-plugin')
  assert.equal(collab.canAccessPlugin(owner.id, workspace.id, 'shared-plugin'), false)
  assert.equal(collab.canAccessPlugin(member.id, workspace.id, 'shared-plugin'), true)
})

test('内置插件继续沿用 workspace 级授权，不需要展开', () => {
  const stop = registerBuiltinPluginLookup((id) => id === 'official-block')
  try {
    const collab = store()
    const owner = collab.register('Owner')
    const member = collab.register('Member')
    const workspace = collab.createWorkspace(owner.id, 'Notes')
    collab.addMember(owner.id, workspace.id, member.id)
    approve(collab, owner.id, 'official-block')
    assert.equal(isRegisteredBuiltinPlugin('official-block'), true)

    collab.installPluginForWorkspace(owner.id, workspace.id, 'official-block', 'v1')
    assert.equal(collab.canAccessPlugin(owner.id, workspace.id, 'official-block'), true)
    assert.equal(collab.canAccessPlugin(member.id, workspace.id, 'official-block'), true)
  } finally {
    stop()
  }
})

test('平台运营插件只认运营 admin 与运营空间', () => {
  const previousOnline = process.env.BIU_ONLINE
  const previousOperations = process.env.BIU_OPERATIONS
  process.env.BIU_ONLINE = '1'
  process.env.BIU_OPERATIONS = '1'
  try {
    const collab = store()
    // 前置条件：运营空间与运营 admin 必须存在，否则 account 级授权会因「不是成员」失败。
    collab.bootstrapOperations({ email: 'admin', password: 'migration-probe' })
    const admin = { id: OPERATIONS_ADMIN_ACCOUNT_ID }
    const colleague = collab.register('Colleague')
    approve(collab, admin.id, 'platform-operations', 'ops-v1')

    // 迁移前的历史写法：把运营插件装到某个普通空间。
    const workspace = collab.createWorkspace(colleague.id, 'Notes')
    collab.installPluginForWorkspace(colleague.id, workspace.id, 'platform-operations', 'ops-v1')
    assert.equal(collab.canAccessPlugin(colleague.id, workspace.id, 'platform-operations'), false)
    assert.equal(collab.canAccessPlugin(admin.id, workspace.id, 'platform-operations'), false)

    // 修复动作：只在运营空间里给运营 admin 建 account 级授权。
    collab.installPluginForAccount(admin.id, OPERATIONS_WORKSPACE_ID, 'platform-operations', 'ops-v1')
    assert.equal(collab.canAccessPlugin(admin.id, OPERATIONS_WORKSPACE_ID, 'platform-operations'), true)
    assert.equal(collab.canAccessPlugin(colleague.id, OPERATIONS_WORKSPACE_ID, 'platform-operations'), false)
  } finally {
    if (previousOnline === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previousOnline
    if (previousOperations === undefined) delete process.env.BIU_OPERATIONS
    else process.env.BIU_OPERATIONS = previousOperations
  }
})

test('展开后的加载状态按账号记录，不会一次清空整空间', () => {
  const collab = store()
  const owner = collab.register('Owner')
  const member = collab.register('Member')
  const workspace = collab.createWorkspace(owner.id, 'Notes')
  collab.addMember(owner.id, workspace.id, member.id)
  approve(collab, owner.id, 'shared-plugin')
  collab.installPluginForAccount(owner.id, workspace.id, 'shared-plugin', 'v1')
  collab.installPluginForAccount(member.id, workspace.id, 'shared-plugin', 'v1')
  runWithAccount(owner.id, () =>
    runWithRequestWorkspace(workspace.id, () => {
      collab.setPluginLoad(owner.id, workspace.id, 'shared-plugin', true)
      collab.setPluginLoad(member.id, workspace.id, 'shared-plugin', true)
      assert.deepEqual(collab.pluginLoadsFor(owner.id, workspace.id), ['shared-plugin'])
      collab.uninstallPluginForAccount(owner.id, workspace.id, 'shared-plugin')
      assert.equal(collab.hasPluginLoad(member.id, workspace.id, 'shared-plugin'), true)
      assert.deepEqual(collab.pluginLoadsFor(owner.id, workspace.id), [])
    }),
  )
})
