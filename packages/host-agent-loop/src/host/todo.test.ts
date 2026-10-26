import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import * as sessionStore from '@biu/host-session-store'
import * as sessions from '@biu/host-sessions'
import * as tools from '@biu/host-tools'
import * as systemPrompt from '@biu/host-system-prompt'
import { AgentLoop } from '@biu/host-agent-loop'
import type { AssistantReply, LlmClient, LlmMessage } from '@biu/host-llm'
import { registerTodoTool, todoReminder, todoTurnState, TODO_NUDGE_STEP, TODO_STALE_STEPS } from './todo.ts'

async function spine() {
  const ctx = new Context()
  await ctx.plugin(sessionStore, { driver: 'memory' })
  await ctx.plugin(sessions)
  await ctx.plugin(tools)
  await ctx.plugin(systemPrompt)
  registerTodoTool(ctx)
  const session = await ctx.sessions.create()
  return { ctx, sessionId: session.id }
}

function scripted(replies: AssistantReply[], seen: LlmMessage[][]): LlmClient {
  return {
    async chat(messages) {
      seen.push(messages)
      const next = replies.shift()
      if (!next) throw new Error('unexpected extra llm.chat')
      return next
    },
  }
}

const todoCall = (id: string, todos: Array<{ content: string; status: string }>) => ({
  id,
  name: 'todo_write',
  arguments: JSON.stringify({ todos }),
})

const reminderOf = (messages: LlmMessage[]) => {
  const last = messages.at(-1)
  return typeof last?.content === 'string' && last.content.startsWith('<system-reminder>') ? last.content : undefined
}

test('todo_write rejects invalid input and multiple in_progress', async () => {
  const { ctx } = await spine()
  await assert.rejects(() => Promise.resolve(ctx.tools.invoke('todo_write', { todos: 'x' })), /数组/)
  await assert.rejects(
    () => Promise.resolve(ctx.tools.invoke('todo_write', { todos: [{ content: 'a', status: 'doing' }] })),
    /status/,
  )
  await assert.rejects(
    () =>
      Promise.resolve(
        ctx.tools.invoke('todo_write', {
          todos: [
            { content: 'a', status: 'in_progress' },
            { content: 'b', status: 'in_progress' },
          ],
        }),
      ),
    /in_progress/,
  )
  const ok = await ctx.tools.invoke('todo_write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ],
  })
  assert.match(String(ok), /1\/2/)
})

test('unfinished todos trigger one extra step, reminder is not persisted', async () => {
  const { ctx, sessionId } = await spine()
  const seen: LlmMessage[][] = []
  const llm = scripted(
    [
      { content: null, toolCalls: [todoCall('t1', [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }])] },
      { content: '做完了', toolCalls: [] },
      { content: '确实还差 b', toolCalls: [] },
    ],
    seen,
  )
  const turn = await new AgentLoop(ctx, llm, sessionId, new AbortController().signal).run([{ kind: 'wake', text: 'go' }])
  assert.equal(turn.text, '确实还差 b')
  assert.equal(seen.length, 3)
  assert.match(reminderOf(seen[2]!) ?? '', /未完成/)
  const events = (await ctx.sessions.require(sessionId)).events
  assert.equal(events.filter((event) => event.type === 'turn/end').length, 1)
  assert.ok(!events.some((event) => 'text' in event && String(event.text).includes('system-reminder')))
})

test('completed todos end the turn without extra step', async () => {
  const { ctx, sessionId } = await spine()
  const seen: LlmMessage[][] = []
  const llm = scripted(
    [
      { content: null, toolCalls: [todoCall('t1', [{ content: 'a', status: 'completed' }])] },
      { content: 'ok', toolCalls: [] },
    ],
    seen,
  )
  await new AgentLoop(ctx, llm, sessionId, new AbortController().signal).run([{ kind: 'wake', text: 'go' }])
  assert.equal(seen.length, 2)
  assert.equal(reminderOf(seen[1]!), undefined)
})

test('reminders: skill_read hint, nudge once, stale recitation', () => {
  const base = (extra: Array<{ type: string } & Record<string, unknown>>) => [
    { type: 'turn/start' },
    { type: 'step/start' },
    ...extra,
    { type: 'step/end' },
    { type: 'step/start' },
  ]
  const afterSkill = todoTurnState(base([{ type: 'tool/call', id: 's', name: 'skill_read', arguments: '{}' }]))
  assert.match(todoReminder(afterSkill, 1, { done: false }) ?? '', /Skill/)

  const plain = todoTurnState(base([{ type: 'tool/call', id: 'b', name: 'bash', arguments: '{}' }]))
  assert.equal(todoReminder(plain, 1, { done: false }), undefined)
  const nudged = { done: false }
  assert.match(todoReminder(plain, TODO_NUDGE_STEP, nudged) ?? '', /todo_write/)
  assert.equal(todoReminder(plain, TODO_NUDGE_STEP + 1, nudged), undefined)

  const steps: Array<{ type: string } & Record<string, unknown>> = [
    { type: 'turn/start' },
    { type: 'step/start' },
    { type: 'tool/call', ...todoCall('t', [{ content: 'a', status: 'in_progress' }]) },
    { type: 'tool/result', id: 't', ok: true },
    { type: 'step/end' },
  ]
  for (let i = 0; i < TODO_STALE_STEPS - 1; i += 1) steps.push({ type: 'step/start' }, { type: 'step/end' })
  steps.push({ type: 'step/start' })
  const stale = todoTurnState(steps)
  assert.equal(stale.stepsSinceWrite, TODO_STALE_STEPS)
  assert.match(todoReminder(stale, 10, { done: true }) ?? '', /\[>\] a/)
})

test('failed todo_write is ignored; todos from previous turn are ignored', () => {
  const state = todoTurnState([
    { type: 'turn/start' },
    { type: 'tool/call', ...todoCall('old', [{ content: 'old', status: 'pending' }]) },
    { type: 'turn/start' },
    { type: 'tool/call', ...todoCall('bad', [{ content: 'x', status: 'pending' }]) },
    { type: 'tool/result', id: 'bad', ok: false },
  ])
  assert.equal(state.items, undefined)
})
