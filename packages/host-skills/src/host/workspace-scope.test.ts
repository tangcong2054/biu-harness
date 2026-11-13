import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import { runWithAccount } from '@biu/host-plugin-loader/data-dir'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import * as skills from './index.ts'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  delete process.env.BIU_SKILL_ROOT
  delete process.env.BIU_SKILLS_DIR
  delete process.env.BIU_SKILL_DEFAULT_WORKSPACE
})

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

type AccountOpts = {
  workspaceId?: string
  visible?: Set<string>
  withAccount?: boolean
}

async function boot(opts: AccountOpts = {}) {
  dir = mkdtempSync(join(tmpdir(), 'biu-skills-scope-'))
  process.env.BIU_SKILL_ROOT = join(dir, 'skill')
  process.env.BIU_SKILLS_DIR = join(dir, 'legacy-skills')
  const visible = opts.visible ?? new Set<string>()
  const workspaceId = opts.workspaceId ?? 'ws_test'

  class FakeAccount extends Service {
    store = {
      activeWorkspaceId: () => workspaceId || null,
      claim: () => ({ ok: true }),
    }
    authorization = {
      currentActor: () => ({ type: 'account', accountId: 'acc_test', workspaceId }),
      authorize: (_actor: unknown, _action: string, resource: unknown) => ({
        allowed: visible.has((resource as { recordId: string }).recordId),
      }),
    }
    constructor(ctx: Context) {
      super(ctx, 'account')
    }
  }

  const ctx = new Context()
  new FakeDatabase(ctx)
  new FakeHttp(ctx)
  if (opts.withAccount !== false) new FakeAccount(ctx)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  await ctx.plugin(skills)
  return ctx
}

function seed(ctx: Context) {
  return runWithAccount('acc_test', async () => {
    const mine = await ctx.skills.import({
      name: 'mine',
      description: '本工作区的技能',
      files: [{ path: 'SKILL.md', content: '---\nname: mine\n---\n正文' }],
    })
    const other = await ctx.skills.import({
      name: 'other',
      description: '别的工作区的技能',
      files: [{ path: 'SKILL.md', content: '---\nname: other\n---\n正文' }],
    })
    return { mine, other }
  })
}

test('桌面端技能包跨空间可见，Agent 也能读到', async () => {
  const ctx = await boot({ visible: new Set(['mine']) })
  const { mine, other } = await seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id).sort(), [mine.id, other.id].sort())
  assert.equal(runWithAccount('acc_test', () => ctx.skills.summaries().length), 2)
  assert.doesNotThrow(() => runWithAccount('acc_test', () => ctx.skills.read(mine.id)))
  assert.doesNotThrow(() => runWithAccount('acc_test', () => ctx.skills.read(other.id)))
  assert.equal(ctx.skills.recordOrNull(other.id)?.id, other.id)
})

test('promptSection 列出本机全部技能包', async () => {
  const ctx = await boot({ visible: new Set(['mine']) })
  await seed(ctx)
  const prompt = runWithAccount('acc_test', () => ctx.skills.promptSection())
  assert.match(prompt, /mine/)
  assert.match(prompt, /other/)
})

test('没有账号服务时（本地 / 桌面）保持全部可见', async () => {
  const ctx = await boot({ withAccount: false })
  const { mine, other } = await seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id).sort(), [mine.id, other.id].sort())
})

test('桌面端没有工作区时仍可导入，技能留在本机目录', async () => {
  const ctx = await boot({ workspaceId: '', visible: new Set(['mine']) })
  const { mine } = await seed(ctx)
  assert.equal(mine.id, 'mine')
  assert.deepEqual(runWithAccount('acc_test', () => ctx.skills.list()).map((item) => item.id).sort(), ['mine', 'other'])
})

test('BIU_SKILL_DEFAULT_WORKSPACE 可兜底', async () => {
  process.env.BIU_SKILL_DEFAULT_WORKSPACE = 'ws_fallback'
  const ctx = await boot({ workspaceId: '', visible: new Set(['mine']) })
  await seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id).sort(), ['mine', 'other'])
})

test('MySQL：只列出当前工作区认领的技能', async () => {
  dir = mkdtempSync(join(tmpdir(), 'biu-skills-scope-mysql-'))
  process.env.BIU_SKILL_ROOT = join(dir, 'skill')
  process.env.BIU_SKILLS_DIR = join(dir, 'legacy-skills')
  const owned = new Set<string>()

  class FakeAccount extends Service {
    usesMysqlAccounts() {
      return true
    }
    mysql = {
      async membership() {
        return { role: 'member', memberKind: 'member' }
      },
      async ownedRecordIds() {
        return [...owned]
      },
      async ownerWorkspaceIds(_collection: string, recordId: string) {
        if (recordId === 'other') return ['ws_other']
        return owned.has(recordId) ? ['ws_a'] : []
      },
      async claimRecord(input: { recordId: string }) {
        owned.add(input.recordId)
      },
    }
    store = { activeWorkspaceId: () => 'ws_a', claim: () => ({ ok: true }) }
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
  const { runWithRequestWorkspace } = await import('@biu/host-plugin-loader/data-dir')
  await runWithAccount('acc_test', () => runWithRequestWorkspace('ws_a', async () => {
    await ctx.skills.import({
      name: 'mine',
      description: '本工作区的技能',
      files: [{ path: 'SKILL.md', content: '---\nname: mine\ndescription: 本工作区的技能\n---\n正文' }],
    })
    await assert.rejects(
      ctx.skills.import({
        name: 'other',
        description: '别的工作区的技能',
        files: [{ path: 'SKILL.md', content: '---\nname: other\ndescription: 别的工作区的技能\n---\n正文' }],
      }),
      /另一个空间/,
    )
    await ctx.skills.ensureOwned()
    assert.deepEqual(ctx.skills.list().map((item) => item.id), ['mine'])
    assert.equal(ctx.skills.recordOrNull('other'), null)
  }))
})
