const React = globalThis.React
const { useState, useEffect, useMemo, useCallback, useRef } = React

export const name = 'cdb-limit-onclick'
export const inject = ['pageEditor']

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}

type FilterTask = {
  id: string
  status: string
  sqlType: string
  maxConcurrency: string
  currentConcurrency: string
  rejectedSqlCount: string
  originKeys: string
  originRule: string
  createTime: string
  expireTime: string
}

const S: Record<string, any> = {
  wrap: {
    border: '1px solid var(--biu-border, #e3e3e8)',
    borderRadius: 12,
    padding: '14px 16px',
    fontSize: 13,
    lineHeight: 1.55,
    background: 'var(--biu-bg-soft, rgba(127,127,127,.035))',
    // 可编辑岛屿为了换取文本选择权而设了 contenteditable，隐掉随之出现的闪烁光标
    caretColor: 'transparent',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  title: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  muted: { color: 'var(--biu-fg-muted, #8a9099)', fontSize: 12 },
  grid: { display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 3 },
  label: { fontSize: 11, color: 'var(--biu-fg-muted, #8a9099)' },
  input: {
    border: '1px solid var(--biu-border, #dcdee3)',
    borderRadius: 6,
    padding: '4px 7px',
    fontSize: 12,
    background: 'var(--biu-bg, #fff)',
    color: 'inherit',
    outline: 'none',
  },
  textarea: {
    border: '1px solid var(--biu-border, #dcdee3)',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'var(--biu-bg, #fff)',
    color: 'inherit',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
  },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  btn: (on: boolean, danger = false) => ({
    border: '1px solid ' + (danger ? '#d9534f' : 'var(--biu-border, #d5d8de)'),
    background: on ? (danger ? 'rgba(217,83,79,.10)' : 'var(--biu-bg, #fff)') : 'rgba(127,127,127,.06)',
    color: danger ? '#d9534f' : 'inherit',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    cursor: on ? 'pointer' : 'not-allowed',
    opacity: on ? 1 : 0.55,
  }),
  chip: (bg: string) => ({
    background: bg,
    borderRadius: 5,
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 400,
  }),
  ok: {
    marginTop: 10,
    border: '1px solid rgba(46,158,91,.5)',
    background: 'rgba(46,158,91,.08)',
    borderRadius: 8,
    padding: '8px 10px',
  },
  err: {
    marginTop: 10,
    border: '1px solid rgba(217,83,79,.5)',
    background: 'rgba(217,83,79,.07)',
    borderRadius: 8,
    padding: '8px 10px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  table: { width: '100%', borderCollapse: 'collapse', marginTop: 6 },
  th: {
    textAlign: 'left',
    fontSize: 11,
    color: 'var(--biu-fg-muted, #8a9099)',
    fontWeight: 500,
    padding: '4px 6px',
    borderBottom: '1px solid var(--biu-border, #e3e3e8)',
  },
  td: { padding: '4px 6px', borderBottom: '1px solid var(--biu-border, #f0f0f2)', verticalAlign: 'top' },
  confirm: {
    marginTop: 10,
    border: '1px solid #d9534f',
    background: 'rgba(217,83,79,.07)',
    borderRadius: 8,
    padding: '10px 12px',
  },
  badge: (status: string) => {
    const m: Record<string, [string, string]> = {
      RUNNING: ['#2e9e5b', 'rgba(46,158,91,.14)'],
      FINISHED: ['#5b6b7c', 'rgba(91,107,124,.12)'],
      TERMINATED: ['#c9821a', 'rgba(201,130,26,.14)'],
    }
    const [fg, bg] = m[status] ?? m.FINISHED
    return { color: fg, background: bg, borderRadius: 5, padding: '1px 7px', fontSize: 10, whiteSpace: 'nowrap' }
  },
}

const SQL_TYPES = ['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE']

async function api(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

/**
 * 从 SQL 原文抽限流关键词：表名（去掉库名前缀）+ 最长的字符串字面量（去掉 %）。
 * 内核是按 **子串匹配 + 逗号 AND** 生效，所以关键词越具体越安全。
 */
export function parseSql(sql: string): { sqlType: string; filterKey: string } {
  const s = String(sql || '')
  const typeM = s.match(/^\s*(select|update|delete|insert|replace)\b/i)
  const sqlType = typeM ? typeM[1].toUpperCase() : 'SELECT'
  const keys: string[] = []
  const t = s.match(/\b(?:from|join|update|into)\s+[`"[]?([A-Za-z0-9_$.]+)/i)
  if (t) {
    const last = (t[1].split('.').pop() || '').replace(/[`"[\]]/g, '')
    if (last) keys.push(last)
  }
  const lits = Array.from(s.matchAll(/'([^']*)'/g))
    .map((m) => m[1])
    .filter((v) => /[0-9A-Za-z]/.test(v))
    .sort((a, b) => b.length - a.length)
  const lit = lits[0]
  if (lit) {
    const cleaned = lit.replace(/%/g, '').replace(/,/g, ' ').trim()
    if (cleaned) keys.push(cleaned)
  }
  return { sqlType, filterKey: keys.join(',') }
}

function CdbLimitOnclickBlock({ data, update }: BlockProps) {
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v))

  const [status, setStatus] = useState<{ hasCredential: boolean; credential: any; error?: string } | null>(null)
  const [instanceId, setInstanceId] = useState(str(data.instanceId))
  const [region, setRegion] = useState(str(data.region))
  const [authUser, setAuthUser] = useState(str(data.authUser, 'root') || 'root')
  const [sql, setSql] = useState(str(data.sql))
  const [sqlType, setSqlType] = useState(str(data.sqlType, 'SELECT') || 'SELECT')
  const [filterKey, setFilterKey] = useState(str(data.filterKey))
  const [maxConcurrency, setMaxConcurrency] = useState(str(data.maxConcurrency, '2') || '2')
  const [duration, setDuration] = useState(str(data.duration, '-1') || '-1')

  // 密码只在内存里，不写块数据、不落盘
  const [dbPassword, setDbPassword] = useState('')

  const [tasks, setTasks] = useState<FilterTask[] | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pendingKill, setPendingKill] = useState<FilterTask | null>(null)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persist = useCallback(
    (patch: Record<string, unknown>) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => update(patch), 600)
    },
    [update],
  )
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const stopMouseDown = useCallback((event: { stopPropagation: () => void }) => event.stopPropagation(), [])
  /** 只读岛屿的输入闸门：块根节点是 contenteditable（为换取文本选择权），拦掉真正的改动。 */
  const guardEdit = useCallback((event: { target: unknown; preventDefault: () => void }) => {
    const target = event.target as { closest?: (sel: string) => unknown } | null
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, option')) return
    event.preventDefault()
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/api/cdb-limit-onclick/status')
      .then((r) => r.json())
      .then((j) => {
        if (alive) setStatus(j)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const loadTasks = useCallback(async () => {
    if (!instanceId.trim()) {
      setError('请先填实例 ID')
      return null
    }
    setBusy('list')
    setError('')
    try {
      const j = await api('/api/cdb-limit-onclick/list', { instanceId: instanceId.trim(), region })
      if (!j.ok) {
        setError(j.error ?? '查询失败')
        return null
      }
      const rows = (j.rows ?? []) as FilterTask[]
      setTasks(rows)
      return rows
    } catch (e) {
      setError(String(e))
      return null
    } finally {
      setBusy('')
    }
  }, [instanceId, region])

  const createFilter = useCallback(async () => {
    if (!instanceId.trim() || !filterKey.trim()) {
      setError('需要实例 ID 与关键词')
      return
    }
    setBusy('create')
    setError('')
    setNotice('')
    try {
      const j = await api('/api/cdb-limit-onclick/create', {
        instanceId: instanceId.trim(),
        region,
        user: authUser.trim(),
        password: dbPassword,
        sqlType,
        filterKey: filterKey.trim(),
        maxConcurrency: Number(maxConcurrency) || 0,
        duration: Number(duration),
      })
      if (!j.ok) {
        setError(j.error ?? '创建失败')
        return
      }
      setNotice(`已下发限流：FilterId = ${j.filterId}（规则 ${j.rule}）`)
      await loadTasks()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }, [instanceId, region, authUser, dbPassword, sqlType, filterKey, maxConcurrency, duration, loadTasks])

  const terminate = useCallback(async () => {
    const row = pendingKill
    if (!row) return
    setBusy('terminate')
    setError('')
    setNotice('')
    try {
      const j = await api('/api/cdb-limit-onclick/terminate', {
        instanceId: instanceId.trim(),
        region,
        user: authUser.trim(),
        password: dbPassword,
        filterIds: [row.id],
      })
      if (!j.ok) {
        setError(j.error ?? '终止失败')
        return
      }
      setNotice(`已终止限流任务 ${row.id}`)
      setPendingKill(null)
      await loadTasks()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }, [pendingKill, instanceId, region, authUser, dbPassword, loadTasks])

  const credOk = !!status?.hasCredential
  const rulePreview = `${sqlType},${duration || '?'},${maxConcurrency || '?'},${filterKey || '(关键词)'}`
  const parsed = useMemo(() => parseSql(sql), [sql])

  const block = (
    <div
      style={S.wrap}
      data-testid="cdb-limit-onclick-block"
      onMouseDown={stopMouseDown}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBeforeInput={guardEdit}
      onDrop={guardEdit}
    >
      <div style={S.head}>
        <div style={S.title}>
          SQL 限流下发
          <span style={S.chip(credOk ? 'rgba(46,158,91,.18)' : 'rgba(217,83,79,.18)')}>
            {credOk ? `凭证 OK · ${status?.credential?.secretId || ''}` : '无凭证'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={S.btn(!busy, false)} disabled={!!busy} onClick={() => void loadTasks()}>
            {busy === 'list' ? '查询中…' : '查询当前限流'}
          </button>
        </div>
      </div>

      <div style={S.grid}>
        <div style={S.field}>
          <span style={S.label}>实例 ID</span>
          <input
            style={{ ...S.input, width: 150 }}
            value={instanceId}
            onChange={(e: any) => {
              setInstanceId(e.target.value)
              persist({ instanceId: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>地域（留空按凭证）</span>
          <input
            style={{ ...S.input, width: 130 }}
            value={region}
            onChange={(e: any) => {
              setRegion(e.target.value)
              persist({ region: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>数据库账号</span>
          <input
            style={{ ...S.input, width: 120 }}
            value={authUser}
            onChange={(e: any) => {
              setAuthUser(e.target.value)
              persist({ authUser: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>密码（只用于换 token，不保存）</span>
          <input
            style={{ ...S.input, width: 150 }}
            type="password"
            value={dbPassword}
            placeholder="仅本次会话使用"
            onChange={(e: any) => setDbPassword(e.target.value)}
          />
        </div>
      </div>

      <div style={S.field}>
        <span style={S.label}>目标 SQL</span>
        <textarea
          style={S.textarea}
          rows={2}
          value={sql}
          onChange={(e: any) => {
            setSql(e.target.value)
            persist({ sql: e.target.value })
          }}
        />
      </div>

      <div style={{ ...S.grid, marginTop: 8 }}>
        <div style={S.field}>
          <span style={S.label}>SQL 类型</span>
          <select
            style={S.input}
            value={sqlType}
            onChange={(e: any) => {
              setSqlType(e.target.value)
              persist({ sqlType: e.target.value })
            }}
          >
            {SQL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div style={{ ...S.field, flex: 1, minWidth: 220 }}>
          <span style={S.label}>关键词（英文逗号分隔 = 同时命中；子串匹配）</span>
          <input
            style={S.input}
            value={filterKey}
            onChange={(e: any) => {
              setFilterKey(e.target.value)
              persist({ filterKey: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>最大并发</span>
          <input
            style={{ ...S.input, width: 70 }}
            value={maxConcurrency}
            onChange={(e: any) => {
              setMaxConcurrency(e.target.value)
              persist({ maxConcurrency: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>时长（秒，-1 = 永久）</span>
          <input
            style={{ ...S.input, width: 90 }}
            value={duration}
            onChange={(e: any) => {
              setDuration(e.target.value)
              persist({ duration: e.target.value })
            }}
          />
        </div>
        <div style={{ ...S.field, justifyContent: 'flex-end' }}>
          <button
            style={S.btn(!!sql.trim(), false)}
            disabled={!sql.trim()}
            onClick={() => {
              const p = parseSql(sql)
              setSqlType(p.sqlType)
              setFilterKey(p.filterKey)
              persist({ sqlType: p.sqlType, filterKey: p.filterKey })
              setNotice(`已从 SQL 解析：类型 ${p.sqlType}，关键词 ${p.filterKey || '(没解析到，请手填)'}`)
              setError('')
            }}
          >
            从 SQL 解析
          </button>
        </div>
      </div>

      <div style={{ ...S.muted, ...S.mono, marginTop: 2 }}>
        将下发规则：{rulePreview}
        {parsed.filterKey !== filterKey ? <span>（解析建议：{parsed.filterKey || '无'}）</span> : null}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button style={S.btn(!busy && !!filterKey.trim(), false)} disabled={!!busy || !filterKey.trim()} onClick={() => void createFilter()}>
          {busy === 'create' ? '下发中…' : '创建限流'}
        </button>
        {Number(maxConcurrency) === 0 ? (
          <span style={{ ...S.muted, color: '#d9534f' }}>最大并发 0 = 拒绝所有匹配的 SQL</span>
        ) : null}
        {Number(duration) === -1 ? <span style={S.muted}>永久生效，停止需手动终止</span> : null}
      </div>

      {pendingKill ? (
        <div style={S.confirm}>
          <div>
            确认 <b style={{ color: '#d9534f' }}>终止</b> 限流任务 <b>{pendingKill.id}</b>（{pendingKill.originRule}）？终止后该规则立即不再拦截。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={S.btn(!!busy, true)} disabled={!!busy} onClick={() => void terminate()}>
              {busy === 'terminate' ? '执行中…' : '确认终止'}
            </button>
            <button style={S.btn(!busy, false)} disabled={!!busy} onClick={() => setPendingKill(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {notice ? <div style={S.ok}>{notice}</div> : null}
      {error ? <div style={S.err}>{error}</div> : null}

      {tasks ? (
        tasks.length ? (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Id</th>
                <th style={S.th}>状态</th>
                <th style={S.th}>规则</th>
                <th style={S.th}>并发 / 上限</th>
                <th style={S.th}>已拒绝</th>
                <th style={S.th}>创建</th>
                <th style={S.th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td style={{ ...S.td, ...S.mono }}>{t.id}</td>
                  <td style={S.td}>
                    <span style={S.badge(t.status)}>{t.status}</span>
                  </td>
                  <td style={{ ...S.td, ...S.mono }}>{t.originRule}</td>
                  <td style={S.td}>
                    {t.currentConcurrency} / {t.maxConcurrency}
                  </td>
                  <td style={S.td}>{t.rejectedSqlCount}</td>
                  <td style={{ ...S.td, ...S.mono }}>{t.createTime}</td>
                  <td style={S.td}>
                    {t.status === 'RUNNING' ? (
                      <button style={S.btn(!busy, true)} disabled={!!busy} onClick={() => setPendingKill(t)}>
                        终止
                      </button>
                    ) : (
                      <span style={S.muted}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ ...S.muted, marginTop: 8 }}>该实例当前没有限流任务。</div>
        )
      ) : (
        <div style={{ ...S.muted, marginTop: 10 }}>
          填实例 ID → 贴目标 SQL → 点「从 SQL 解析」得到关键词 → 点「创建限流」直接下发。
          <br />
          匹配规则是 <b>子串 AND</b>：SQL 原文里同时出现全部关键词才命中；本块的解析会避开 <span style={S.mono}>%</span>。
        </div>
      )}
    </div>
  )

  return block
}

export function apply(ctx: {
  pageEditor: {
    registerBlock: (spec: {
      kind: string
      plugin: string
      label: string
      blockType?: string
      blockTypeLabel?: string
      hint?: string
      aliases?: string[]
      assets?: string[]
      defaults?: Record<string, unknown> | (() => Record<string, unknown>)
      View: (props: BlockProps) => unknown
    }) => void
  }
}) {
  ctx.pageEditor.registerBlock({
    kind: 'cdb-limit-onclick',
    plugin: name,
    label: 'SQL 限流下发',
    blockType: 'basic',
    blockTypeLabel: '基础',
    hint: '贴一条 SQL，解析关键词，一键下发 DBbrain 限流规则',
    aliases: ['limit', '限流', 'sql-filter', 'cdb', 'dbbrain', '下发'],
    assets: [],
    defaults: () => ({
      instanceId: '',
      region: '',
      authUser: 'root',
      sql: '',
      sqlType: 'SELECT',
      filterKey: '',
      maxConcurrency: '2',
      duration: '-1',
    }),
    View: CdbLimitOnclickBlock,
  })
}
