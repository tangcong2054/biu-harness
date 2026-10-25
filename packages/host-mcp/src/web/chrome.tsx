import { useState } from 'react'
import { CellMulti } from '@biu/database-ui'
import type { DbRecord } from '@biu/type-file-system'
import type { CollectionChrome, FsCellProps, FsDetailPaneProps } from '@biu/type-file-system/ui'

export type McpCatalogItem = {
  name: string
  description?: string
  allowed: boolean
}

export function catalogOf(record: DbRecord): McpCatalogItem[] {
  const raw = record.catalog
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const name = String(row.name ?? '').trim()
      if (!name) return null
      return {
        name,
        description: typeof row.description === 'string' ? row.description : '',
        allowed: row.allowed !== false,
      }
    })
    .filter((item): item is McpCatalogItem => Boolean(item))
}

export function namesOf(record: DbRecord): string[] {
  return catalogOf(record).map((item) => item.name)
}

export function asNameList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean)
}

async function patchMcp(id: string, content: Record<string, unknown>) {
  const res = await fetch('/api/db/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `/mcp/${id}`, content }),
  })
  const body = (await res.json()) as { error?: string }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  window.dispatchEvent(new Event('fsdb:change'))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function FilterCell({ field, value, record }: FsCellProps) {
  const [error, setError] = useState('')
  const names = namesOf(record)
  const selected = asNameList(value)
  const locked = record.builtin === true || record.builtin === 'true'
  if (!names.length && !selected.length) {
    return <span className="fsdb-muted">{locked ? '—' : '连接后从下方清单勾选'}</span>
  }
  if (locked) {
    return <span>{selected.length ? selected.join(', ') : '不限制'}</span>
  }
  return (
    <>
      <CellMulti
        values={selected}
        options={names.map((item) => ({ value: item, label: item }))}
        allowCreate={false}
        multiple
        onChange={(next) => {
          setError('')
          void patchMcp(String(record.id), { [field]: next }).catch((reason: unknown) => setError(errorText(reason)))
        }}
      />
      {error ? <span className="mcp-tools-error" role="alert" title={error}>没有保存：{error}</span> : null}
    </>
  )
}

function ToolsPane({ record }: FsDetailPaneProps) {
  const [error, setError] = useState('')
  const tools = catalogOf(record)
  const allow = asNameList(record.allow)
  const deny = asNameList(record.deny)
  const locked = record.builtin === true || record.builtin === 'true'
  if (!tools.length) {
    return <p className="mcp-tools-empty">还没拉到工具。连上服务器或点「刷新工具」后再看清单。</p>
  }

  function toggle(list: string[], name: string, on: boolean) {
    if (on) return list.includes(name) ? list : [...list, name]
    return list.filter((item) => item !== name)
  }

  const save = (content: Record<string, unknown>) => {
    setError('')
    void patchMcp(String(record.id), content).catch((reason: unknown) => setError(errorText(reason)))
  }

  return (
    <>
    {error ? <p className="mcp-tools-error" role="alert">工具选择没有保存成功：{error}</p> : null}
    <ul className="mcp-tools" data-testid="mcp-tools">
      {tools.map((tool) => {
        const excluded = deny.includes(tool.name)
        const allowOn = allow.includes(tool.name)
        return (
          <li key={tool.name} className={`mcp-tool${tool.allowed ? '' : ' is-blocked'}`}>
            <div className="mcp-tool-copy">
              <code className="mcp-tool-name">{tool.name}</code>
              {tool.description ? <span className="mcp-tool-desc">{tool.description}</span> : null}
            </div>
            {tool.allowed ? (
              <span className="mcp-tool-dot" title="可用" aria-label="可用" />
            ) : null}
            {locked ? null : (
              <div className="mcp-tool-actions">
                <button
                  type="button"
                  className={`mcp-tool-toggle${allowOn ? ' is-on' : ''}`}
                  aria-pressed={allowOn}
                  onClick={() => save({ allow: toggle(allow, tool.name, !allowOn) })}
                >
                  仅允许
                </button>
                <button
                  type="button"
                  className={`mcp-tool-toggle is-deny${excluded ? ' is-on' : ''}`}
                  aria-pressed={excluded}
                  onClick={() => save({ deny: toggle(deny, tool.name, !excluded) })}
                >
                  禁用
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
    </>
  )
}

export const mcpChrome: CollectionChrome = {
  cells: {
    allow: FilterCell,
    deny: FilterCell,
  },
  panes: [
    {
      id: 'tools',
      label: '工具',
      place: 'properties',
      badge: (record) => catalogOf(record).length || undefined,
      Pane: ToolsPane,
    },
  ],
}
