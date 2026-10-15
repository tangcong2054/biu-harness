import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
import { isOnlineRuntime, isOperationsRuntime, runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { checkOperator, operationsCollections, registerOperationsIngest, seedOperationsIdentity } from './operations-collections.ts'
import { OperationsStore } from './operations-store.ts'
import { defaultPluginDir, defaultStatePath } from './store.ts'

export const PLATFORM_OPERATIONS_PLUGIN_ID = 'platform-operations'

const MANIFEST = {
  id: PLATFORM_OPERATIONS_PLUGIN_ID,
  name: '平台运营',
  blurb: '平台运营私有页面块插件。在页面里插入 :::pageBlock {kind=platform-operations plugin=platform-operations}，查看用户、Workspace、用量、设备、同步、安全和插件审核。只给运营账号使用，不进入插件商店。',
  tags: ['page', 'editor', 'operations'],
  author: 'BIU官方',
  authorUrl: 'https://github.com/helloooooooooooooo97/biu',
  createdAt: 1791960000000,
  headless: true,
}

const HOST_JS = `import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'platform-operations'
export const inject = ['http']

export async function apply(ctx) {
  const href = pathToFileURL(join(process.cwd(), 'packages/core-plugin-system/src/host/operations-plugin.ts')).href
  const mod = await import(href)
  await mod.applyPlatformOperations(ctx)
}
`

const WEB_JS = `const React = globalThis.React
const { useEffect, useState } = React
const h = React.createElement

const STYLE_ID = 'platform-operations-style-v2'
const CSS = \`
.ops-box{margin:12px 0;border:1px solid color-mix(in srgb,var(--dsw-label) 14%,var(--dsw-border));border-radius:10px;font-family:var(--font-sans);font-size:13.5px;color:var(--dsw-label);background:var(--dsw-bg);overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.ops-box *{box-sizing:border-box}
.ops-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.04))}
.ops-title{font-weight:700;font-size:13px;letter-spacing:.01em}
.ops-meta{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-3)}
.ops-grow{flex:1}
.ops-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label);font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.ops-btn:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.ops-btn.pri{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff}
.ops-btn.sm{height:23px;padding:0 8px;font-size:11.5px}
.ops-btn:disabled{opacity:.5;cursor:default}
.ops-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--dsw-border);background:color-mix(in srgb,var(--dsw-surface,rgba(127,127,127,.04)) 55%,transparent)}
.ops-tab{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 10px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-bg);color:var(--dsw-label-2,var(--dsw-label));font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.ops-tab:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.ops-tab.is-active{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 12%,var(--dsw-bg));color:var(--dsw-label)}
.ops-tab-cnt{font-family:var(--font-mono);font-size:11px;color:var(--dsw-label-3);padding:0 4px;border-radius:4px;background:var(--dsw-surface,rgba(127,127,127,.06))}
.ops-body{padding:12px}
.ops-sec{font-size:12px;color:var(--dsw-label-3);margin:14px 0 6px;font-weight:650;letter-spacing:.02em}
.ops-sec:first-child{margin-top:0}
.ops-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px}
.ops-card{display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;min-height:76px;border:1px solid var(--dsw-border);border-radius:8px;padding:9px 11px;background:var(--dsw-bg);color:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
.ops-card:hover{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 4%,var(--dsw-bg))}
.ops-klab{font-size:11.5px;color:var(--dsw-label-3);font-weight:600}
.ops-kval{font-family:var(--font-mono);font-size:20px;font-weight:700;line-height:1.2;margin:4px 0 2px}
.ops-ksub{font-size:11px;color:var(--dsw-label-3)}
.ops-table-wrap{max-height:420px;overflow:auto;border:1px solid var(--dsw-border);border-radius:8px}
.ops-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ops-table th{position:sticky;top:0;padding:6px 10px;border-bottom:1px solid var(--dsw-border);text-align:left;font-weight:650;color:var(--dsw-label-3);font-size:11.5px;white-space:nowrap;background:var(--dsw-bg);z-index:1}
.ops-table td{padding:6px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-border) 55%,transparent);vertical-align:middle}
.ops-table tr:last-child td{border-bottom:0}
.ops-mono{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-2,var(--dsw-label))}
.ops-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-family:var(--font-mono);border:1px solid var(--dsw-border);white-space:nowrap}
.ops-badge.ok{color:var(--dsw-ok,#3fb950);border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-ok,#3fb950) 8%,transparent)}
.ops-badge.warn{color:var(--dsw-warn,#d29922);border-color:color-mix(in srgb,var(--dsw-warn,#d29922) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-warn,#d29922) 8%,transparent)}
.ops-badge.bad{color:var(--dsw-danger,#d9534f);border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent)}
.ops-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap}
.ops-empty{padding:22px 12px;border:1px dashed var(--dsw-border);border-radius:8px;color:var(--dsw-label-3);font-size:12.5px;text-align:center;line-height:1.7}
.ops-error{margin:0 0 10px;padding:7px 10px;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent);color:var(--dsw-danger,#d9534f);font-size:12.5px}
\`

function useOpsStyle() {
  useEffect(() => {
    const found = document.getElementById(STYLE_ID)
    const el = found instanceof HTMLStyleElement ? found : document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

const TABS = [
  ['overview', '概览', ''],
  ['accounts', '用户', 'accounts'],
  ['workspaces', 'Workspace', 'workspaces'],
  ['usage', '用量', 'usage'],
  ['devices', '设备', 'devices'],
  ['sync', '同步', 'sync'],
  ['security', '安全', 'security'],
  ['plugins', '插件', 'plugins'],
  ['audit', '审计', 'audits'],
]

const SOURCES = {
  accounts: '/ops-accounts',
  workspaces: '/ops-workspaces',
  usage: '/ops-usage',
  devices: '/ops-devices',
  sync: '/ops-sync-health',
  security: '/ops-security-events',
  plugins: '/plugin-reviews',
  audit: '/ops-audit',
}

function fmtTime(ts) {
  const n = Number(ts || 0)
  if (!n) return '—'
  const d = new Date(n)
  const pad = (v) => String(v).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtNum(v) {
  const n = Number(v || 0)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
}

function fmtBytes(b) {
  const n = Number(b || 0)
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function toneForStatus(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'active' || s === 'online' || s === 'synced' || s === 'approved' || s === 'passed') return 'ok'
  if (s === 'suspended' || s === 'rejected' || s === 'quarantined' || s === 'revoked') return 'bad'
  if (s === 'pending' || s === 'syncing' || s === 'paused' || s === 'unpublished') return 'warn'
  return ''
}

async function readJson(url, options) {
  const res = await fetch(url, options)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || '读取运营数据失败')
  return body
}

function renderAccountsTable(rows, busy, run, showActions) {
  return h(
    'div',
    { className: 'ops-table-wrap' },
    h(
      'table',
      { className: 'ops-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, '账号 / 邮箱'),
          h('th', null, '平台来源'),
          h('th', null, '归属 Workspace'),
          h('th', null, '状态'),
          h('th', null, '最近活跃'),
          showActions ? h('th', { style: { textAlign: 'right' } }, '操作') : null,
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            { key: row.id },
            h(
              'td',
              null,
              h('div', { style: { fontWeight: 600 } }, String(row.email || row.title || row.id)),
              h('div', { className: 'ops-mono' }, String(row.id)),
            ),
            h('td', null, h('span', { className: 'ops-badge' }, String(row.plan || 'Online'))),
            h('td', { className: 'ops-mono' }, fmtNum(row.workspaceCount) + ' 个'),
            h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.status) }, String(row.status || 'active'))),
            h('td', { className: 'ops-mono' }, fmtTime(row.lastSeenAt || row.updatedAt)),
            showActions
              ? h(
                  'td',
                  { className: 'ops-actions' },
                  h('button', { className: 'ops-btn sm', type: 'button', disabled: Boolean(busy), onClick: () => run('/ops-accounts/' + row.id, 'suspend') }, '暂停'),
                  h('button', { className: 'ops-btn sm', type: 'button', disabled: Boolean(busy), onClick: () => run('/ops-accounts/' + row.id, 'restore') }, '恢复'),
                )
              : null,
          ),
        ),
      ),
    ),
  )
}

function renderWorkspacesTable(rows) {
  return h(
    'div',
    { className: 'ops-table-wrap' },
    h(
      'table',
      { className: 'ops-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Workspace 名称'),
          h('th', null, '位置类型'),
          h('th', null, '所有者'),
          h('th', null, '成员数'),
          h('th', null, '状态'),
          h('th', null, '创建时间'),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            { key: row.id },
            h(
              'td',
              null,
              h('div', { style: { fontWeight: 600 } }, String(row.name || row.title || row.id)),
              h('div', { className: 'ops-mono' }, String(row.id)),
            ),
            h(
              'td',
              null,
              h(
                'span',
                { className: 'ops-badge ' + (row.location === 'cloud' ? 'ok' : '') },
                row.location === 'cloud' ? 'Online 云端' : 'Offline 本机',
              ),
            ),
            h('td', null, String(row.ownerId || '—')),
            h('td', { className: 'ops-mono' }, fmtNum(row.memberCount) + ' 人'),
            h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.status) }, String(row.status || 'active'))),
            h('td', { className: 'ops-mono' }, fmtTime(row.createdAt || row.updatedAt)),
          ),
        ),
      ),
    ),
  )
}

function renderDetailTable(tab, items, busy, run) {
  if (!items.length) {
    return h('div', { className: 'ops-empty' }, '还没有上报数据。这里只保存运营元数据，不包含正文、密码或 Token。')
  }
  if (tab === 'accounts') return renderAccountsTable(items, busy, run, true)
  if (tab === 'workspaces') return renderWorkspacesTable(items)
  if (tab === 'usage') {
    return h(
      'div',
      { className: 'ops-table-wrap' },
      h(
        'table',
        { className: 'ops-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '日期'),
            h('th', null, '活跃账号 / 空间'),
            h('th', null, '模型请求数'),
            h('th', null, 'Token 总量'),
            h('th', null, '附件存储'),
          ),
        ),
        h(
          'tbody',
          null,
          items.map((row) =>
            h(
              'tr',
              { key: row.id },
              h('td', { className: 'ops-mono', style: { fontWeight: 650 } }, String(row.day || row.title || row.id)),
              h('td', null, String(row.accountId || '—')),
              h('td', { className: 'ops-mono' }, fmtNum(row.requests) + ' 次'),
              h('td', { className: 'ops-mono' }, fmtNum(row.tokens)),
              h('td', { className: 'ops-mono' }, fmtBytes(row.storageBytes)),
            ),
          ),
        ),
      ),
    )
  }
  if (tab === 'devices') {
    return h(
      'div',
      { className: 'ops-table-wrap' },
      h(
        'table',
        { className: 'ops-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '客户端 / 节点'),
            h('th', null, '登录账号'),
            h('th', null, '版本'),
            h('th', null, '系统与环境'),
            h('th', null, '状态'),
            h('th', null, '最近活跃'),
          ),
        ),
        h(
          'tbody',
          null,
          items.map((row) =>
            h(
              'tr',
              { key: row.id },
              h('td', { style: { fontWeight: 600 } }, String(row.installationId || row.title || row.id)),
              h('td', null, String(row.accountId || '—')),
              h('td', { className: 'ops-mono' }, String(row.version || '—')),
              h('td', null, String(row.os || '—')),
              h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.status) }, String(row.status || 'online'))),
              h('td', { className: 'ops-mono' }, fmtTime(row.lastSeenAt || row.updatedAt)),
            ),
          ),
        ),
      ),
    )
  }
  if (tab === 'sync') {
    return h(
      'div',
      { className: 'ops-table-wrap' },
      h(
        'table',
        { className: 'ops-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '同步通道 / 空间'),
            h('th', null, '状态'),
            h('th', null, '待同步变更'),
            h('th', null, '连接说明'),
            h('th', null, '最近同步'),
          ),
        ),
        h(
          'tbody',
          null,
          items.map((row) =>
            h(
              'tr',
              { key: row.id },
              h('td', { style: { fontWeight: 600 } }, String(row.installationId || row.title || row.id)),
              h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.status) }, String(row.status || 'synced'))),
              h('td', { className: 'ops-mono' }, fmtNum(row.pendingOps) + ' 条'),
              h('td', null, String(row.lastError || '正常')),
              h('td', { className: 'ops-mono' }, fmtTime(row.lastSyncAt || row.updatedAt)),
            ),
          ),
        ),
      ),
    )
  }
  if (tab === 'security') {
    return h(
      'div',
      { className: 'ops-table-wrap' },
      h(
        'table',
        { className: 'ops-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '事件类型'),
            h('th', null, '账号 / 环境'),
            h('th', null, '摘要说明'),
            h('th', null, '时间'),
          ),
        ),
        h(
          'tbody',
          null,
          items.map((row) =>
            h(
              'tr',
              { key: row.id },
              h('td', { style: { fontWeight: 600 } }, String(row.kind || row.title || row.id)),
              h('td', null, String(row.accountId || '—')),
              h('td', null, String(row.summary || '—')),
              h('td', { className: 'ops-mono' }, fmtTime(row.createdAt || row.updatedAt)),
            ),
          ),
        ),
      ),
    )
  }
  if (tab === 'plugins') {
    return h(
      'div',
      { className: 'ops-table-wrap' },
      h(
        'table',
        { className: 'ops-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '插件与版本'),
            h('th', null, '作者'),
            h('th', null, '审核状态'),
            h('th', null, '扫描状态'),
            h('th', { style: { textAlign: 'right' } }, '审核操作'),
          ),
        ),
        h(
          'tbody',
          null,
          items.map((row) =>
            h(
              'tr',
              { key: row.id },
              h(
                'td',
                null,
                h('div', { style: { fontWeight: 600 } }, String(row.title || row.id)),
                row.blurb ? h('div', { className: 'ops-ksub' }, String(row.blurb).slice(0, 68)) : null,
              ),
              h('td', null, String(row.author || '—')),
              h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.reviewStatus) }, String(row.reviewStatus || 'pending'))),
              h('td', null, h('span', { className: 'ops-badge ' + toneForStatus(row.scanStatus) }, String(row.scanStatus || 'passed'))),
              h(
                'td',
                { className: 'ops-actions' },
                ['approve', 'reject', 'quarantine', 'revoke'].map((action) =>
                  h(
                    'button',
                    { key: action, className: 'ops-btn sm', type: 'button', disabled: Boolean(busy), onClick: () => run('/plugin-reviews/' + row.id, action) },
                    action === 'approve' ? '通过' : action === 'reject' ? '驳回' : action === 'quarantine' ? '隔离' : '撤销',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    )
  }
  return h(
    'div',
    { className: 'ops-table-wrap' },
    h(
      'table',
      { className: 'ops-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, '动作'),
          h('th', null, '操作人'),
          h('th', null, '目标对象'),
          h('th', null, '说明'),
          h('th', null, '时间'),
        ),
      ),
      h(
        'tbody',
        null,
        items.map((row) =>
          h(
            'tr',
            { key: row.id },
            h('td', { className: 'ops-mono', style: { fontWeight: 650 } }, String(row.action || row.title || row.id)),
            h('td', null, String(row.actorId || '—')),
            h('td', { className: 'ops-mono' }, String(row.target || '—')),
            h('td', null, String(row.summary || '—')),
            h('td', { className: 'ops-mono' }, fmtTime(row.createdAt || row.updatedAt)),
          ),
        ),
      ),
    ),
  )
}

function OperationsBlock(props) {
  useOpsStyle()
  const initialTab = props && props.data && typeof props.data.tab === 'string' ? props.data.tab : 'overview'
  const [tab, setTab] = useState(initialTab)
  const [items, setItems] = useState([])
  const [counts, setCounts] = useState({})
  const [previewAccounts, setPreviewAccounts] = useState([])
  const [previewWorkspaces, setPreviewWorkspaces] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)

  function openTab(next) {
    setTab(next)
    if (props && typeof props.update === 'function' && props.writable !== false) {
      props.update({ tab: next })
    }
  }

  useEffect(() => {
    let live = true
    void Promise.all([
      readJson('/api/operations/v1/summary'),
      readJson('/api/db/list?path=/plugin-reviews&limit=1&offset=0').catch(() => ({ total: 0 })),
    ])
      .then(([body, reviews]) => {
        if (!live) return
        setCounts({ ...(body.counts || {}), plugins: Number(reviews.total || 0) })
        setPreviewAccounts(Array.isArray(body.accounts) ? body.accounts : [])
        setPreviewWorkspaces(Array.isArray(body.workspaces) ? body.workspaces : [])
      })
      .catch(() => {
        if (live) setCounts({})
      })
    return () => {
      live = false
    }
  }, [tab, busy, refreshTick])

  useEffect(() => {
    if (tab === 'overview') return
    let live = true
    setError('')
    const params = new URLSearchParams({ path: SOURCES[tab], limit: '100', offset: '0', q: '', sort: 'updatedAt', dir: 'desc', filter: '{}' })
    void readJson('/api/db/list?' + params.toString())
      .then((body) => {
        if (live) setItems(body.items || [])
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : '读取运营数据失败')
      })
    return () => {
      live = false
    }
  }, [tab, busy, refreshTick])

  async function run(path, action) {
    setBusy(path + ':' + action)
    try {
      await readJson('/api/db/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, action }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  async function syncNow() {
    setBusy('sync')
    setError('')
    try {
      await readJson('/api/operations/v1/sync', { method: 'POST' })
      setRefreshTick((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败')
    } finally {
      setBusy('')
    }
  }

  const cards = [
    ['accounts', '平台用户', 'Online + Offline 账号'],
    ['workspaces', 'Workspace', '云端与本机工作区'],
    ['usage', '用量活跃日', '模型请求与 Token 统计'],
    ['devices', '在线设备', '桌面端与浏览器会话'],
    ['sync', '同步通道', '云端与本机镜像健康'],
    ['security', '安全事件', '会话注销与公开分享'],
    ['plugins', '插件审核', '商店版本审核与隔离'],
    ['audits', '运营审计', '权限变更与治理记录'],
  ]

  return h(
    'section',
    { className: 'ops-box', 'data-testid': 'operations-center' },
    h(
      'header',
      { className: 'ops-hd' },
      h('span', { className: 'ops-title' }, 'Biu 平台运营中心'),
      h('span', { className: 'ops-meta' }, 'Online + Offline 元数据 · 不含用户正文与密钥'),
      h('div', { className: 'ops-grow' }),
      h(
        'button',
        { className: 'ops-btn', type: 'button', disabled: Boolean(busy), onClick: syncNow },
        busy === 'sync' ? '同步中…' : '刷新同步',
      ),
    ),
    h(
      'nav',
      { className: 'ops-tabs', 'aria-label': '平台运营' },
      TABS.map(([id, label, countKey]) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'ops-tab' + (tab === id ? ' is-active' : ''),
            onClick: () => openTab(id),
          },
          h('span', null, label),
          countKey && counts[countKey] != null
            ? h('span', { className: 'ops-tab-cnt' }, String(Number(counts[countKey] || 0)))
            : null,
        ),
      ),
    ),
    h(
      'div',
      { className: 'ops-body' },
      error ? h('p', { className: 'ops-error' }, error) : null,
      tab === 'overview'
        ? h(
            'div',
            null,
            h(
              'div',
              { className: 'ops-cards' },
              cards.map(([id, label, sub]) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'ops-card',
                    onClick: () => openTab(id === 'audits' ? 'audit' : id),
                  },
                  h('span', { className: 'ops-klab' }, label),
                  h('strong', { className: 'ops-kval' }, String(Number(counts[id] || 0))),
                  h('span', { className: 'ops-ksub' }, sub),
                ),
              ),
            ),
            previewWorkspaces.length
              ? h(
                  'div',
                  null,
                  h('div', { className: 'ops-sec' }, '平台 Workspace 一览（点击上方「Workspace」查看全部）'),
                  renderWorkspacesTable(previewWorkspaces),
                )
              : null,
            previewAccounts.length
              ? h(
                  'div',
                  null,
                  h('div', { className: 'ops-sec' }, '平台用户一览（点击上方「用户」可执行暂停 / 恢复）'),
                  renderAccountsTable(previewAccounts, busy, run, false),
                )
              : null,
          )
        : renderDetailTable(tab, items, busy, run),
    ),
  )
}

export const name = 'platform-operations'
export const inject = ['pageEditor']

export function apply(ctx) {
  ctx.pageEditor.registerBlock({
    kind: 'platform-operations',
    plugin: name,
    label: '平台运营',
    blockType: 'operations',
    blockTypeLabel: '运营',
    hint: '查看平台用户、Workspace、用量、设备、同步、安全和插件审核',
    aliases: ['operations', 'ops', '运营', '平台运营', '插件审核'],
    defaults: () => ({ tab: 'overview' }),
    View: OperationsBlock,
  })
}
`

const README = `# 平台运营

${MANIFEST.blurb}

## 示例写法

:::pageBlock {kind=platform-operations plugin=platform-operations}
{
  "tab": "overview"
}
:::
`

export function ensurePlatformOperationsPlugin() {
  if (!isOnlineRuntime() && !isOperationsRuntime()) return
  const dir = join(defaultPluginDir(), PLATFORM_OPERATIONS_PLUGIN_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(dir, 'host.js'), HOST_JS)
  writeFileSync(join(dir, 'web.js'), WEB_JS)
  writeFileSync(join(dir, 'README.md'), README)
  const statePath = defaultStatePath()
  mkdirSync(dirname(statePath), { recursive: true })
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      enabled?: string[]
      lastRunAt?: Record<string, number>
      origins?: Record<string, unknown>
    }
    if (Array.isArray(state.enabled) && state.enabled.includes(PLATFORM_OPERATIONS_PLUGIN_ID)) {
      const enabled = state.enabled.filter((id) => id !== PLATFORM_OPERATIONS_PLUGIN_ID)
      writeFileSync(statePath, JSON.stringify({ ...state, enabled }, null, 2))
    }
  } catch {
    /* ignore */
  }
}

export async function applyPlatformOperations(ctx: Context) {
  if (!isOnlineRuntime() && !isOperationsRuntime()) return
  ctx.inject(['database'], (inner) => {
    const store = OperationsStore.open()
    seedOperationsIdentity(ctx, store)
    registerOperationsIngest(ctx, store)
    for (const spec of operationsCollections(store, () => checkOperator(ctx))) inner.database.register(spec)
    void seedPlatformOperationsPage(inner)
  })
}

async function seedPlatformOperationsPage(ctx: Context) {
  const block = ':::pageBlock {id=ops00001 kind=platform-operations plugin=platform-operations}\n{\n  "tab": "overview"\n}\n:::\n'
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const db = ctx.get('database') as {
        collection?: (path: string) => unknown
        list?: (path: string) => Promise<{ items?: Array<{ id: string; title?: string }> }>
        create?: (path: string, content: unknown, options?: { scope?: 'workspace' }) => Promise<{ items?: Array<{ id: string }> }>
        update?: (path: string, content: unknown) => Promise<unknown>
        content?: (path: string) => Promise<{ value?: unknown }>
        writeContent?: (path: string, value: unknown) => Promise<unknown>
      } | undefined
      if (db?.collection?.('/pages') && db.list && db.create) {
        await runWithAccount('acc_operations_admin', () =>
          runWithRequestWorkspace('ws_operations', async () => {
            const pages = await db.list!('/pages')
            let target = pages.items?.find((item) => item.title === '平台运营')
            if (!target && !pages.items?.length) {
              const created = await db.create!('/pages', [{ title: '平台运营', notes: block }], { scope: 'workspace' })
              target = created?.items?.[0] ? { id: created.items[0].id, title: '平台运营' } : (await db.list!('/pages')).items?.[0]
            } else if (!target && pages.items?.length === 1 && pages.items[0]?.title === '未命名页面') {
              target = pages.items[0]
            }
            if (target && db.content && db.writeContent) {
              const current = await db.content(`/pages/${target.id}`)
              if (!String(current.value ?? '').trim()) {
                if (target.title !== '平台运营') await db.update?.(`/pages/${target.id}`, { title: '平台运营' })
                await db.writeContent(`/pages/${target.id}`, block)
              }
            }
          }),
        )
        return
      }
    } catch {
      /* 页面模块尚未就绪时等待重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

export function bindPlatformOperationsAccount(ctx: Context) {
  const account = ctx.get('account') as {
    store?: {
      syncInstalledPluginPackage?: (input: {
        id: string
        version: string
        packageHash: string
        packagePath: string
        sourceKind: 'legacy-installed'
        trustState: 'approved'
        tenantMode: 'assigned'
        hasWeb: boolean
        hasHost: boolean
        manifest: typeof MANIFEST
      }) => unknown
      installPluginForWorkspace?: (actorId: string, workspaceId: string, pluginId: string, pluginVersion?: string) => unknown
      setPluginLoad?: (accountId: string, workspaceId: string, pluginId: string, loaded: boolean) => void
    }
    authorization?: {
      attach?: (
        actor: { type: 'account'; accountId: string; workspaceId: string },
        resource: { type: 'record'; workspaceId: string; collection: string; recordId: string },
        input: { ownership: 'workspace'; accessMode: 'members' },
      ) => void
    }
  } | undefined
  try {
    const dir = join(defaultPluginDir(), PLATFORM_OPERATIONS_PLUGIN_ID)
    account?.store?.syncInstalledPluginPackage?.({
      id: PLATFORM_OPERATIONS_PLUGIN_ID,
      version: 'ops-v1',
      packageHash: 'ops-v1',
      packagePath: dir,
      sourceKind: 'legacy-installed',
      trustState: 'approved',
      tenantMode: 'assigned',
      hasWeb: true,
      hasHost: true,
      manifest: MANIFEST,
    })
    account?.store?.installPluginForWorkspace?.('acc_operations_admin', 'ws_operations', PLATFORM_OPERATIONS_PLUGIN_ID, 'ops-v1')
    account?.store?.setPluginLoad?.('acc_operations_admin', 'ws_operations', PLATFORM_OPERATIONS_PLUGIN_ID, true)
    account?.authorization?.attach?.(
      { type: 'account', accountId: 'acc_operations_admin', workspaceId: 'ws_operations' },
      { type: 'record', workspaceId: 'ws_operations', collection: '/plugins', recordId: PLATFORM_OPERATIONS_PLUGIN_ID },
      { ownership: 'workspace', accessMode: 'members' },
    )
  } catch {
    /* 账号模块未初始化时跳过 */
  }
}

export function platformOperationsModuleUrl() {
  return pathToFileURL(join(process.cwd(), 'packages/core-plugin-system/src/host/operations-plugin.ts')).href
}
