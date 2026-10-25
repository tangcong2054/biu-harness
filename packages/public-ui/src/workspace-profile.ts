export type WorkspaceProfile = {
  name: string
  avatar: string
}

const EVENT = 'biu:workspace-profile'
const EMPTY: WorkspaceProfile = { name: '', avatar: '' }
let cached: WorkspaceProfile = EMPTY

function sameProfile(a: WorkspaceProfile, b: WorkspaceProfile) {
  return a.name === b.name && a.avatar === b.avatar
}

function parse(raw: unknown): WorkspaceProfile {
  const rec = raw && typeof raw === 'object' ? (raw as Partial<WorkspaceProfile>) : {}
  return {
    name: String(rec.name ?? '').trim().slice(0, 40),
    avatar: String(rec.avatar ?? '').trim(),
  }
}

function remember(next: WorkspaceProfile) {
  if (sameProfile(cached, next)) return cached
  cached = next
  return cached
}

export function readWorkspaceProfile(): WorkspaceProfile {
  return cached
}

export function writeWorkspaceProfile(next: WorkspaceProfile) {
  const saved = remember({
    name: next.name.trim().slice(0, 40),
    avatar: next.avatar.trim(),
  })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT))
  return saved
}

export function subscribeWorkspaceProfile(onStore: () => void) {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => onStore()
  window.addEventListener(EVENT, onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
  }
}

export function profileDisplayName(profile = readWorkspaceProfile()) {
  return profile.name.trim() || '用户'
}

function accountToken() {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem('biu.account.token') ?? ''
}

export async function hydrateWorkspaceProfile() {
  const token = accountToken()
  if (!token) return writeWorkspaceProfile(EMPTY)
  try {
    const res = await fetch('/api/account/workspace-profile', {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return readWorkspaceProfile()
    const data = (await res.json()) as Partial<WorkspaceProfile>
    const next = parse(data)
    const current = readWorkspaceProfile()
    if (sameProfile(current, next)) return current
    return writeWorkspaceProfile(next)
  } catch {
    return readWorkspaceProfile()
  }
}

let profileWriteGen = 0

/**
 * 先切界面再保存。网络错误或非 2xx（无权限、会话过期）时，若期间没有更新的写入，
 * 回滚到修改前的资料并抛出，调用方据此提示——不能让界面显示「已保存」而服务端还是旧值。
 */
export async function persistWorkspaceProfile(next: WorkspaceProfile) {
  const previous = readWorkspaceProfile()
  const saved = writeWorkspaceProfile(next)
  const token = accountToken()
  if (!token) return saved
  const gen = ++profileWriteGen
  try {
    const res = await fetch('/api/account/workspace-profile', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(saved),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null
      throw new Error(typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`)
    }
  } catch (error) {
    if (gen === profileWriteGen) writeWorkspaceProfile(previous)
    throw error instanceof Error ? error : new Error(String(error))
  }
  return saved
}
