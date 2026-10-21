import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import { runWithAccount } from '@biu/host-plugin-loader/data-dir'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import * as skills from './index.ts'

/**
 * 云端鉴权下，/skills 记录没有 record_owners 会被判为 PRIVATE_RESOURCE 而列表不可见。
 * 导入/新建必须顺带认领，否则出现「导入成功但页面看不到」。
 */
class FakeDatabase extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database')
  }
  register() {
    return { dispose() {} }
  }
}

class FakeHttp extends Service {
  constructor(ctx: Context) {
    super(ctx, 'http')
  }
  route() {}
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'biu-skills-claim-'))
  process.env.BIU_SKILL_ROOT = join(dir, 'skill')
  process.env.BIU_SKILLS_DIR = join(dir, 'legacy-skills')
  const claims: Array<{ actorId: string; workspaceId: string; collection: string; recordId: string }> = []

  class FakeAccount extends Service {
    store = {
      activeWorkspaceId: () => 'ws_test',
      claim: (actorId: string, workspaceId: string, collection: string, recordId: string) => {
        claims.push({ actorId, workspaceId, collection, recordId })
        return { ok: true }
      },
    }
    constructor(ctx: Context) {
      super(ctx, 'account')
    }
  }

  const ctx = new Context()
  new FakeDatabase(ctx)
  new FakeHttp(ctx)
  new FakeAccount(ctx)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  await ctx.plugin(skills)
  return {
    ctx,
    claims,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.BIU_SKILL_ROOT
      delete process.env.BIU_SKILLS_DIR
    },
  }
}

test('import 自动把技能认领到当前工作区', async () => {
  const { ctx, claims, cleanup } = await boot()
  try {
    const created = runWithAccount('acc_test', () =>
      ctx.skills.import({
        name: 'verify-claim',
        description: '验证导入自动认领',
        files: [{ path: 'SKILL.md', content: '---\nname: verify-claim\n---\n正文' }],
      }),
    )
    assert.deepEqual(claims, [
      { actorId: 'acc_test', workspaceId: 'ws_test', collection: '/skills', recordId: created.id },
    ])
  } finally {
    cleanup()
  }
})

test('认领失败时目录导入报错并清理未归属技能', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const account = ctx.get('account') as { store: { claim: (...args: string[]) => unknown } }
    account.store.claim = () => { throw new Error('不在这个空间') }
    assert.throws(() => runWithAccount('acc_test', () => ctx.skills.import({
      name: 'verify-denied',
      files: [{ path: 'SKILL.md', content: '---\nname: verify-denied\n---\n正文' }],
    })), /不在这个空间/)
    assert.equal(ctx.skills.list().some((skill) => skill.id === 'verify-denied'), false)
  } finally {
    cleanup()
  }
})

test('create 自动把技能认领到当前工作区', async () => {
  const { ctx, claims, cleanup } = await boot()
  try {
    const created = runWithAccount('acc_test', () =>
      ctx.skills.create({ name: 'verify-create', description: '验证新建', notes: '正文' }),
    )
    assert.deepEqual(claims, [
      { actorId: 'acc_test', workspaceId: 'ws_test', collection: '/skills', recordId: created.id },
    ])
  } finally {
    cleanup()
  }
})

test('没有账号上下文时跳过认领且不抛错（启动期 legacy 迁移）', async () => {
  const { ctx, claims, cleanup } = await boot()
  try {
    ctx.skills.import({
      name: 'verify-no-context',
      description: '无上下文',
      files: [{ path: 'SKILL.md', content: '---\nname: verify-no-context\n---\n正文' }],
    })
    assert.deepEqual(claims, [])
  } finally {
    cleanup()
  }
})
