import type { Context } from 'cordis'
import type { LlmMessage } from '@biu/host-llm'
import { latestTodos, parseTodoArgs, TODO_TOOL_NAME, todoProgress, type TodoItem } from '@biu/type-session'

/** 多少步没动清单就提醒一次（同时复述清单）。 */
export const TODO_STALE_STEPS = 5
/** 多少步还没建清单就提醒一次（每回合最多一次）。 */
export const TODO_NUDGE_STEP = 6

const DESCRIPTION = [
  '维护本回合的任务清单，用户界面会据此显示进度。每次传入完整清单（整体覆盖）。',
  '何时用：任务需要 3 步以上；用户一次提了多个需求；读到的说明（含 Skill）描述了多步流程。简单问答不要用。',
  '规则：开工前先列清单；同一时间只有一项 in_progress；做完一项立刻标 completed，不要攒着批量改；发现新工作就追加；不再需要的项直接删掉。',
].join('\n')

export function registerTodoTool(ctx: Context) {
  ctx.tools.register({
    name: TODO_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '一句话描述这一项' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    execute: (args) => {
      const items = parseTodoArgs(args)
      if (items.filter((item) => item.status === 'in_progress').length > 1) {
        throw new Error('同一时间只能有一项 in_progress')
      }
      const { done, total } = todoProgress(items)
      return `已更新 ${done}/${total}`
    },
  })
}

type LoopEvent = { type: string; name?: string; id?: string; ok?: boolean; partial?: boolean; arguments?: string }

export type TodoTurnState = {
  /** 本回合最近一次成功的清单；没有则 undefined。 */
  items?: TodoItem[]
  /** 距本回合最近一次 todo_write 过了几步；没调过为 undefined。 */
  stepsSinceWrite?: number
  /** 上一步调用过的工具名。 */
  lastTools: string[]
}

/** 只看本回合（最后一个 turn/start 之后）的事件。 */
export function todoTurnState(events: readonly LoopEvent[]): TodoTurnState {
  let start = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      start = i
      break
    }
  }
  const turn = events.slice(start) as Parameters<typeof latestTodos>[0]
  const latest = latestTodos(turn)
  let stepsSinceWrite: number | undefined
  if (latest) {
    stepsSinceWrite = 0
    for (let i = latest.index + 1; i < turn.length; i += 1) if (turn[i]?.type === 'step/end') stepsSinceWrite += 1
  }
  // 调用时当前 step/start 已写入；上一步 = 倒数第二个 step/start 到最后一个 step/start 之间。
  const starts: number[] = []
  for (let i = turn.length - 1; i >= 0 && starts.length < 2; i -= 1) {
    if (turn[i]?.type === 'step/start') starts.push(i)
  }
  const lastTools =
    starts.length === 2
      ? (turn.slice(starts[1], starts[0]) as LoopEvent[])
          .filter((event) => event.type === 'tool/call' && event.name)
          .map((event) => event.name!)
      : []
  return { items: latest?.items, stepsSinceWrite, lastTools }
}

function recite(items: readonly TodoItem[]) {
  const { done, total } = todoProgress(items)
  const mark = { completed: 'x', in_progress: '>', pending: ' ' } as const
  const open = items.filter((item) => item.status !== 'completed')
  return [`清单 ${done}/${total} 已完成：`, ...open.map((item) => `[${mark[item.status]}] ${item.content}`)].join('\n')
}

/**
 * 每步至多一条提醒，尽量少注入：
 * - 上一步读了 Skill 且本回合没清单 → 提示可建清单
 * - 跑到第 N 步还没清单 → 提示一次
 * - 清单 N 步没更新 → 复述未完成项
 */
export function todoReminder(state: TodoTurnState, step: number, nudged: { done: boolean }): string | undefined {
  if (!state.items) {
    if (state.lastTools.includes('skill_read')) {
      return '如果刚读的 Skill 描述了多步流程，先用 todo_write 列出计划再执行；只是参考信息则忽略本提示。'
    }
    if (!nudged.done && step >= TODO_NUDGE_STEP) {
      nudged.done = true
      return '任务看起来是多步的，用 todo_write 列出计划和进度；如果马上就能结束则忽略本提示。'
    }
    return undefined
  }
  const { unfinished } = todoProgress(state.items)
  if (!unfinished) return undefined
  const since = state.stepsSinceWrite ?? 0
  if (since > 0 && since % TODO_STALE_STEPS === 0) {
    return `${recite(state.items)}\n已有 ${since} 步没更新清单，请用 todo_write 同步进度。`
  }
  return undefined
}

/** 模型想结束但清单还有未完成项时的提醒。 */
export function todoUnfinishedReminder(items: readonly TodoItem[]): string | undefined {
  if (!todoProgress(items).unfinished) return undefined
  return `${recite(items)}\n清单还有未完成项。继续完成它们；若已完成或有意跳过，先用 todo_write 更新状态（不需要的项删掉），再给出最终回答。`
}

/** 提醒只拼进本次请求，不写入 session，不会在历史里累积。 */
export function withReminder(messages: LlmMessage[], reminder: string | undefined): LlmMessage[] {
  if (!reminder) return messages
  return [...messages, { role: 'user', content: `<system-reminder>\n${reminder}\n</system-reminder>` }]
}
