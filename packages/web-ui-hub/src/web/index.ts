import type { Context, Fiber, Plugin } from 'cordis'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { uiPackageLoaders } from 'virtual:cordis-ui-loaders'

export const name = 'ui-hub'
export const inject = ['slots', 'snapshot']

/** 商店包的 web 入口是已编译 ESM 的 URL，不在 Vite 虚拟表里。 */
export function isRuntimeWebModule(web: string) {
  return web.startsWith('/') || /^https?:\/\//.test(web)
}

const PLUGIN_LOAD_ATTEMPTS = 8

/** 商店 web.js 偶发 404（宿主还在 restore）时拉开重试，避免失败一次就停到下次刷新。 */
export function pluginLoadRetryDelay(attempt: number) {
  return Math.min(400 * 2 ** Math.max(0, attempt), 4000)
}

/** 动态 import 得到的是模块命名空间；不要只用 default，否则会丢掉 inject / name。 */
export function runtimeWebPlugin(loaded: unknown): Plugin | undefined {
  if (loaded == null) return undefined
  if (typeof loaded === 'function') return loaded as Plugin
  if (typeof loaded !== 'object') return undefined
  const mod = loaded as { default?: unknown; apply?: unknown; inject?: unknown; name?: unknown }
  const def = mod.default
  const hasMeta = typeof mod.apply === 'function' || Array.isArray(mod.inject) || typeof mod.name === 'string'
  if (typeof def === 'function' && hasMeta) {
    return {
      ...(typeof mod.name === 'string' ? { name: mod.name } : {}),
      ...(Array.isArray(mod.inject) ? { inject: mod.inject as string[] } : {}),
      apply: (typeof mod.apply === 'function' ? mod.apply : def) as Plugin['apply']
    } as Plugin
  }
  if (def && typeof def === 'object') return def as Plugin
  if (typeof def === 'function') return def as Plugin
  return loaded as Plugin
}

export function apply(ctx: Context) {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as typeof globalThis & {
      React?: typeof React
      ReactDOM?: typeof ReactDOM & { createRoot: typeof createRoot; hydrateRoot: typeof hydrateRoot }
      ReactJSXRuntime?: typeof ReactJSXRuntime
    }
    g.React = React
    g.ReactDOM = { ...ReactDOM, createRoot, hydrateRoot, flushSync }
    g.ReactJSXRuntime = ReactJSXRuntime
  }

  const forks = new Map<string, Fiber>()
  // 记录每个 fork 挂载时用的 web 入口 URL。
  // 打包后 URL 会带上新的版本号（?v=mtime），据此判断是否需要重新加载，
  // 否则插件的 fork 一旦建立就永远不会更新，改代码看不到效果。
  const forkWebs = new Map<string, string>()
  const loadAttempts = new Map<string, number>()
  let pending = false
  let running = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  async function resolvePlugin(_id: string, web?: string): Promise<Plugin | undefined> {
    if (!web) return undefined
    const loader = uiPackageLoaders[web]
    if (loader) return loader()
    if (isRuntimeWebModule(web)) {
      const href = web.startsWith('/') ? new URL(web, window.location.origin).href : web
      const bust = href.includes('?') ? `&v=${Date.now()}` : `?v=${Date.now()}`
      try {
        return await import(/* @vite-ignore */ `${href}${bust}`)
      } catch (error) {
        console.error(`ui-hub: failed to load ${web}`, error)
        return undefined
      }
    }
    return undefined
  }

  let retryDelay = 0

  async function sync() {
    if (running) {
      pending = true
      return
    }
    running = true
    retryDelay = 0
    try {
      const rows = ctx.snapshot.get().plugins
      const enabledRows = rows
        .filter((plugin) => {
          if (!plugin.web) return false
          if (plugin.enabled) return true
          return plugin.state === 'pending' || plugin.state === 'loading' || plugin.state === 'active'
        })
        .sort((a, b) => Number(b.id === 'core-file-system') - Number(a.id === 'core-file-system'))
      const enabledIds = new Set(enabledRows.map((plugin) => plugin.id))

      const webOf = new Map(enabledRows.map((plugin) => [plugin.id, plugin.web]))

      for (const [id, fiber] of [...forks.entries()]) {
        const stillEnabled = enabledIds.has(id)
        // web 入口变了（例如重打包后带上新的 ?v= 版本号）也要重挂。
        const sameWeb = forkWebs.get(id) === webOf.get(id)
        if (stillEnabled && sameWeb) continue
        await fiber.dispose()
        forks.delete(id)
        forkWebs.delete(id)
      }

      const enabledKeys = new Set(enabledRows.map((row) => `${row.id}\0${row.web ?? ''}`))
      for (const key of loadAttempts.keys()) if (!enabledKeys.has(key)) loadAttempts.delete(key)

      for (const row of enabledRows) {
        if (forks.has(row.id)) continue
        const attemptKey = `${row.id}\0${row.web ?? ''}`
        const loaded = await resolvePlugin(row.id, row.web)
        const plugin = loaded ? runtimeWebPlugin(loaded) : undefined
        if (!plugin) {
          if (isRuntimeWebModule(row.web ?? '')) {
            const next = (loadAttempts.get(attemptKey) ?? 0) + 1
            loadAttempts.set(attemptKey, next)
            if (next < PLUGIN_LOAD_ATTEMPTS) retryDelay = Math.max(retryDelay, pluginLoadRetryDelay(next - 1))
          }
          continue
        }
        loadAttempts.delete(attemptKey)
        const fiber = ctx.plugin(plugin)
        forks.set(row.id, fiber)
        forkWebs.set(row.id, row.web ?? '')
        await fiber
      }

      const fsUi = rows.some(
        (plugin) =>
          plugin.id === 'core-file-system' &&
          plugin.web &&
          (plugin.enabled || plugin.state === 'pending' || plugin.state === 'loading' || plugin.state === 'active'),
      )
      if (!fsUi) {
        const appModules = ctx.get('appModules') as { markNavReady?: () => void } | undefined
        appModules?.markNavReady?.()
      }
    } finally {
      running = false
      if (retryDelay && !retryTimer) {
        const delay = retryDelay
        retryTimer = setTimeout(() => {
          retryTimer = null
          void sync()
        }, delay)
      }
      if (pending) {
        pending = false
        await sync()
      }
    }
  }

  const mountKey = () =>
    ctx.snapshot
      .get()
      .plugins.filter((plugin) => plugin.web)
      .map((plugin) => `${plugin.id}\0${plugin.web}\0${plugin.enabled}\0${plugin.state}`)
      .sort()
      .join('|')
  let lastMountKey = ''
  ctx.snapshot.subscribe(() => {
    const key = mountKey()
    if (key === lastMountKey) return
    lastMountKey = key
    void sync()
  })
  ctx.on('dispose', () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  })
  lastMountKey = mountKey()
  return sync()
}
