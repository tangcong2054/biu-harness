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
  return runWithAccount('acc_test', () => {
    const mine = ctx.skills.import({
      name: 'mine',
      description: '本工作区的技能',
      files: [{ path: 'SKILL.md', content: '---\nname: mine\n---\n正文' }],
    })
    const other = ctx.skills.import({
      name: 'other',
      description: '别的工作区的技能',
      files: [{ path: 'SKILL.md', content: '---\nname: other\n---\n正文' }],
    })
    return { mine, other }
  })
}

test('云端只列出当前工作区可见的技能', async () => {
  const ctx = await boot({ visible: new Set(['mine']) })
  const { mine, other } = seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id), [mine.id])
  assert.equal(runWithAccount('acc_test', () => ctx.skills.summaries().length), 1)
  assert.doesNotThrow(() => runWithAccount('acc_test', () => ctx.skills.read(mine.id)))
  // 别的工作区的技能：读不到
  assert.throws(() => runWithAccount('acc_test', () => ctx.skills.read(other.id)), /unknown skill/)
  assert.equal(ctx.skills.recordOrNull(other.id), null)
  assert.deepEqual(ctx.skills.filesOf(other.id), [])
  assert.throws(() => ctx.skills.fileText(other.id, 'SKILL.md'), /unknown skill/)
})

test('promptSection 不泄露别的工作区的技能', async () => {
  const ctx = await boot({ visible: new Set(['mine']) })
  seed(ctx)
  const prompt = runWithAccount('acc_test', () => ctx.skills.promptSection())
  assert.match(prompt, /mine/)
  assert.doesNotMatch(prompt, /other/)
})

test('没有账号服务时（本地 / 桌面）保持全部可见', async () => {
  const ctx = await boot({ withAccount: false })
  const { mine, other } = seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id).sort(), [mine.id, other.id].sort())
})

test('云端但拿不到工作区时 fail-closed', async () => {
  const ctx = await boot({ workspaceId: '', visible: new Set(['mine']) })
  const { mine, other } = seed(ctx)
  assert.deepEqual(runWithAccount('acc_test', () => ctx.skills.list()), [])
  assert.deepEqual(runWithAccount('acc_test', () => ctx.skills.list()), [])
  assert.notEqual(mine.id, other.id)
})

test('BIU_SKILL_DEFAULT_WORKSPACE 可兜底', async () => {
  process.env.BIU_SKILL_DEFAULT_WORKSPACE = 'ws_fallback'
  const ctx = await boot({ workspaceId: '', visible: new Set(['mine']) })
  seed(ctx)
  const listed = runWithAccount('acc_test', () => ctx.skills.list())
  assert.deepEqual(listed.map((item) => item.id), ['mine'])
})
