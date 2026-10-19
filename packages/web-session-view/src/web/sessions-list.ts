/** 与 SessionView 的尾部窗口一致；独立放置，供 Web 入口在插件图加载前预取。 */
export const SESSION_LOAD_TURNS = 24

const REQUEST_HOLD_MS = 400

type Held<T> = {
  scope: string
  promise: Promise<T>
}

let sessionsListInflight: Held<unknown[] | null> | null = null
const sessionTurnsInflight = new Map<string, Promise<{ status: number; body: unknown } | null>>()

function requestScope() {
  if (typeof localStorage === 'undefined') return 'server'
  try {
    const token = localStorage.getItem('biu.account.token') ?? ''
    const workspaceId =
      (typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem('biu.workspaceId')) ||
      localStorage.getItem('biu.workspaceId') ||
      ''
    return `${token}\0${workspaceId}`
  } catch {
    return 'storage-unavailable'
  }
}

export function resetSessionsListGet() {
  sessionsListInflight = null
  sessionTurnsInflight.clear()
}

/** 合并启动期、路由和侧栏发出的同一批会话列表请求。 */
export async function getSessionsList<T = Record<string, unknown>>(opts?: {
  refresh?: boolean
}): Promise<T[] | null> {
  const scope = requestScope()
  if (opts?.refresh || sessionsListInflight?.scope !== scope) sessionsListInflight = null
  if (sessionsListInflight) return sessionsListInflight.promise as Promise<T[] | null>
  let request: Promise<unknown[] | null>
  request = (async () => {
    const res = await fetch('/api/sessions')
    if (!res.ok) return null
    const body = (await res.json()) as { sessions?: unknown[] }
    return Array.isArray(body.sessions) ? body.sessions : []
  })().then(
    (body) => {
      if (body) {
        setTimeout(() => {
          if (sessionsListInflight?.promise === request) sessionsListInflight = null
        }, REQUEST_HOLD_MS)
      } else if (sessionsListInflight?.promise === request) {
        sessionsListInflight = null
      }
      return body
    },
    (error) => {
      if (sessionsListInflight?.promise === request) sessionsListInflight = null
      throw error
    },
  )
  sessionsListInflight = { scope, promise: request }
  return request as Promise<T[] | null>
}

/** 合并同一 Session 在启动预取与 SessionView revalidate 间的 turns 请求。 */
export async function getSessionTurns<T = Record<string, unknown>>(
  sessionId: string,
  opts?: { refresh?: boolean },
): Promise<{ status: number; body: T } | null> {
  if (!sessionId) return null
  const key = `${requestScope()}\0${sessionId}`
  if (opts?.refresh) sessionTurnsInflight.delete(key)
  const pending = sessionTurnsInflight.get(key)
  if (pending) return pending as Promise<{ status: number; body: T } | null>
  let request: Promise<{ status: number; body: unknown } | null>
  request = (async () => {
    const res = await fetch(`/api/sessions/${sessionId}?turns=${SESSION_LOAD_TURNS}`)
    const body = (await res.json().catch(() => ({}))) as unknown
    return { status: res.status, body }
  })().then(
    (got) => {
      if (got && got.status >= 200 && got.status < 300) {
        setTimeout(() => {
          if (sessionTurnsInflight.get(key) === request) sessionTurnsInflight.delete(key)
        }, REQUEST_HOLD_MS)
      } else if (sessionTurnsInflight.get(key) === request) {
        sessionTurnsInflight.delete(key)
      }
      return got
    },
    (error) => {
      if (sessionTurnsInflight.get(key) === request) sessionTurnsInflight.delete(key)
      throw error
    },
  )
  sessionTurnsInflight.set(key, request)
  return request as Promise<{ status: number; body: T } | null>
}

function mostRecentSessionId(sessions: Array<{ id?: unknown; updatedAt?: unknown }>) {
  let best: { id: string; updatedAt: number } | undefined
  for (const item of sessions) {
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) continue
    const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0
    if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && id.localeCompare(best.id) < 0)) {
      best = { id, updatedAt }
    }
  }
  return best?.id
}

/** 提前拉列表；只有聊天路由才预取 turns，数据页保持轻量。 */
export function seedSessionFetches() {
  if (typeof window === 'undefined') return
  try {
    if (!localStorage.getItem('biu.account.token')) return
  } catch {
    return
  }
  const sessionMatch = /^\/s\/([^/]+)/.exec(window.location.pathname)
  const onChatRoute = window.location.pathname === '/' || Boolean(sessionMatch)
  void getSessionsList().then((sessions) => {
    if (!onChatRoute) return
    const id = sessionMatch
      ? decodeURIComponent(sessionMatch[1] ?? '')
      : mostRecentSessionId(sessions ?? [])
    if (id) void getSessionTurns(id)
  })
}
