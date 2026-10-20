/** 插件共享的运行时引用（apply 时注入）与样式。 */

export const PLUGIN_ID = 'local-files'

export type UiActionsApi = { register: (spec: Record<string, unknown>) => () => void }

export const runtime: { uiActions?: UiActionsApi; pick?: import('./selection.ts').PickApi } = {}

const CSS = `
.lf-wb { --lf-border: rgba(15,23,42,.1); --lf-muted: #6b7280; --lf-ink: #1f2430; --lf-bar: #f6f7f9; --lf-hover: rgba(15,23,42,.05); --lf-active: rgba(59,130,246,.12); --lf-accent: #2563eb;
  display: flex; width: 100%; height: 100%; min-height: 0; color: var(--lf-ink); background: #fff;
  font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; border: 1px solid var(--lf-border); border-radius: 10px; overflow: hidden; position: relative; }
.lf-wb.is-flat { border: 0; border-radius: 0; }
.lf-wb button { font: inherit; color: inherit; }
.lf-side { width: 240px; min-width: 180px; max-width: 360px; display: flex; flex-direction: column; border-right: 1px solid var(--lf-border); background: var(--lf-bar); min-height: 0; }
.lf-side-head { display: flex; align-items: center; gap: 4px; padding: 6px 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--lf-muted); text-transform: uppercase; }
.lf-side-head .lf-grow { flex: 1; }
.lf-tree { flex: 1; overflow: auto; padding-bottom: 12px; min-height: 0; }
.lf-row { display: flex; align-items: center; gap: 4px; height: 24px; padding-right: 6px; cursor: pointer; white-space: nowrap; user-select: none; }
.lf-row:hover { background: var(--lf-hover); }
.lf-row.is-active { background: var(--lf-active); }
.lf-row .lf-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.lf-row .lf-ops { display: none; gap: 2px; }
.lf-row:hover .lf-ops { display: flex; }
.lf-root { font-weight: 600; height: 26px; }
.lf-caret { width: 14px; display: inline-flex; justify-content: center; color: var(--lf-muted); flex: none; }
.lf-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.lf-badge { font-size: 10px; font-weight: 500; padding: 0 5px; border-radius: 999px; background: rgba(15,23,42,.06); color: var(--lf-muted); flex: none; }
.lf-badge.is-rw { background: rgba(22,163,74,.1); color: #15803d; }
.lf-badge.is-warn { background: rgba(217,119,6,.12); color: #b45309; }
.lf-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; background: transparent; border-radius: 5px; cursor: pointer; color: var(--lf-muted); padding: 0; flex: none; }
.lf-icon-btn:hover { background: rgba(15,23,42,.08); color: var(--lf-ink); }
.lf-icon-btn:disabled { opacity: .35; cursor: default; background: transparent; }
.lf-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.lf-tabs { display: flex; align-items: stretch; height: 34px; background: var(--lf-bar); border-bottom: 1px solid var(--lf-border); flex: none; }
.lf-tab-list { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.lf-tab { display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; border-right: 1px solid var(--lf-border); cursor: pointer; white-space: nowrap; color: var(--lf-muted); max-width: 220px; }
.lf-tab.is-active { background: #fff; color: var(--lf-ink); box-shadow: inset 0 2px 0 var(--lf-accent); }
.lf-tab .lf-name { overflow: hidden; text-overflow: ellipsis; }
.lf-tab .lf-dirty { width: 8px; height: 8px; border-radius: 50%; background: var(--lf-ink); opacity: .55; }
.lf-tools { display: flex; align-items: center; gap: 2px; padding: 0 6px; flex: none; }
.lf-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; background: #fffbeb; color: #92400e; border-bottom: 1px solid rgba(217,119,6,.2); flex: none; }
.lf-banner.is-info { background: #eff6ff; color: #1e40af; border-bottom-color: rgba(37,99,235,.15); }
.lf-banner.is-error { background: #fef2f2; color: #991b1b; border-bottom-color: rgba(220,38,38,.2); }
.lf-banner .lf-grow { flex: 1; }
.lf-link { border: 0; background: none; color: var(--lf-accent); cursor: pointer; padding: 0; font: inherit; }
.lf-link:hover { text-decoration: underline; }
.lf-content { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.lf-pane { position: absolute; inset: 0; display: flex; flex-direction: column; }
.lf-pane[hidden] { display: none; }
.lf-cm { flex: 1; min-height: 0; }
.lf-status { display: flex; align-items: center; gap: 12px; height: 24px; padding: 0 10px; font-size: 11px; color: var(--lf-muted); background: var(--lf-bar); border-top: 1px solid var(--lf-border); flex: none; white-space: nowrap; overflow: hidden; }
.lf-status .lf-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lf-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; padding: 24px; text-align: center; color: var(--lf-muted); }
.lf-empty h4 { margin: 0; color: var(--lf-ink); font-size: 14px; }
.lf-empty .lf-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.lf-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--lf-border); background: #fff; cursor: pointer; font-size: 12.5px; }
.lf-btn:hover { background: var(--lf-hover); }
.lf-btn.is-primary { background: var(--lf-accent); border-color: var(--lf-accent); color: #fff; }
.lf-btn.is-primary:hover { background: #1d4ed8; }
.lf-btn:disabled { opacity: .5; cursor: default; }
.lf-seg { display: inline-flex; border: 1px solid var(--lf-border); border-radius: 6px; overflow: hidden; }
.lf-seg button { border: 0; background: #fff; padding: 2px 8px; cursor: pointer; font-size: 11.5px; }
.lf-seg button.is-on { background: var(--lf-active); color: var(--lf-accent); }
.lf-drop { position: absolute; inset: 0; background: rgba(37,99,235,.08); border: 2px dashed rgba(37,99,235,.5); border-radius: inherit; display: flex; align-items: center; justify-content: center; color: var(--lf-accent); font-weight: 600; pointer-events: none; z-index: 5; }
.lf-info { padding: 24px; color: var(--lf-muted); line-height: 1.8; }
.lf-info b { color: var(--lf-ink); }
`

export function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('lf-styles')) return
  const el = document.createElement('style')
  el.id = 'lf-styles'
  el.textContent = CSS
  document.head.appendChild(el)
}

const DOT_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#e8b600', jsx: '#e8b600', mjs: '#e8b600', json: '#8b5cf6', md: '#0ea5e9', markdown: '#0ea5e9',
  html: '#e34c26', htm: '#e34c26', css: '#264de4', scss: '#c6538c', less: '#1d365d', py: '#3572a5', go: '#00add8', rs: '#dea584',
  java: '#b07219', c: '#555', h: '#555', cpp: '#f34b7d', php: '#4f5d95', sql: '#e38c00', yml: '#cb171e', yaml: '#cb171e',
  sh: '#89e051', png: '#a855f7', jpg: '#a855f7', jpeg: '#a855f7', gif: '#a855f7', svg: '#ffb13b', pdf: '#dc2626',
}

export function dotColor(name: string) {
  const at = name.lastIndexOf('.')
  const ext = at > 0 ? name.slice(at + 1).toLowerCase() : ''
  return DOT_COLORS[ext] ?? '#c4c8cf'
}
