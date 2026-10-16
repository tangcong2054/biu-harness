import { Route, Routes, useLocation } from 'react-router-dom'
import type { SiteAction } from './site-chrome.tsx'
import { SiteChrome } from './site-chrome.tsx'
import { MarketingHome } from './home.tsx'
import { MarketingProduct } from './product.tsx'
import { MarketingUseCaseDetail, MarketingUseCases } from './use-cases.tsx'
import { type AuthMode, MarketingAuth } from './auth.tsx'
import { usePageMeta } from './use-page-meta.ts'

export type MarketingSiteProps = {
  onLogin: SiteAction
  onStart: SiteAction
  /** 可选：由外层 Shell 提供的真实登录/注册提交（内部解析 token 与 workspaceId） */
  auth?: {
    mode: AuthMode
    onModeChange: (mode: AuthMode) => void
    onSubmit: (credentials: { email: string; password: string }) => Promise<void>
    workspaceInvite?: boolean
  }
}

type PlaceholderProps = {
  label: string
  title: string
  body: string
  onLogin: SiteAction
  onStart: SiteAction
}

/** 未知路径：给一个诚实的占位，不留 404。 */
function Placeholder({ label, title, body, onLogin, onStart }: PlaceholderProps) {
  usePageMeta({ title, description: body, path: typeof window === 'undefined' ? '/' : window.location.pathname })
  return (
    <SiteChrome onLogin={onLogin} onStart={onStart}>
        <section className="site-page-hero" data-reveal>
          <p className="site-section-label">{label}</p>
          <h1>{title}</h1>
          <p className="site-page-lead">{body}</p>
        </section>
    </SiteChrome>
  )
}

/**
 * 官网路由。
 * 挂在 BrowserRouter 内，登录态判断由外层 Shell 负责 —— 这里只管路径。
 */
export function MarketingSite({ onLogin, onStart, auth }: MarketingSiteProps) {
  const authElement = auth ? (
    <MarketingAuth
      mode={auth.mode}
      onModeChange={auth.onModeChange}
      onSubmit={auth.onSubmit}
      onLogin={onLogin}
      onStart={onStart}
      workspaceInvite={auth.workspaceInvite}
    />
  ) : null
  return (
    <Routes>
      <Route path="/" element={<MarketingHome onLogin={onLogin} onStart={onStart} />} />
      <Route path="/product" element={<MarketingProduct onLogin={onLogin} onStart={onStart} />} />
      <Route path="/login" element={authElement} />
      <Route path="/register" element={authElement} />
      <Route path="/signup" element={authElement} />
      <Route path="/use-cases" element={<MarketingUseCases onLogin={onLogin} onStart={onStart} />} />
      <Route path="/use-cases/:slug" element={<MarketingUseCaseDetail onLogin={onLogin} onStart={onStart} />} />
      <Route
        path="*"
        element={
          <Placeholder
            label="404"
            title="这一页还没建"
            body="这个地址暂时没有内容，回到首页看看已有的页面吧。"
            onLogin={onLogin}
            onStart={onStart}
          />
        }
      />
    </Routes>
  )
}

/** 供外层判断当前是否处于官网路径。 */
export const SITE_PATHS = [
  '/',
  '/product',
  '/use-cases',
] as const

export function useIsSitePath(): boolean {
  const { pathname } = useLocation()
  if (pathname === '/') return true
  return SITE_PATHS.some((prefix) => prefix !== '/' && pathname.startsWith(prefix))
}
