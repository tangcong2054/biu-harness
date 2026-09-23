import { createPortal } from 'react-dom'

const React = globalThis.React
const { useEffect, useMemo, useRef, useState } = React

export const name = 'websql'
export const inject = ['pageEditor']

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}

type Result = {
  ok: boolean
  columns?: string[]
  rows?: string[][]
  databases?: string[]
  info?: Record<string, string>
  ms?: number
  error?: string
  page?: number
  pageSize?: number
  hasMore?: boolean
}

type TableRow = {
  TABLE_NAME: string
  TABLE_TYPE: string
  TABLE_ROWS: string
}

type ColumnRow = {
  COLUMN_NAME: string
  COLUMN_TYPE: string
  IS_NULLABLE: string
  COLUMN_KEY: string
  EXTRA: string
}

const CSS = `
.wsp-root,.wsp-root *{box-sizing:border-box}
.wsp-root{border:1px solid var(--dsw-border);border-radius:8px;overflow:hidden;background:var(--dsw-bg);color:var(--dsw-label);font-family:var(--font-sans);font-size:13px}
.wsp-root.is-max{position:fixed;inset:0;z-index:2147483646;display:flex;min-width:0;min-height:0;flex-direction:column;border:0;border-radius:0}
.wsp-root.is-max .wsp-body{flex:1;height:auto;min-height:0;max-height:none}
.wsp-root.is-max .wsp-main{min-height:0}
.wsp-root.is-max .wsp-table-wrap{max-height:calc(100vh - 360px)}
.wsp-head{display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-hover)}
.wsp-title{font-weight:750}.wsp-badge{padding:1px 7px;border:1px solid var(--dsw-border);border-radius:999px;color:var(--dsw-label-3);font-size:10px}.wsp-spacer{flex:1}
.wsp-body{display:grid;grid-template-columns:220px minmax(0,1fr);height:min(560px,70vh);min-height:390px;max-height:680px;overflow:hidden}
.wsp-side{min-height:0;overflow:auto;overscroll-behavior:contain;border-right:1px solid var(--dsw-border);background:var(--dsw-hover)}
.wsp-config{padding:10px;border-bottom:1px solid var(--dsw-border)}
.wsp-grid2{display:grid;grid-template-columns:minmax(0,1fr) 68px;gap:6px}
.wsp-field{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}.wsp-label{color:var(--dsw-label-3);font-size:10px}
.wsp-input,.wsp-editor,.wsp-select{width:100%;border:1px solid var(--dsw-border);border-radius:5px;background:var(--dsw-input);color:var(--dsw-label);font:inherit;outline:none}
.wsp-input,.wsp-editor{caret-color:var(--dsw-label)!important;cursor:text!important;user-select:text!important;-webkit-user-select:text!important;pointer-events:auto}
.wsp-input,.wsp-select{height:26px;padding:0 7px}.wsp-input:focus,.wsp-editor:focus,.wsp-select:focus{border-color:var(--dsw-pick)}
.wsp-btn{height:26px;padding:0 9px;border:1px solid var(--dsw-border);border-radius:5px;background:var(--dsw-input);color:var(--dsw-label);font:inherit;font-weight:650;cursor:pointer;white-space:nowrap}
.wsp-btn:hover{background:var(--dsw-hover)}.wsp-btn:disabled{opacity:.5;cursor:default}.wsp-primary{background:var(--dsw-pick);border-color:var(--dsw-pick);color:white}
.wsp-connect{width:100%}.wsp-error{padding:7px 10px;color:var(--dsw-danger);font-size:11px;white-space:pre-wrap;word-break:break-word}
.wsp-db,.wsp-table-link{display:flex;width:100%;align-items:center;border:0;background:transparent;color:var(--dsw-label-2);font:inherit;text-align:left;cursor:pointer}
.wsp-db{padding:5px 10px}.wsp-table-link{padding:4px 10px 4px 27px;font-size:11px}.wsp-db:hover,.wsp-db.on,.wsp-table-link:hover,.wsp-table-link.on{background:var(--dsw-input);color:var(--dsw-label)}
.wsp-empty{padding:7px 10px;color:var(--dsw-label-3);font-size:11px}
.wsp-main{display:flex;min-width:0;min-height:0;flex-direction:column;overflow:auto;overscroll-behavior:contain;padding:10px}
.wsp-editor{min-height:100px;padding:8px;resize:vertical;font-family:var(--font-mono);font-size:12px;line-height:1.5}
.wsp-actions{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}.wsp-meta{color:var(--dsw-label-3);font-size:10px}
.wsp-panel{margin-top:10px;border:1px solid var(--dsw-border);border-radius:6px;overflow:hidden}.wsp-panel-head{display:flex;gap:7px;align-items:center;min-height:29px;padding:5px 8px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-hover);font-size:11px;font-weight:650}
.wsp-table-wrap{overflow:auto;max-height:300px}.wsp-table{width:max-content;min-width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px}
.wsp-table th{position:sticky;top:0;padding:5px 7px;border-right:1px solid var(--dsw-border);border-bottom:1px solid var(--dsw-border);background:var(--dsw-hover);text-align:left;white-space:nowrap}.wsp-table td{max-width:420px;padding:4px 7px;border-right:1px solid var(--dsw-border);border-bottom:1px solid var(--dsw-border);white-space:pre-wrap;word-break:break-word;vertical-align:top}
.wsp-cols{display:flex;gap:5px;flex-wrap:wrap;padding:7px}.wsp-col{padding:3px 6px;border:1px solid var(--dsw-border);border-radius:5px;font-family:var(--font-mono);font-size:10px}.wsp-col small{color:var(--dsw-label-3)}
@media(max-width:760px){.wsp-body{grid-template-columns:180px minmax(0,1fr)}}
`

const QUERY_PAGE_SIZE = 100

function useStyle() {
  useEffect(() => {
    const id = 'websql-page-style-v2'
    const existing = document.getElementById(id)
    const el = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
    el.id = id
    el.textContent = CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

function objects<T>(columns: string[], rows: string[][]): T[] {
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ''])) as T)
}

function quoteId(value: string) {
  return '`' + value.replace(/`/g, '``') + '`'
}

function stopEditorEvent(event: any) {
  event.stopPropagation()
}

function focusEditable(event: any) {
  event.stopPropagation()
  event.currentTarget?.focus()
}

async function request(serviceUrl: string, token: string, path: string, body: unknown): Promise<Result> {
  const response = await fetch(serviceUrl.replace(/\/+$/, '') + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  return payload
}

function Results({ result, componentId }: { result: Result; componentId: string }) {
  const columns = result.columns ?? []
  const rows = result.rows ?? []
  if (!columns.length) return <div className="wsp-empty">查询成功，没有结果集。</div>
  return (
    <div className="wsp-table-wrap">
      <table className="wsp-table">
        <thead><tr>{columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => {
                const value = row[columnIndex] ?? ''
                return (
                  <td
                    key={columnIndex}
                    data-biu-kind="websql-cell"
                    data-biu-id={`${componentId}:result:${rowIndex}:${columnIndex}`}
                    data-biu-label={`${column} · ${value === 'NULL' ? 'NULL' : value.slice(0, 80)}`}
                    data-biu-field={column}
                  >
                    {value === 'NULL' ? <i>NULL</i> : value}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WebSqlBlock({ data, update, writable }: BlockProps) {
  useStyle()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const serviceUrl = 'http://127.0.0.1:43120'
  const token = ''
  const [host, setHost] = useState(String(data.host || '127.0.0.1'))
  const [port, setPort] = useState(String(data.port || '3306'))
  const [user, setUser] = useState(String(data.user || ''))
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(String(data.database || ''))
  const [sql, setSql] = useState(String(data.sql || 'SELECT VERSION() AS version, NOW() AS now_time'))
  const [connected, setConnected] = useState(false)
  const [databases, setDatabases] = useState<string[]>([])
  const [expandedDatabase, setExpandedDatabase] = useState('')
  const [tables, setTables] = useState<TableRow[]>([])
  const [selectedTable, setSelectedTable] = useState('')
  const [columns, setColumns] = useState<ColumnRow[]>([])
  const [result, setResult] = useState<Result | null>(null)
  const [serverVersion, setServerVersion] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [max, setMax] = useState(false)
  const [componentId, setComponentId] = useState('websql')

  useEffect(() => {
    const root = rootRef.current
    const host = root?.parentElement?.closest('[data-page-block]')
    const id = host?.getAttribute('data-page-block-id') || host?.getAttribute('data-biu-id') || ''
    if (id) setComponentId(id)
  }, [])

  useEffect(() => {
    if (!max) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMax(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [max])

  const conn = useMemo(() => ({
    host,
    port: Number(port) || 3306,
    user,
    password,
  }), [host, port, user, password])

  const displayedContent = useMemo(() => JSON.stringify({
    componentId,
    connection: { ip: host, port: Number(port) || 3306, user },
    connected,
    serverVersion,
    database,
    databases,
    tables,
    selectedTable,
    columns,
    sql,
    result,
    error,
  }), [componentId, host, port, user, connected, serverVersion, database, databases, tables, selectedTable, columns, sql, result, error])

  function persist(patch: Record<string, unknown>) {
    if (writable) update(patch)
  }

  async function loadTables(nextDatabase: string) {
    setBusy('tables')
    const response = await request(serviceUrl, token, '/v1/schema', {
      conn,
      database: nextDatabase,
    })
    setBusy('')
    if (!response.ok) {
      setError(response.error || '读取数据表失败')
      return
    }
    setTables(objects<TableRow>(response.columns ?? [], response.rows ?? []))
  }

  async function connect() {
    setBusy('connect')
    setError('')
    const response = await request(serviceUrl, token, '/v1/connect', { conn })
    setBusy('')
    if (!response.ok) {
      setConnected(false)
      setError(response.error || '连接失败')
      return
    }
    setConnected(true)
    setDatabases(response.databases ?? [])
    setServerVersion(String(response.info?.version || ''))
    const nextDatabase = database || response.databases?.find((item) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(item)) || response.databases?.[0] || ''
    setDatabase(nextDatabase)
    setExpandedDatabase(nextDatabase)
    persist({ host, port: Number(port) || 3306, user, database: nextDatabase })
    if (nextDatabase) await loadTables(nextDatabase)
  }

  async function chooseDatabase(nextDatabase: string) {
    if (nextDatabase === expandedDatabase) {
      setExpandedDatabase('')
      return
    }
    setDatabase(nextDatabase)
    setExpandedDatabase(nextDatabase)
    setSelectedTable('')
    setColumns([])
    setResult(null)
    persist({ database: nextDatabase })
    await loadTables(nextDatabase)
  }

  async function chooseTable(table: string) {
    const nextSql = `SELECT *\nFROM ${quoteId(database)}.${quoteId(table)}\nLIMIT 100`
    setSelectedTable(table)
    setSql(nextSql)
    persist({ sql: nextSql })
    setBusy('columns')
    setError('')
    const response = await request(serviceUrl, token, '/v1/schema', { conn, database, table })
    setBusy('')
    if (!response.ok) {
      setError(response.error || '读取字段失败')
      return
    }
    setColumns(objects<ColumnRow>(response.columns ?? [], response.rows ?? []))
  }

  async function run(page = 1) {
    setBusy('query')
    setError('')
    if (page === 1) setResult(null)
    persist({ sql })
    const response = await request(serviceUrl, token, '/v1/query', {
      conn,
      database,
      sql,
      page,
      pageSize: QUERY_PAGE_SIZE,
    })
    setBusy('')
    if (!response.ok) {
      setError(response.error || '查询失败')
      return
    }
    setResult(response)
  }

  const block = (
    <div
      ref={rootRef}
      className={`wsp-root${max ? ' is-max' : ''}`}
      data-testid="websql-page-block"
      data-biu-kind="websql"
      data-biu-id={componentId}
      data-biu-label="WebSQL 当前组件"
      data-biu-plugin={name}
      data-biu-selection={displayedContent}
    >
      <div className="wsp-head">
        <span className="wsp-title">WebSQL</span>
        <span className="wsp-badge">Gateway</span>
        <span className="wsp-badge">严格只读</span>
        <span className="wsp-spacer" />
        <span className="wsp-meta">{serverVersion ? `MySQL ${serverVersion}` : '独立后端服务'}</span>
        <button
          className="wsp-btn"
          data-biu-kind="websql-action"
          data-biu-id={`${componentId}:fullscreen`}
          data-biu-label={max ? '退出全屏' : '全屏'}
          data-biu-action="fullscreen"
          onClick={() => setMax((value: boolean) => !value)}
          title={max ? '退出全屏（Esc）' : '全屏'}
        >
          {max ? '退出全屏' : '全屏'}
        </button>
      </div>
      <div className="wsp-body">
        <aside className="wsp-side" onWheel={stopEditorEvent}>
          <div className="wsp-config">
            <div className="wsp-grid2">
              <label className="wsp-field">
                <span className="wsp-label">IP</span>
                <input className="wsp-input" data-biu-kind="websql-field" data-biu-id={`${componentId}:connection:ip`} data-biu-label={`IP · ${host}`} data-biu-field="ip" value={host} onPointerDown={focusEditable} onMouseDown={stopEditorEvent} onClick={stopEditorEvent} onKeyDown={stopEditorEvent} onChange={(event: any) => setHost(event.target.value)} />
              </label>
              <label className="wsp-field">
                <span className="wsp-label">Port</span>
                <input className="wsp-input" data-biu-kind="websql-field" data-biu-id={`${componentId}:connection:port`} data-biu-label={`Port · ${port}`} data-biu-field="port" inputMode="numeric" value={port} onPointerDown={focusEditable} onMouseDown={stopEditorEvent} onClick={stopEditorEvent} onKeyDown={stopEditorEvent} onChange={(event: any) => setPort(event.target.value)} />
              </label>
            </div>
            <label className="wsp-field">
              <span className="wsp-label">User</span>
              <input className="wsp-input" data-biu-kind="websql-field" data-biu-id={`${componentId}:connection:user`} data-biu-label={`User · ${user || '空'}`} data-biu-field="user" autoComplete="username" value={user} onPointerDown={focusEditable} onMouseDown={stopEditorEvent} onClick={stopEditorEvent} onKeyDown={stopEditorEvent} onChange={(event: any) => setUser(event.target.value)} />
            </label>
            <label className="wsp-field">
              <span className="wsp-label">Password（不写入页面）</span>
              <input className="wsp-input" data-biu-kind="websql-field" data-biu-id={`${componentId}:connection:password`} data-biu-label="Password" data-biu-field="password" type="password" autoComplete="current-password" value={password} onPointerDown={focusEditable} onMouseDown={stopEditorEvent} onClick={stopEditorEvent} onKeyDown={stopEditorEvent} onChange={(event: any) => setPassword(event.target.value)} />
            </label>
            <button className="wsp-btn wsp-primary wsp-connect" data-biu-kind="websql-action" data-biu-id={`${componentId}:connect`} data-biu-label="连接数据库" data-biu-action="connect" disabled={busy === 'connect' || !user} onClick={() => void connect()}>
              {busy === 'connect' ? '验证中…' : connected ? '重新连接' : '连接'}
            </button>
          </div>
          {connected ? (
            <div>
              {databases.map((item) => (
                <div key={item}>
                  <button
                    className={`wsp-db${item === database ? ' on' : ''}`}
                    data-biu-kind="websql-database"
                    data-biu-id={`${componentId}:database:${item}`}
                    data-biu-label={`数据库 · ${item}`}
                    data-biu-action={item === expandedDatabase ? 'collapse' : 'expand'}
                    onClick={() => void chooseDatabase(item)}
                  >
                    {item === expandedDatabase ? '▾' : '▸'}&nbsp; {item}
                  </button>
                  {item === expandedDatabase ? (
                    <div>
                      {busy === 'tables' ? <div className="wsp-empty">读取数据表…</div> : null}
                      {tables.map((table) => (
                        <button
                          key={table.TABLE_NAME}
                          className={`wsp-table-link${selectedTable === table.TABLE_NAME ? ' on' : ''}`}
                          data-biu-kind="websql-table"
                          data-biu-id={`${componentId}:table:${item}.${table.TABLE_NAME}`}
                          data-biu-label={`表 · ${item}.${table.TABLE_NAME}`}
                          data-biu-action="open"
                          onClick={() => void chooseTable(table.TABLE_NAME)}
                        >
                          {table.TABLE_NAME}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </aside>
        <main className="wsp-main" onWheel={stopEditorEvent}>
          <textarea
            className="wsp-editor"
            data-biu-kind="websql-sql"
            data-biu-id={`${componentId}:sql`}
            data-biu-label="SQL 编辑器"
            data-biu-field="sql"
            value={sql}
            spellCheck={false}
            onPointerDown={focusEditable}
            onMouseDown={stopEditorEvent}
            onClick={stopEditorEvent}
            onChange={(event: any) => setSql(event.target.value)}
            onKeyDown={(event: any) => {
              event.stopPropagation()
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void run(1)
              }
            }}
          />
          <div className="wsp-actions">
            <button className="wsp-btn wsp-primary" data-biu-kind="websql-action" data-biu-id={`${componentId}:run`} data-biu-label="运行查询" data-biu-action="run" disabled={!connected || busy === 'query' || !sql.trim()} onClick={() => void run(1)}>
              {busy === 'query' ? '执行中…' : '运行查询'}
            </button>
            <button className="wsp-btn" data-biu-kind="websql-action" data-biu-id={`${componentId}:show-tables`} data-biu-label="SHOW TABLES" data-biu-action="fill-sql" disabled={!connected} onClick={() => setSql('SHOW TABLES')}>SHOW TABLES</button>
            <span className="wsp-meta">⌘/Ctrl + Enter · 密码与 Token 只存在当前页面内存</span>
          </div>
          {error ? <div className="wsp-error">{error}</div> : null}
          {selectedTable && columns.length ? (
            <section className="wsp-panel" data-biu-kind="websql-schema" data-biu-id={`${componentId}:schema:${database}.${selectedTable}`} data-biu-label={`字段结构 · ${database}.${selectedTable}`}>
              <div className="wsp-panel-head">字段结构 <span className="wsp-meta">{columns.length} 列</span></div>
              <div className="wsp-cols">
                {columns.map((column) => (
                  <span className="wsp-col" key={column.COLUMN_NAME} data-biu-kind="websql-column" data-biu-id={`${componentId}:column:${database}.${selectedTable}.${column.COLUMN_NAME}`} data-biu-label={`字段 · ${column.COLUMN_NAME}`} data-biu-field={column.COLUMN_NAME}>
                    {column.COLUMN_NAME} <small>{column.COLUMN_TYPE}{column.COLUMN_KEY ? ` · ${column.COLUMN_KEY}` : ''}</small>
                  </span>
                ))}
              </div>
            </section>
          ) : null}
          {result ? (
            <section className="wsp-panel" data-biu-kind="websql-result" data-biu-id={`${componentId}:result`} data-biu-label={`查询结果 · ${result.rows?.length ?? 0} 行`}>
              <div className="wsp-panel-head">
                查询结果
                <span className="wsp-meta">第 {result.page ?? 1} 页 · {result.rows?.length ?? 0} 行 · {result.ms ?? 0} ms</span>
                <span className="wsp-spacer" />
                <button
                  className="wsp-btn"
                  data-biu-kind="websql-action"
                  data-biu-id={`${componentId}:previous-page`}
                  data-biu-label="上一页"
                  data-biu-action="previous-page"
                  disabled={busy === 'query' || (result.page ?? 1) <= 1}
                  onClick={() => void run(Math.max(1, (result.page ?? 1) - 1))}
                >
                  上一页
                </button>
                <button
                  className="wsp-btn"
                  data-biu-kind="websql-action"
                  data-biu-id={`${componentId}:next-page`}
                  data-biu-label="下一页"
                  data-biu-action="next-page"
                  disabled={busy === 'query' || !result.hasMore}
                  onClick={() => void run((result.page ?? 1) + 1)}
                >
                  下一页
                </button>
              </div>
              <Results result={result} componentId={componentId} />
            </section>
          ) : null}
        </main>
      </div>
    </div>
  )
  return max ? createPortal(block, document.body) : block
}

export function apply(ctx: {
  pageEditor: { registerBlock: (spec: Record<string, unknown>) => void }
}) {
  ctx.pageEditor.registerBlock({
    kind: 'websql',
    plugin: name,
    label: 'WebSQL',
    blockType: 'basic',
    hint: '通过独立 Gateway 浏览并查询 MySQL（严格只读）',
    aliases: ['sql', 'mysql', '数据库', '查询'],
    defaults: () => ({
      host: '127.0.0.1',
      port: 3306,
      user: '',
      database: '',
      sql: 'SELECT VERSION() AS version, NOW() AS now_time',
    }),
    View: WebSqlBlock,
  })
}
