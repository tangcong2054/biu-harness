import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
import { isOnlineRuntime, isOperationsRuntime, runWithAccount, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import { MysqlOperationsStore, type CloudStorageService } from '@biu/host-cloud-storage'
import { checkOperator, operationsCollections, registerOperationsIngest, seedOperationsIdentity } from './operations-collections.ts'
import type { OperationsRepository } from './operations-repository.ts'
import { OperationsStore } from './operations-store.ts'
import { defaultPluginDir, defaultStatePath } from './store.ts'

export const PLATFORM_OPERATIONS_PLUGIN_ID = 'platform-operations'

const MANIFEST = {
  id: PLATFORM_OPERATIONS_PLUGIN_ID,
  name: '平台运营',
  blurb: '平台运营私有页面块插件。在页面里插入 :::pageBlock {kind=platform-operations plugin=platform-operations}，查看用户、Workspace、用量、设备、同步、安全和插件审核，并配置在线主机的模型和 API Key。只给运营账号使用，不进入插件商店。',
  tags: ['page', 'editor', 'operations'],
  author: 'BIU官方',
  authorUrl: 'https://github.com/helloooooooooooooo97/biu',
  createdAt: 1791960000000,
  headless: true,
}

const HOST_JS = `import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'platform-operations'
export const inject = ['http', 'cloudStorage']

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
.ops-note{margin:0 0 10px;color:var(--dsw-label-3);font-size:12px;line-height:1.6}
.ops-models{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:12px}
.ops-picks{display:flex;flex-direction:column;gap:4px;max-height:420px;overflow:auto}
.ops-pick{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 8px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.ops-pick.is-active{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 8%,var(--dsw-bg))}
.ops-row{display:flex;gap:6px;align-items:center}
.ops-row .ops-pick{flex:1}
.ops-form{display:flex;flex-direction:column;gap:8px}
.ops-field{display:flex;flex-direction:column;gap:4px}
.ops-field span{font-size:11.5px;color:var(--dsw-label-3);font-weight:650}
.ops-input{height:30px;padding:0 8px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-bg);color:var(--dsw-label);font:inherit;font-size:12.5px}
.ops-status{font-size:12px;color:var(--dsw-ok,#3fb950)}
@media (max-width:720px){.ops-models{grid-template-columns:1fr}}
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
  ['models', '模型', ''],
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
  if (!res.ok) throw new Error(body.error || body.detail || '读取运营数据失败')
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

function ModelsPanel() {
  const [data, setData] = useState(null)
  const [activeId, setActiveId] = useState('deepseek')
  const [keyDraft, setKeyDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [addUrl, setAddUrl] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addProtocol, setAddProtocol] = useState('openai-compat')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  function applyData(next, prefer) {
    setData(next)
    const id = prefer || (next && next.endpointId) || 'deepseek'
    setActiveId(id)
    const found = ((next && next.endpoints) || []).find((item) => item.id === id)
    setUrlDraft(found && found.baseUrl ? found.baseUrl : '')
    setKeyDraft('')
    setAddKey('')
  }

  useEffect(() => {
    let live = true
    readJson('/api/operations/v1/llm')
      .then((body) => {
        if (live) applyData(body)
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : '读取模型配置失败')
      })
    return () => {
      live = false
    }
  }, [])

  const endpoints = (data && data.endpoints) || []
  const officialIds = { deepseek: 1, openai: 1, anthropic: 1 }
  const official = ['deepseek', 'anthropic', 'openai']
    .map((id) => endpoints.find((item) => item.id === id))
    .filter(Boolean)
  const extra = endpoints.filter(
    (item) => !officialIds[item.id] && (item.configured || item.group === 'custom' || item.id === (data && data.endpointId) || item.id === activeId),
  )
  const visible = official.concat(extra)
  const active = endpoints.find((item) => item.id === activeId) || null
  const models = ((data && data.modelCatalog) || []).filter((item) => item.endpointId === activeId)
  const envLocked = ((data && data.envLocked) || []).find((item) => item.endpointId === activeId)
  const isOfficial = Boolean(officialIds[activeId])

  function selectEndpoint(id) {
    setActiveId(id)
    setError('')
    setStatus('')
    setKeyDraft('')
    setModelDraft('')
    const found = endpoints.find((item) => item.id === id)
    setUrlDraft(found && found.baseUrl ? found.baseUrl : '')
  }

  async function postConfig(body, prefer) {
    const next = await readJson('/api/operations/v1/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    applyData(next, prefer || next.endpointId)
    if (next.envLockedRejected && next.envLockedRejected.length) {
      setError('该入口的 Key 由环境变量锁定，没有覆盖')
      return next
    }
    setStatus('已保存')
    return next
  }

  async function saveCurrent() {
    if (!active || busy) return
    const body = {}
    if (!envLocked && keyDraft.trim()) {
      body.setApiKey = {}
      body.setApiKey[activeId] = keyDraft.trim()
    }
    if (!isOfficial) {
      const base = urlDraft.trim()
      if (base && base !== (active.defaultBaseUrl || '')) {
        body.setBaseUrl = {}
        body.setBaseUrl[activeId] = base
      }
    }
    if (!body.setApiKey && !body.setBaseUrl) {
      setStatus('没有需要保存的更改')
      return
    }
    setBusy('save')
    setError('')
    setStatus('')
    try {
      await postConfig(body, activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  async function clearKey() {
    if (!active || envLocked || busy) return
    setBusy('clear')
    setError('')
    setStatus('')
    try {
      const setApiKey = {}
      setApiKey[activeId] = null
      await postConfig({ setApiKey }, activeId)
      setStatus('已清除 Key')
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除失败')
    } finally {
      setBusy('')
    }
  }

  async function testCurrent() {
    if (!active || busy) return
    setBusy('test')
    setError('')
    setStatus('')
    try {
      const payload = { endpointId: activeId }
      if (keyDraft.trim()) payload.apiKey = keyDraft.trim()
      if (!isOfficial && urlDraft.trim()) payload.baseUrl = urlDraft.trim()
      const currentModel = models[0] && models[0].model
      if (data && data.endpointId === activeId && data.model) payload.model = data.model
      else if (currentModel) payload.model = currentModel
      const next = await readJson('/api/operations/v1/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (next.config) applyData(next.config, activeId)
      setStatus(next.detail || '连接成功')
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接失败')
    } finally {
      setBusy('')
    }
  }

  async function makeDefault(model) {
    if (!model || busy) return
    setBusy('model')
    setError('')
    setStatus('')
    try {
      await postConfig({ endpointId: activeId, model: model.model }, activeId)
      setStatus('默认模型：' + model.label)
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置默认模型失败')
    } finally {
      setBusy('')
    }
  }

  async function addModel() {
    const name = modelDraft.trim()
    if (!name || busy) {
      if (!name) setError('请填写模型 ID')
      return
    }
    setBusy('add-model')
    setError('')
    setStatus('')
    try {
      await postConfig({ addModel: { endpointId: activeId, model: name, label: name } }, activeId)
      setModelDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加模型失败')
    } finally {
      setBusy('')
    }
  }

  async function removeModel(id) {
    if (!id || busy) return
    setBusy('remove-model')
    setError('')
    try {
      await postConfig({ removeCustomModel: id }, activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除模型失败')
    } finally {
      setBusy('')
    }
  }

  async function addEndpoint() {
    const label = addLabel.trim()
    const baseUrl = addUrl.trim()
    if (!label || !baseUrl) {
      setError('请填写名称和 Base URL')
      return
    }
    setBusy('add-endpoint')
    setError('')
    setStatus('')
    try {
      const created = await postConfig({ addEndpoint: { label, baseUrl, protocol: addProtocol } })
      const newId = created && created.endpointId
      if (addKey.trim() && newId) {
        const setApiKey = {}
        setApiKey[newId] = addKey.trim()
        await postConfig({ setApiKey, endpointId: newId }, newId)
      }
      setAddLabel('')
      setAddUrl('')
      setAddKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加入口失败')
    } finally {
      setBusy('')
    }
  }

  return h(
    'div',
    { 'data-testid': 'ops-models' },
    h(
      'p',
      { className: 'ops-note' },
      '这里配置的是在线主机正在使用的模型和 Key，与对话设置共用同一份存储。Key 只写进主机密钥文件，页面只显示掩码。',
    ),
    error ? h('p', { className: 'ops-error' }, error) : null,
    status ? h('p', { className: 'ops-status' }, status) : null,
    h(
      'div',
      { className: 'ops-models' },
      h(
        'div',
        { className: 'ops-picks', 'aria-label': '模型入口' },
        visible.map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'ops-pick' + (item.id === activeId ? ' is-active' : ''),
              onClick: () => selectEndpoint(item.id),
            },
            h('span', null, item.label || item.id),
            h(
              'span',
              { className: 'ops-badge ' + (item.configured ? 'ok' : '') },
              item.configured ? item.hint || '已配置' : '未配置',
            ),
          ),
        ),
      ),
      active
        ? h(
            'div',
            { className: 'ops-form' },
            h('div', { className: 'ops-sec' }, (active.label || active.id) + (data && data.endpointId === activeId ? ' · 当前默认' : '')),
            envLocked
              ? h('p', { className: 'ops-note' }, '这个入口的 Key 由环境变量 ' + envLocked.env + ' 锁定，运营页面不能覆盖。')
              : h(
                  'label',
                  { className: 'ops-field' },
                  h('span', null, 'API Key'),
                  h('input', {
                    className: 'ops-input',
                    type: 'password',
                    autoComplete: 'off',
                    'data-testid': 'ops-model-key',
                    placeholder: active.configured ? '已配置 · 输入新 Key 后保存' : active.placeholder || 'sk-…',
                    value: keyDraft,
                    onChange: (event) => setKeyDraft(event.target.value),
                  }),
                ),
            isOfficial
              ? h('p', { className: 'ops-note' }, '官方地址：' + (active.defaultBaseUrl || active.baseUrl || ''))
              : h(
                  'label',
                  { className: 'ops-field' },
                  h('span', null, 'Base URL'),
                  h('input', {
                    className: 'ops-input',
                    type: 'url',
                    'data-testid': 'ops-model-url',
                    value: urlDraft,
                    placeholder: active.defaultBaseUrl || '',
                    onChange: (event) => setUrlDraft(event.target.value),
                  }),
                ),
            h(
              'div',
              { className: 'ops-actions', style: { justifyContent: 'flex-start' } },
              h('button', { className: 'ops-btn pri', type: 'button', disabled: Boolean(busy), onClick: saveCurrent }, busy === 'save' ? '保存中…' : '保存'),
              h('button', { className: 'ops-btn', type: 'button', disabled: Boolean(busy), onClick: testCurrent }, busy === 'test' ? '测试中…' : '测试连接'),
              envLocked ? null : h('button', { className: 'ops-btn', type: 'button', disabled: Boolean(busy) || !active.configured, onClick: clearKey }, '清除 Key'),
            ),
            h('div', { className: 'ops-sec' }, '模型 · 点击设为默认'),
            models.length
              ? h(
                  'div',
                  { className: 'ops-picks' },
                  models.map((model) =>
                    h(
                      'div',
                      { key: model.id, className: 'ops-row' },
                      h(
                        'button',
                        { type: 'button', className: 'ops-pick' + (data && data.model === model.model && data.endpointId === activeId ? ' is-active' : ''), onClick: () => makeDefault(model) },
                        h('span', null, model.label || model.model),
                        data && data.model === model.model && data.endpointId === activeId ? h('span', { className: 'ops-badge ok' }, '默认') : null,
                      ),
                      model.builtin === false
                        ? h('button', { type: 'button', className: 'ops-btn sm', disabled: Boolean(busy), onClick: () => removeModel(model.id) }, '删除')
                        : null,
                    ),
                  ),
                )
              : h('p', { className: 'ops-note' }, '这个入口还没有模型。'),
            h(
              'div',
              { className: 'ops-actions', style: { justifyContent: 'flex-start' } },
              h('input', {
                className: 'ops-input',
                'data-testid': 'ops-model-name',
                placeholder: '添加模型 ID',
                value: modelDraft,
                onChange: (event) => setModelDraft(event.target.value),
              }),
              h('button', { className: 'ops-btn', type: 'button', disabled: Boolean(busy), onClick: addModel }, '添加模型'),
            ),
          )
        : h('p', { className: 'ops-empty' }, '还没有可配置的入口。'),
    ),
    h('div', { className: 'ops-sec' }, '添加自定义入口'),
    h(
      'div',
      { className: 'ops-form' },
      h('input', { className: 'ops-input', placeholder: '名称', value: addLabel, onChange: (event) => setAddLabel(event.target.value) }),
      h('input', { className: 'ops-input', placeholder: 'https://api.example.com/v1', value: addUrl, onChange: (event) => setAddUrl(event.target.value) }),
      h('input', {
        className: 'ops-input',
        type: 'password',
        autoComplete: 'off',
        placeholder: 'API Key（可选）',
        value: addKey,
        onChange: (event) => setAddKey(event.target.value),
      }),
      h(
        'div',
        { className: 'ops-actions', style: { justifyContent: 'flex-start' } },
        h(
          'button',
          { type: 'button', className: 'ops-btn' + (addProtocol === 'openai-compat' ? ' pri' : ''), onClick: () => setAddProtocol('openai-compat') },
          'OpenAI 兼容',
        ),
        h(
          'button',
          { type: 'button', className: 'ops-btn' + (addProtocol === 'anthropic' ? ' pri' : ''), onClick: () => setAddProtocol('anthropic') },
          'Anthropic',
        ),
        h('button', { className: 'ops-btn pri', type: 'button', disabled: Boolean(busy), onClick: addEndpoint }, '接入'),
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
    if (tab === 'overview' || tab === 'models') return
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
      h('span', { className: 'ops-meta' }, 'Online + Offline 元数据 · 不含用户正文'),
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
      error && tab !== 'models' ? h('p', { className: 'ops-error' }, error) : null,
      tab === 'models'
        ? h(ModelsPanel)
        : tab === 'overview'
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

type OperatorLlmChat = {
  activateAccount(): void
  patch(next: Record<string, unknown>, opts?: { persist?: boolean }): unknown
  applyAdminApiKeys(updates: Record<string, string | null>): { locked: string[]; view: Record<string, unknown> }
  operatorPublicView(): Record<string, unknown>
  testConnection(opts: { endpointId?: string; apiKey?: string; baseUrl?: string; model?: string }): Promise<{
    ok: boolean
    endpointId: string
    detail?: string
  }>
  markEndpointReachable(endpointId: string, opts?: { persist?: boolean; baseUrl?: string }): unknown
  invalidateEndpoint(endpointId: string): unknown
}

function adminKeyUpdates(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string | null> = {}
  for (const [id, key] of Object.entries(value as Record<string, unknown>)) {
    if (!id.trim()) continue
    if (key === null || key === '') out[id] = null
    else if (typeof key === 'string') out[id] = key
  }
  return out
}

function redactDetail(detail: unknown, secret?: string) {
  const text = typeof detail === 'string' ? detail : ''
  const hidden = secret?.trim()
  if (!hidden || hidden.length < 4 || !text.includes(hidden)) return text
  return text.split(hidden).join('***')
}

function operatorChat(ctx: Context): OperatorLlmChat | null {
  try {
    const chat = ctx.get('chat') as OperatorLlmChat | undefined
    if (!chat || typeof chat.applyAdminApiKeys !== 'function' || typeof chat.operatorPublicView !== 'function') return null
    return chat
  } catch {
    return null
  }
}

export function readOperatorLlm(ctx: Context, chat: OperatorLlmChat) {
  if (!checkOperator(ctx)) return { status: 403 as const, body: { error: '没有平台运营权限' } }
  chat.activateAccount()
  return { status: 200 as const, body: chat.operatorPublicView() }
}

export function writeOperatorLlm(ctx: Context, chat: OperatorLlmChat, payload: Record<string, unknown> | null) {
  if (!checkOperator(ctx)) return { status: 403 as const, body: { error: '没有平台运营权限' } }
  chat.activateAccount()
  const body = payload && typeof payload === 'object' ? payload : {}
  const updates = adminKeyUpdates(body.setApiKey)
  const rest: Record<string, unknown> = { ...body }
  delete rest.setApiKey
  delete rest.apiKey
  if (Object.keys(rest).length) chat.patch(rest)
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const view = chat.operatorPublicView() as { endpointId?: string }
    const endpointId =
      typeof rest.endpointId === 'string' && rest.endpointId.trim()
        ? rest.endpointId.trim()
        : String(view.endpointId ?? '')
    if (endpointId) updates[endpointId] = body.apiKey.trim()
  }
  if (!Object.keys(updates).length) return { status: 200 as const, body: chat.operatorPublicView() }
  const applied = chat.applyAdminApiKeys(updates)
  return {
    status: 200 as const,
    body: {
      ...applied.view,
      ...(applied.locked.length ? { envLockedRejected: applied.locked } : {}),
    },
  }
}

export async function testOperatorLlm(
  ctx: Context,
  chat: OperatorLlmChat,
  payload: { endpointId?: string; apiKey?: string; baseUrl?: string; model?: string },
) {
  if (!checkOperator(ctx)) return { status: 403 as const, body: { ok: false, error: '没有平台运营权限' } }
  chat.activateAccount()
  const draft = typeof payload.apiKey === 'string' ? payload.apiKey : ''
  try {
    const result = await chat.testConnection({
      endpointId: payload.endpointId,
      apiKey: draft,
      baseUrl: payload.baseUrl,
      model: payload.model,
    })
    const detail = redactDetail(result.detail, draft)
    if (!result.ok) {
      chat.invalidateEndpoint(result.endpointId)
      return {
        status: 400 as const,
        body: { ok: false, endpointId: result.endpointId, error: detail || '连接失败', config: chat.operatorPublicView() },
      }
    }
    let locked: string[] = []
    if (draft.trim()) {
      locked = chat.applyAdminApiKeys({ [result.endpointId]: draft.trim() }).locked
    }
    if (locked.length) {
      return {
        status: 409 as const,
        body: {
          ok: false,
          endpointId: result.endpointId,
          error: '该入口的 Key 由环境变量锁定，不会覆盖',
          envLockedRejected: locked,
          config: chat.operatorPublicView(),
        },
      }
    }
    if (typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) {
      chat.patch({ setBaseUrl: { [result.endpointId]: payload.baseUrl.trim() } })
    }
    chat.markEndpointReachable(result.endpointId, {
      persist: true,
      ...(typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? { baseUrl: payload.baseUrl.trim() } : {}),
    })
    return {
      status: 200 as const,
      body: { ok: true, endpointId: result.endpointId, detail: detail || '连接成功', config: chat.operatorPublicView() },
    }
  } catch {
    return { status: 500 as const, body: { ok: false, error: '连接测试失败' } }
  }
}

export function registerOperatorLlmRoutes(ctx: Context) {
  ctx.http.route('GET', '/api/operations/v1/llm', (route) => {
    const chat = operatorChat(ctx)
    if (!chat) {
      route.send(503, { error: '模型服务还没就绪' })
      return
    }
    const result = readOperatorLlm(ctx, chat)
    route.send(result.status, result.body)
  })
  ctx.http.route('POST', '/api/operations/v1/llm', async (route) => {
    const chat = operatorChat(ctx)
    if (!chat) {
      route.send(503, { error: '模型服务还没就绪' })
      return
    }
    try {
      const payload = (await route.json().catch(() => null)) as Record<string, unknown> | null
      const result = writeOperatorLlm(ctx, chat, payload)
      route.send(result.status, result.body)
    } catch {
      route.send(400, { error: '保存模型配置失败' })
    }
  })
  ctx.http.route('POST', '/api/operations/v1/llm/test', async (route) => {
    const chat = operatorChat(ctx)
    if (!chat) {
      route.send(503, { error: '模型服务还没就绪' })
      return
    }
    const payload = ((await route.json().catch(() => null)) ?? {}) as {
      endpointId?: string
      apiKey?: string
      baseUrl?: string
      model?: string
    }
    const result = await testOperatorLlm(ctx, chat, payload)
    route.send(result.status, result.body)
  })
}

export async function applyPlatformOperations(ctx: Context) {
  if (!isOnlineRuntime() && !isOperationsRuntime()) return
  registerOperatorLlmRoutes(ctx)
  ctx.inject(['database'], async (inner) => {
    const cloudStorage = ctx.get('cloudStorage') as CloudStorageService | undefined
    const cloudConfig = cloudStorage?.config
    const store: OperationsRepository =
      cloudStorage?.pool && cloudConfig?.enabled
        ? new MysqlOperationsStore(cloudStorage.pool, cloudConfig.operationsDatabase)
        : OperationsStore.open()
    await seedOperationsIdentity(ctx, store)
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
