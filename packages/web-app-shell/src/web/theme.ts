export type ThemeMode = 'light' | 'dark'

let current: ThemeMode | null = null

export function readTheme(): ThemeMode {
  if (current === 'dark' || current === 'light') return current
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return 'dark'
    if (document.documentElement.classList.contains('light')) return 'light'
  }
  return 'light'
}

export function applyTheme(mode: ThemeMode) {
  current = mode
  if (typeof document === 'undefined') return
  try {
    sessionStorage.setItem('biu.theme.bootstrap', mode)
  } catch {
    /* sessionStorage may be unavailable in embedded/webview contexts */
  }
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (meta) meta.setAttribute('content', mode)
}

let themeWriteGen = 0

/** 先切界面；保存失败（网络或非 2xx）且期间没有新的切换时，回滚到切换前的主题。 */
export function persistTheme(mode: ThemeMode) {
  const previous = readTheme()
  const gen = ++themeWriteGen
  applyTheme(mode)
  return fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: mode }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return true
    })
    .catch((error) => {
      if (gen === themeWriteGen) applyTheme(previous)
      console.warn('[theme] save failed', error)
      return false
    })
}

export function applyStoredTheme() {
  applyTheme(readTheme())
}

/** 从 workspace profile 读主题，不经过 localStorage。 */
export async function hydrateTheme() {
  try {
    const res = await fetch('/api/profile')
    if (!res.ok) {
      applyStoredTheme()
      return readTheme()
    }
    const data = (await res.json()) as { theme?: unknown }
    if (data.theme !== 'dark' && data.theme !== 'light') {
      applyStoredTheme()
      return readTheme()
    }
    applyTheme(data.theme)
    return data.theme
  } catch {
    applyStoredTheme()
    return readTheme()
  }
}
