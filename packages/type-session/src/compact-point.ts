import type { SessionEvent } from './index.ts'

/** 仅调整上下文投影中的压缩位置，原始日志与保留回合的事件顺序不变。 */
export function reorderRetainedContextEvents(events: SessionEvent[]): SessionEvent[] {
  const ordered: SessionEvent[] = []
  let lastCompactIndex = -1
  for (const event of events) {
    if (!isSessionCompactPoint(event)) {
      ordered.push(event)
      continue
    }
    let retainIndex = -1
    if (event.type === 'tool/call' && event.name === 'context_compact_submit') {
      try {
        const args = JSON.parse(event.arguments)
        if (args?.auto === true && 'retainFromSeq' in args) {
          if (!Number.isSafeInteger(args.retainFromSeq) || !sessionCompactSummaryText(event)) continue
          retainIndex = ordered.findIndex((item, index) => index > lastCompactIndex
            && item.type === 'turn/start' && item.seq === args.retainFromSeq)
          if (retainIndex < 0) continue
        }
      } catch {}
    }
    if (retainIndex >= 0) {
      ordered.splice(retainIndex, 0, event)
      lastCompactIndex = retainIndex
    } else {
      ordered.push(event)
      lastCompactIndex = ordered.length - 1
    }
  }
  return ordered
}

/** 压缩点：真正改窗口前缀的 tool/call（含旧独立工具名与 db_action）。 */

export function sessionCompactSummaryText(event: {
  type?: string
  name?: string
  arguments?: string
}): string {
  if (event.type !== 'tool/call') return ''
  try {
    const args = JSON.parse(event.arguments || '{}') as Record<string, unknown>
    if (event.name === 'db_action') {
      const nested =
        args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {}
      return String(nested.text ?? args.text ?? '').trim()
    }
    return String(args.text ?? '').trim()
  } catch {
    return ''
  }
}

function isSessionsDbAction(args: Record<string, unknown>): boolean {
  const path = String(args.path ?? args.collection ?? '')
  return path === 'sessions' || path === '/sessions' || path.includes('/sessions/')
}

export function isSessionCompactPoint(event: {
  type?: string
  name?: string
  arguments?: string
}): boolean {
  if (event.type !== 'tool/call') return false
  const name = event.name || ''
  if (name === 'context_compact_submit' || name === 'context_clear') return true
  if (name === 'session_compact') return sessionCompactSummaryText(event).length > 0
  if (name !== 'db_action') return false
  try {
    const args = JSON.parse(event.arguments || '{}') as Record<string, unknown>
    if (!isSessionsDbAction(args)) return false
    const action = String(args.action ?? '')
    if (action === 'clear') return true
    if (action === 'compact') return sessionCompactSummaryText(event).length > 0
    return false
  } catch {
    return false
  }
}
