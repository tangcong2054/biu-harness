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
