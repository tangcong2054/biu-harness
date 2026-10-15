import { Context, Service, type Plugin } from 'cordis'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import { PageEditorService } from '@biu/core-editor/web'
import { PickService } from '@biu/core-pick/web'
import { installShareCollectionChrome } from './share-chrome.ts'

let shareCtx: Context | null = null
const loaded = new Set<string>()

export function sharePluginModuleUrls(token: string, id: string, password = '') {
  const q = password ? `?password=${encodeURIComponent(password)}` : ''
  return [
    `/api/share/${encodeURIComponent(token)}/plugin/${encodeURIComponent(id)}/web.js${q}`,
    `/.plugin-dev/${encodeURIComponent(id)}/web/index.tsx`,
    `/.plugin-dev/${encodeURIComponent(id)}/web/index.ts`,
    `/.plugin/${encodeURIComponent(id)}/web.js`,
  ]
}

export function shareWebPluginOf(loaded: unknown): Plugin | undefined {
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
      apply: (typeof mod.apply === 'function' ? mod.apply : def) as Plugin['apply'],
    } as Plugin
  }
  if (def && typeof def === 'object') return def as Plugin
  if (typeof def === 'function') return def as Plugin
  return loaded as Plugin
}

const SHARE_PLUGIN_INJECT = new Set(['pageEditor', 'databaseUi', 'pick', 'uiActions'])

export function sharePluginInjectOk(inject: unknown) {
  const list = Array.isArray(inject) ? inject.map((item) => String(item)) : []
  return list.every((item) => SHARE_PLUGIN_INJECT.has(item))
}

/** 分享页不连工作台的 UI Actions 通道，只提供插件注册需要的空实现。 */
class ShareUiActions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'uiActions')
  }

  register() {
    return () => {}
  }
}

function installShareReactGlobals() {
  const g = globalThis as typeof globalThis & {
    React?: typeof React
    ReactDOM?: typeof ReactDOM & { createRoot: typeof createRoot; hydrateRoot: typeof hydrateRoot }
    ReactJSXRuntime?: typeof ReactJSXRuntime
  }
  g.React = React
  g.ReactDOM = { ...ReactDOM, createRoot, hydrateRoot, flushSync }
  g.ReactJSXRuntime = ReactJSXRuntime
}

export function bootShareRuntime() {
  if (shareCtx) return shareCtx
  installShareReactGlobals()
  shareCtx = new Context()
  new PageEditorService(shareCtx)
  new PickService(shareCtx)
  new ShareUiActions(shareCtx)
  installShareCollectionChrome(shareCtx)
  return shareCtx
}

async function importFirst(urls: string[]) {
  for (const url of urls) {
    try {
      return await import(/* @vite-ignore */ url)
    } catch {
      /* try next */
    }
  }
  return null
}

export async function loadSharePagePlugins(token: string, pluginIds: string[], password = '') {
  const ctx = bootShareRuntime()
  for (const id of pluginIds) {
    if (!id || loaded.has(id)) continue
    const mod = await importFirst(sharePluginModuleUrls(token, id, password))
    if (!mod) continue
    const plugin = shareWebPluginOf(mod)
    if (!plugin || !sharePluginInjectOk((plugin as { inject?: unknown }).inject)) continue
    try {
      const fiber = ctx.plugin(plugin)
      await fiber
      loaded.add(id)
    } catch {
      /* missing View stays as PageBlockMissing */
    }
  }
}
