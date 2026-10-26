import { memo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/16/solid'
import { latestTodos, todoProgress, type TodoItem } from '@biu/type-session'

type Events = Parameters<typeof latestTodos>[0]

/** 只取最近一回合的清单；新回合开始前不显示上一回合的旧清单。 */
export function currentTurnTodos(events: Events): TodoItem[] | undefined {
  let start = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      start = i
      break
    }
  }
  return latestTodos(events.slice(start))?.items
}

const MARK: Record<TodoItem['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }

export const TodoPanel = memo(function TodoPanel({ items, running }: { items: TodoItem[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const { done, total, current } = todoProgress(items)
  // 回合结束且全部完成后就不再占位置。
  if (!total || (!running && done === total)) return null
  return (
    <div className="composer-todo" data-testid="composer-todo">
      <button
        type="button"
        className="composer-todo-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(event) => event.preventDefault()}
      >
        {open ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />}
        <span className="composer-todo-count">
          {done}/{total}
        </span>
        <span className="composer-todo-current" title={current?.content}>
          {current?.content ?? (done === total ? '全部完成' : '待开始')}
        </span>
      </button>
      <div className="composer-todo-bar" aria-hidden>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      {open ? (
        <ul className="composer-todo-list">
          {items.map((item, index) => (
            <li key={`${index}-${item.content}`} className={`composer-todo-item is-${item.status}`}>
              <span className="composer-todo-mark" aria-label={item.status}>
                {MARK[item.status]}
              </span>
              <span className="composer-todo-text">{item.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
})
