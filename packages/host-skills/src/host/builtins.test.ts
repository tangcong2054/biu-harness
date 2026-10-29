import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import { runWithAccount } from '@biu/host-plugin-loader/data-dir'
import type { CollectionSpec } from '@biu/type-file-system'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import * as skills from './index.ts'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  delete process.env.BIU_SKILL_ROOT
  delete process.env.BIU_SKILLS_DIR
})

class FakeDatabase extends Service {
  specs: CollectionSpec[] = []
  constructor(ctx: Context) {
    super(ctx, 'database')
  }
  register(spec: CollectionSpec) {
    this.specs.push(spec)
    return { dispose() {} }
  }
}

class FakeHttp extends Service {
  constructor(ctx: Context) {
    super(ctx, 'http')
  }
  route() {}
}

type Member = { id: string; member_kind: 'member' | 'external' | 'guest' }

async function boot(opts: { online?: boolean; members?: Record<string, Member[]> } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'biu-skills-builtin-'))
  process.env.BIU_SKILL_ROOT = join(dir, 'skill')
  process.env.BIU_SKILLS_DIR = join(dir, 'legacy-skills')
  const state = { workspaceId: 'ws_a' }
  const members = opts.members ?? {}

  class FakeAccount extends Service {
    store = {
      activeWorkspaceId: () => state.workspaceId,
      claim: () => ({ ok: true }),
      members: (actorId: string, workspaceId: string) => {
        const list = members[workspaceId] ?? []
        if (!list.some((item) => item.id === actorId)) throw new Error('not a member')
        return list
      },
    }
    authorization = {
      currentActor: () => null,
      authorize: () => ({ allowed: false }),
    }
    constructor(ctx: Context) {
      super(ctx, 'account')
    }
  }

  const ctx = new Context()
  const database = new FakeDatabase(ctx)
  new FakeHttp(ctx)
  if (opts.online !== false) new FakeAccount(ctx)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  await ctx.plugin(skills)
  return { ctx, database, state }
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id).sort()
const BUILTIN = ['sys-docs', 'sys-plugin-maker']

test('本地：系统技能可被 skill_list / skill_read / 提示词看到，但不进 /skills 表', async () => {
  const { ctx, database } = await boot({ online: false })
  const listed = await ctx.tools.invoke('skill_list', {}) as Array<{ id: string }>
  assert.deepEqual(ids(listed), BUILTIN)
  const read = await ctx.tools.invoke('skill_read', { id: 'sys-docs' }) as { body: string }
  assert.match(read.body, /helloooooooooooooo97\.github\.io\/biu/)
  assert.match(ctx.skills.promptSection(), /sys-plugin-maker/)

  const spec = database.specs.find((item) => item.path === '/skills')!
  assert.deepEqual(await spec.list(), [])
  assert.equal(await spec.get!('sys-docs'), null)
})

test('云端：空间正式成员（含查看者）可见，外部协作者 / 访客 / 非成员不可见', async () => {
  const { ctx } = await boot({
    members: {
      ws_a: [
        { id: 'acc_member', member_kind: 'member' },
        { id: 'acc_ext', member_kind: 'external' },
        { id: 'acc_guest', member_kind: 'guest' },
      ],
    },
  })
  assert.deepEqual(ids(runWithAccount('acc_member', () => ctx.skills.listAll())), BUILTIN)
  assert.deepEqual(runWithAccount('acc_ext', () => ctx.skills.listAll()), [])
  assert.deepEqual(runWithAccount('acc_guest', () => ctx.skills.listAll()), [])
  assert.deepEqual(runWithAccount('acc_stranger', () => ctx.skills.listAll()), [])
  assert.throws(() => runWithAccount('acc_ext', () => ctx.skills.read('sys-docs')), /unknown skill/)
  // 没有登录账号时 fail-closed
  assert.deepEqual(ctx.skills.listAll(), [])
})

test('云端：移除只影响当前空间，可恢复', async () => {
  const { ctx, state } = await boot({
    members: {
      ws_a: [{ id: 'acc_admin', member_kind: 'member' }],
      ws_b: [{ id: 'acc_admin', member_kind: 'member' }],
    },
  })
  runWithAccount('acc_admin', () => ctx.skills.removeBuiltin('sys-docs'))
  assert.deepEqual(ids(runWithAccount('acc_admin', () => ctx.skills.listAll())), ['sys-plugin-maker'])
  assert.throws(() => runWithAccount('acc_admin', () => ctx.skills.read('sys-docs')), /unknown skill/)

  state.workspaceId = 'ws_b'
  assert.deepEqual(ids(runWithAccount('acc_admin', () => ctx.skills.listAll())), BUILTIN)

  state.workspaceId = 'ws_a'
  runWithAccount('acc_admin', () => ctx.skills.restoreBuiltin('sys-docs'))
  assert.deepEqual(ids(runWithAccount('acc_admin', () => ctx.skills.listAll())), BUILTIN)
})

test('系统技能不可修改；sys- 前缀不能被新建或导入占用；动作不能作用于普通技能', async () => {
  const { ctx, database } = await boot({ online: false })
  const spec = database.specs.find((item) => item.path === '/skills')!
  await assert.rejects(async () => spec.update!('sys-docs', { title: '改名' }), /unknown skill/)
  await assert.rejects(ctx.skills.create({ id: 'sys-docs', name: 'x', description: 'y' }), /sys-/)
  await assert.rejects(ctx.skills.create({ name: 'sys hack', description: 'y' }), /sys-/)
  await assert.rejects(
    ctx.skills.import({ files: [{ path: 'SKILL.md', content: '---\nname: sys-evil\ndescription: x\n---\n正文' }] }),
    /sys-/,
  )
  assert.deepEqual(await spec.list(), [])

  const normal = await ctx.skills.create({ name: 'normal', description: '普通技能' })
  const remove = spec.actions!.find((item) => item.id === 'remove-builtin')!
  assert.throws(() => remove.run(normal.id, { id: normal.id }), /unknown builtin skill/)
})
