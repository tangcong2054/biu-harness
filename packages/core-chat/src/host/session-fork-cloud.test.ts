/** @vitest-environment node */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import * as sessionStore from '@biu/host-session-store'
import * as sessions from '@biu/host-sessions'
import { forkSessionWithCloud } from './index.ts'

/**
 * 合并上游「fork 按被点击的回复截断」后，本分支桌面端打开云端会话时会先把 fork 转发到 Online。
 * 回归点：
 * 1. 截点必须一起转发，否则云端整段复制、本机按回复截断，两边子会话内容不一致；
 * 2. 本机截不出来时不能先在云端建好子会话（孤儿）。
 */

async function bootWithThreeTurns() {
  const ctx = new Context()
  await ctx.plugin(sessionStore, { driver: 'memory' })
  await ctx.plugin(sessions)
  const source = await ctx.sessions.create()
  const replies: number[] = []
  for (const turn of [1, 2, 3]) {
    await ctx.sessions.append(source.id, { type: 'turn/start', turn })
    await ctx.sessions.append(source.id, { type: 'user/message', text: `ask ${turn}`, kind: 'wake' })
    const reply = await ctx.sessions.append(source.id, { type: 'assistant/message', text: `reply ${turn}` })
    replies.push(reply.seq)
    await ctx.sessions.append(source.id, { type: 'turn/end', turn, reason: 'complete' })
  }
  return { ctx, source, replies }
}

test('cloud fork forwards the reply cutoff and reuses the cloud child id locally', async () => {
  const { ctx, source, replies } = await bootWithThreeTurns()
  const forwarded: Array<{ path: string; body: unknown }> = []
  const marked: string[] = []
  const result = await forkSessionWithCloud(
    {
      sessions: ctx.sessions,
      forward: async (path, init) => {
        forwarded.push({ path, body: init.body })
        return { status: 201, body: { id: 'cloud-child' } }
      },
      markRemote: (id) => marked.push(id),
    },
    source.id,
    { untilSeq: replies[1] },
  )
  assert.equal(result.status, 201)
  assert.equal(result.body.id, 'cloud-child')
  assert.deepEqual(forwarded, [{ path: `/api/sessions/${source.id}/fork`, body: { untilSeq: replies[1] } }])
  assert.deepEqual(marked, ['cloud-child'])
  const child = await ctx.sessions.require('cloud-child')
  assert.deepEqual(child.events.filter((event) => event.type === 'turn/end').map((event) => event.turn), [1, 2])
  assert.equal(child.events.some((event) => event.type === 'user/message' && event.text === 'ask 3'), false)
})

test('a cutoff that cannot be located locally is rejected before anything is created in the cloud', async () => {
  const { ctx, source } = await bootWithThreeTurns()
  let forwardCalls = 0
  await assert.rejects(
    () =>
      forkSessionWithCloud(
        {
          sessions: ctx.sessions,
          forward: async () => {
            forwardCalls += 1
            return { status: 201, body: { id: 'orphan' } }
          },
        },
        source.id,
        { untilSeq: 999 },
      ),
    /fork reply not found/,
  )
  assert.equal(forwardCalls, 0)
  assert.equal(await ctx.sessions.get('orphan'), undefined)
})

test('legacy body-less fork forwards no body and copies the whole session', async () => {
  const { ctx, source } = await bootWithThreeTurns()
  const bodies: unknown[] = []
  const result = await forkSessionWithCloud(
    {
      sessions: ctx.sessions,
      forward: async (_path, init) => {
        bodies.push(init.body)
        return { status: 201, body: { id: 'cloud-full' } }
      },
    },
    source.id,
    null,
  )
  assert.equal(result.status, 201)
  assert.deepEqual(bodies, [undefined])
  const parent = await ctx.sessions.require(source.id)
  assert.equal((await ctx.sessions.require('cloud-full')).events.length, parent.events.length)
})

test('cloud failures are surfaced and nothing is created locally', async () => {
  const { ctx, source, replies } = await bootWithThreeTurns()
  const before = (await ctx.sessions.listSummaries()).length
  const rejected = await forkSessionWithCloud(
    { sessions: ctx.sessions, forward: async () => ({ status: 409, body: { error: '云端拒绝' } }) },
    source.id,
    { untilSeq: replies[0] },
  )
  assert.deepEqual(rejected, { status: 409, body: { error: '云端拒绝' } })
  // 2xx 但没给子会话 id：不能当成成功，也不能回落到本机随机 id。
  const noId = await forkSessionWithCloud(
    { sessions: ctx.sessions, forward: async () => ({ status: 201, body: {} }) },
    source.id,
    { untilSeq: replies[0] },
  )
  assert.equal(noId.status, 502)
  assert.equal((await ctx.sessions.listSummaries()).length, before)
})

test.each(['files', 'images'] as const)('missing %s stop cloud and local fork with or without a cutoff', async (field) => {
  const { ctx, source } = await bootWithThreeTurns()
  try {
    const id = '11111111-1111-4111-8111-111111111111.png'
    await ctx.sessions.append(source.id, { type: 'turn/start', turn: 4 })
    await ctx.sessions.append(source.id, {
      type: 'user/message', text: 'missing attachment', kind: 'wake',
      [field]: [{ id, name: 'missing.png', mime: 'image/png', size: 12, url: `/api/sessions/${source.id}/artifacts/${id}` }],
    })
    const reply = await ctx.sessions.append(source.id, { type: 'assistant/message', text: 'reply 4' })
    await ctx.sessions.append(source.id, { type: 'turn/end', turn: 4, reason: 'complete' })
    const sourceBefore = JSON.stringify((await ctx.sessions.require(source.id)).events)
    const before = (await ctx.sessions.listSummaries()).length
    let forwardCalls = 0
    let forkCalls = 0
    for (const body of [undefined, null, { untilSeq: reply.seq }, { untilTurn: 4 }]) {
      await assert.rejects(() => forkSessionWithCloud({
        sessions: {
          checkForkCutoff: ctx.sessions.checkForkCutoff.bind(ctx.sessions),
          fork: async (...args) => {
            forkCalls += 1
            return ctx.sessions.fork(...args)
          },
        },
        forward: async () => {
          forwardCalls += 1
          return { status: 201, body: { id: 'missing-attachment-child' } }
        },
      }, source.id, body), /附件/)
      assert.equal(forwardCalls, 0)
      assert.equal(forkCalls, 0)
    }
    assert.equal((await ctx.sessions.listSummaries()).length, before)
    assert.equal(JSON.stringify((await ctx.sessions.require(source.id)).events), sourceBefore)
  } finally {
    await ctx.fiber.dispose()
  }
})

test.each(['files', 'images'] as const)('missing %s after the cutoff do not block cloud fork', async (field) => {
  const { ctx, source, replies } = await bootWithThreeTurns()
  try {
    const id = '11111111-1111-4111-8111-111111111111.png'
    await ctx.sessions.append(source.id, {
      type: 'user/message', text: 'later missing attachment', kind: 'wake',
      [field]: [{ id, name: 'missing.png', mime: 'image/png', size: 12, url: `/api/sessions/${source.id}/artifacts/${id}` }],
    })
    let forwardCalls = 0
    const childId = `${source.id}-child`
    const result = await forkSessionWithCloud({
      sessions: ctx.sessions,
      forward: async () => {
        forwardCalls += 1
        return { status: 201, body: { id: childId } }
      },
    }, source.id, { untilSeq: replies[1] })
    assert.equal(result.status, 201)
    assert.equal(forwardCalls, 1)
    const child = await ctx.sessions.require(childId)
    assert.deepEqual(child.events.filter((event) => event.type === 'turn/end').map((event) => event.turn), [1, 2])
    assert.equal(child.events.some((event) => event.type === 'user/message' && event.text === 'later missing attachment'), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('legacy session stubs without cutoff preflight remain supported', async () => {
  const calls: string[] = []
  const result = await forkSessionWithCloud({
    sessions: { fork: async () => { calls.push('fork'); return { id: 'stub-child', version: 1 } } },
    forward: async () => { calls.push('forward'); return null },
  }, 'stub-source', undefined)
  assert.equal(result.status, 201)
  assert.deepEqual(calls, ['forward', 'fork'])
})

test('local (non-cloud) fork keeps upstream behaviour: cutoff applied, fresh id', async () => {
  const { ctx, source, replies } = await bootWithThreeTurns()
  const result = await forkSessionWithCloud(
    { sessions: ctx.sessions, forward: async () => null },
    source.id,
    { untilSeq: replies[0] },
  )
  assert.equal(result.status, 201)
  const child = await ctx.sessions.require(String(result.body.id))
  assert.deepEqual(child.events.filter((event) => event.type === 'turn/end').map((event) => event.turn), [1])
})
