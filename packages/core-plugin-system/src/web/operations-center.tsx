import { useEffect, useState } from 'react'
import type { DbRecord } from '@biu/type-file-system'
import type { FsViewProps } from '@biu/type-file-system/ui'

const TABS = [
  ['overview', '概览'],
  ['accounts', '用户'],
  ['workspaces', 'Workspace'],
  ['usage', '用量'],
  ['devices', '设备'],
  ['sync', '同步'],
  ['security', '安全'],
  ['plugins', '插件'],
  ['audit', '审计'],
] as const

const SOURCES: Record<string, string> = {
  accounts: '/ops-accounts',
  workspaces: '/ops-workspaces',
  usage: '/ops-usage',
  devices: '/ops-devices',
  sync: '/ops-sync-health',
  security: '/ops-security-events',
  plugins: '/plugin-reviews',
  audit: '/ops-audit',
}

type TabId = (typeof TABS)[number][0]

async function load(path: string, pendingOnly = false) {
  const filter = pendingOnly ? { reviewStatus: 'pending' } : {}
  const params = new URLSearchParams({ path, limit: '100', offset: '0', q: '', sort: 'updatedAt', dir: 'desc', filter: JSON.stringify(filter) })
  const res = await fetch(`/api/db/list?${params}`)
  const body = (await res.json()) as { items?: DbRecord[]; error?: string }
  if (!res.ok) throw new Error(body.error || '读取运营数据失败')
  return body.items ?? []
}

export function OperationsCenter({ rows }: FsViewProps) {
  const [tab, setTab] = useState<TabId>('overview')
  const [reviewView, setReviewView] = useState<'pending' | 'all'>('pending')
  const [items, setItems] = useState<DbRecord[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    if (tab === 'overview') return
    let live = true
    setError('')
    void load(SOURCES[tab]!, tab === 'plugins' && reviewView === 'pending')
      .then((next) => {
        if (live) setItems(next)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : '读取运营数据失败')
      })
    return () => {
      live = false
    }
  }, [tab, reviewView, busy])

  async function run(path: string, action: string) {
    setBusy(`${path}:${action}`)
    try {
      const res = await fetch('/api/db/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, action }),
      })
      const body = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(body.error || '操作失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="ops-center" data-testid="operations-center">
      <nav className="ops-tabs" aria-label="平台运营">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {error ? <p className="ops-error">{error}</p> : null}
      {tab === 'overview' ? <Overview rows={rows} onOpen={setTab} /> : (
        <>
          {tab === 'plugins' ? (
            <div className="ops-review-views">
              <button type="button" aria-pressed={reviewView === 'pending'} onClick={() => setReviewView('pending')}>待审核</button>
              <button type="button" aria-pressed={reviewView === 'all'} onClick={() => setReviewView('all')}>全部版本（历史）</button>
            </div>
          ) : null}
          <DataTable tab={tab} items={items} busy={busy} onRun={run} />
        </>
      )}
    </section>
  )
}

function Overview({ rows, onOpen }: { rows: DbRecord[]; onOpen: (tab: TabId) => void }) {
  const cards: Array<[TabId, string]> = [
    ['accounts', '用户'],
    ['workspaces', 'Workspace'],
    ['usage', '用量'],
    ['devices', '设备'],
    ['sync', '同步'],
    ['security', '安全'],
    ['audit', '审计'],
  ]
  return (
    <div className="ops-cards">
      {cards.map(([id, label]) => {
        const row = rows.find((item) => item.id === (id === 'audit' ? 'audits' : id))
        return (
          <button key={id} type="button" onClick={() => onOpen(id)}>
            <span>{label}</span>
            <strong>{Number(row?.value ?? 0)}</strong>
          </button>
        )
      })}
    </div>
  )
}

function DataTable({
  tab,
  items,
  busy,
  onRun,
}: {
  tab: TabId
  items: DbRecord[]
  busy: string
  onRun: (path: string, action: string) => void
}) {
  if (!items.length) return <p className="ops-empty">{tab === 'plugins' ? '当前没有符合条件的插件版本。' : '还没有上报数据。Online 和 Offline 会把运营元数据写到这里，不包含正文、密码或 Token。'}</p>
  return (
    <table className="ops-table">
      <tbody>
        {items.map((row) => (
          <tr key={row.id}>
            <td>{String(row.title ?? row.id)}</td>
            <td>{String(row.status ?? row.summary ?? row.reviewStatus ?? row.version ?? '')}{tab === 'plugins' && row.currentPublished === true ? ' · 当前上架' : tab === 'plugins' && row.reviewStatus === 'approved' ? ' · 历史已通过' : ''}</td>
            <td className="ops-actions">
              {tab === 'accounts' ? (
                <>
                  <button type="button" disabled={Boolean(busy)} onClick={() => onRun(`/ops-accounts/${row.id}`, 'suspend')}>暂停</button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => onRun(`/ops-accounts/${row.id}`, 'restore')}>恢复</button>
                </>
              ) : null}
              {tab === 'plugins' ? (
                <>
                  {(row.reviewStatus === 'pending' ? ['approve', 'reject', 'quarantine'] : row.currentPublished === true && row.reviewStatus === 'approved' ? ['revoke'] : []).map((action) => (
                    <button key={action} type="button" disabled={Boolean(busy)} onClick={() => onRun(`/plugin-reviews/${row.id}`, action)}>
                      {action === 'approve' ? '通过' : action === 'reject' ? '驳回' : action === 'quarantine' ? '隔离' : '撤销'}
                    </button>
                  ))}
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
