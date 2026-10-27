/** Agent 自维护的任务清单（todo_write 工具）。host 与前端共用同一份解析。 */
export const TODO_TOOL_NAME = 'todo_write'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoItem = { content: string; status: TodoStatus }

export const TODO_MAX_ITEMS = 50
export const TODO_MAX_CONTENT = 200

function isStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

/** 严格校验：工具入参用，非法直接抛错让模型改正。 */
export function parseTodoArgs(args: unknown): TodoItem[] {
  const raw = (args as { todos?: unknown } | null)?.todos
  if (!Array.isArray(raw)) throw new Error('todos 必须是数组')
  if (raw.length > TODO_MAX_ITEMS) throw new Error(`todos 最多 ${TODO_MAX_ITEMS} 项`)
  return raw.map((item, index) => {
    const rec = item as { content?: unknown; status?: unknown } | null
    const content = typeof rec?.content === 'string' ? rec.content.replace(/\s+/g, ' ').trim() : ''
    if (!content) throw new Error(`todos[${index}].content 不能为空`)
    if (!isStatus(rec?.status)) throw new Error(`todos[${index}].status 只能是 pending / in_progress / completed`)
    return { content: content.slice(0, TODO_MAX_CONTENT), status: rec.status }
  })
}

/** 宽松解析：渲染 / 回放历史用，坏数据返回 undefined。 */
export function tryParseTodoArgs(argumentsJson: string): TodoItem[] | undefined {
  try {
    return parseTodoArgs(JSON.parse(argumentsJson || '{}'))
  } catch {
    return undefined
  }
}

type TodoEventLike =
  | { type: 'tool/call'; id: string; name: string; arguments: string }
  | { type: 'tool/result'; id: string; ok: boolean; partial?: boolean }
  | { type: string }

/** 从事件日志里取最近一次成功的 todo_write；index 为该 tool/call 在数组中的位置。 */
export function latestTodos(events: readonly TodoEventLike[]): { items: TodoItem[]; index: number } | undefined {
  const failed = new Set<string>()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as TodoEventLike
    if (event.type === 'tool/result') {
      const result = event as { id: string; ok: boolean; partial?: boolean }
      if (!result.ok && !result.partial) failed.add(result.id)
      continue
    }
    if (event.type !== 'tool/call') continue
    const call = event as { id: string; name: string; arguments: string }
    if (call.name !== TODO_TOOL_NAME || failed.has(call.id)) continue
    const items = tryParseTodoArgs(call.arguments)
    if (items) return { items, index: i }
  }
  return undefined
}

export function todoProgress(items: readonly TodoItem[]) {
  const done = items.filter((item) => item.status === 'completed').length
  const current = items.find((item) => item.status === 'in_progress')
  return { done, total: items.length, current, unfinished: items.length - done }
}
