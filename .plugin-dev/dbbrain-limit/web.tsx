const React = globalThis.React
const { useState, useEffect, useMemo, useCallback, useRef } = React
// 宿主会把 'react-dom' 改写为 globalThis.ReactDOM（见 core-plugin-system/plugin-create.ts）
import { createPortal } from 'react-dom'

export const name = 'dbbrain-limit'
export const inject = ['pageEditor']

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}

type Session = {
  id: string
  user: string
  host: string
  db: string
  command: string
  time: string
  state: string
  info: string
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
  currentTime: string
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
  /** 最大化：铺满视口。挂在 body 顶层，避开编辑器的 isolation/overflow 裁剪。 */
  wrapMax: {
    position: 'fixed',
    inset: 0,
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: 0,
    borderRadius: 0,
    border: 'none',
    boxSizing: 'border-box',
    overflow: 'auto',
    zIndex: 2147483646,
    padding: '16px 20px 28px',
    background: 'var(--biu-bg, #fff)',
    color: 'inherit',
    fontSize: 13,
    lineHeight: 1.55,
    // 全屏层在 body 顶层，必须自己可选中文字
    userSelect: 'text',
    caretColor: 'transparent',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
  title: { fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 },
  row: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 3 },
  label: { fontSize: 11, opacity: 0.7 },
  input: {
    padding: '4px 7px',
    borderRadius: 6,
    border: '1px solid var(--biu-border,#d6d6dd)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 12,
  },
  btn: (on: boolean, danger?: boolean, small?: boolean) => ({
    padding: small ? '3px 10px' : '5px 14px',
    borderRadius: 8,
    border: '1px solid var(--biu-border,#d6d6dd)',
    background: on ? (danger ? '#d9534f' : 'var(--biu-accent,#4a6cf7)') : 'rgba(127,127,127,.10)',
    color: on ? '#fff' : 'inherit',
    cursor: on ? 'pointer' : 'not-allowed',
    font: 'inherit',
    fontSize: small ? 11 : 12,
    whiteSpace: 'nowrap',
  }),
  tab: (on: boolean) => ({
    padding: '4px 13px',
    borderRadius: 999,
    border: '1px solid var(--biu-border,#d6d6dd)',
    background: on ? 'var(--biu-accent,#4a6cf7)' : 'transparent',
    color: on ? '#fff' : 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  }),
  chip: (on: boolean, tone?: string) => ({
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--biu-border,#d6d6dd)',
    fontSize: 11,
    background: on ? (tone || 'rgba(74,108,247,.16)') : 'transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }),
  muted: { opacity: 0.65, fontSize: 12 },
  err: { color: '#d9534f', fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 6 },
  ok: { color: '#2e9e5b', fontSize: 12, marginTop: 6 },
  warn: { color: '#c9821a', fontSize: 12, marginTop: 6 },
  panel: {
    marginTop: 10,
    border: '1px solid var(--biu-border,#e3e3e8)',
    borderRadius: 8,
    padding: '10px 12px',
  },
  tableWrap: { marginTop: 10, border: '1px solid var(--biu-border,#e3e3e8)', borderRadius: 8, overflow: 'auto', maxHeight: 460 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    position: 'sticky',
    top: 0,
    background: 'var(--biu-bg, #fff)',
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid var(--biu-border,#e3e3e8)',
    fontSize: 11,
    opacity: 0.85,
    zIndex: 1,
    whiteSpace: 'nowrap',
  },
  td: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,.13)', verticalAlign: 'top' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' },
  sql: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    maxWidth: 380,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
    display: 'block',
  },
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
const STATUSES = ['RUNNING', 'FINISHED', 'TERMINATED']

async function api(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function DbbrainLimitBlock({ data, update, writable }: BlockProps) {
  const [status, setStatus] = useState<{ hasCredential: boolean; credential: any; error?: string; instanceCount?: number } | null>(null)
  const [tab, setTab] = useState<string>((data.tab as string) ?? 'sessions')

  const [instanceId, setInstanceId] = useState<string>((data.instanceId as string) ?? '')
  const [region, setRegion] = useState<string>((data.region as string) ?? '')
  const [authUser, setAuthUser] = useState<string>((data.authUser as string) ?? 'root')

  // 会话筛选
  const [fUser, setFUser] = useState('')
  const [fDb, setFDb] = useState('')
  const [fState, setFState] = useState('')
  const [fCommand, setFCommand] = useState('')
  const [fTime, setFTime] = useState('')
  const [fInfo, setFInfo] = useState('')
  const [fLimit, setFLimit] = useState('50')

  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [sessAt, setSessAt] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 限流任务
  const [tasks, setTasks] = useState<FilterTask[] | null>(null)
  const [taskTotal, setTaskTotal] = useState(0)
  const [taskStatuses, setTaskStatuses] = useState<string[]>(['RUNNING'])

  // 新建限流表单
  // 新建限流表单：字段从块数据 draft 读（可预填），编辑后回写，随文档走。
  const draft = (data.draft ?? {}) as Record<string, unknown>
  const str = (v: unknown, fallback = '') =>
    typeof v === 'string' ? v : v == null ? fallback : String(v)
  const [cSqlType, setCSqlType] = useState(str(draft.sqlType, 'SELECT') || 'SELECT')
  const [cFilterKey, setCFilterKey] = useState(str(draft.filterKey))
  const [cMax, setCMax] = useState(str(draft.maxConcurrency, '1') || '1')
  const [cDuration, setCDuration] = useState(str(draft.duration, '300') || '300')

  /** 草稿写回（防抖，避免每敲一个字都改一次文档正文）。 */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushDraft = useCallback(
    (next: { sqlType: string; filterKey: string; maxConcurrency: string; duration: string }) => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
      draftTimer.current = setTimeout(() => update({ draft: next }), 600)
    },
    [update],
  )
  const patchDraft = useCallback(
    (patch: Partial<{ sqlType: string; filterKey: string; maxConcurrency: string; duration: string }>) => {
      flushDraft({ sqlType: cSqlType, filterKey: cFilterKey, maxConcurrency: cMax, duration: cDuration, ...patch })
    },
    [cSqlType, cFilterKey, cMax, cDuration, flushDraft],
  )
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
    },
    [],
  )

  // 数据库账号（密码不写进块数据）
  const [dbUser, setDbUser] = useState<string>((data.authUser as string) ?? 'root')
  const [dbPassword, setDbPassword] = useState('')
  const [tokenReady, setTokenReady] = useState(false)
  const [needToken, setNeedToken] = useState(false)

  // 待确认的危险操作
  const [pending, setPending] = useState<null | { kind: 'kill'; row: Session } | { kind: 'terminate' | 'delete'; row: FilterTask }>(null)
  const [expanded, setExpanded] = useState<string>('')

  /** 最大化：Portal 到 body 顶层。
   *  为什么用 Portal 而不是像 page-terminal 那样搬 DOM：本块有大量按钮，
   *  搬走会让 React 的合成事件委托链断掉（事件挂在 root 容器上），按钮全失效。
   *  Portal 仍走 React 树，事件正常。 */
  const [max, setMax] = useState(false)

  /** 最大化时 Esc 退出。用捕获阶段，优先于编辑器。 */
  useEffect(() => {
    if (!max) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMax(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [max])

  /** 放行鼠标拖选文字。
   *  编辑器在 .page-block 上挂了 onMouseDown → setNodeSelection()，
   *  会把块内任意 mousedown 变成"选中整个节点"，导致文字选不中。
   *  在块根节点截断冒泡即可恢复原生文本选择；按钮/输入框自身的事件不受影响。 */
  const stopMouseDown = useCallback((event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }, [])

  /** 只读岛屿的输入闸门。
   *  为了让文字可选，块根节点必须是 contenteditable（Chrome 会把
   *  contenteditable=false 的子树当原子对象，里面的文字无法拖选）。
   *  但块是只读的，所以拦掉一切会改动内容的输入；复制/剪切不受影响
   *  （copy 不走 beforeinput）。嵌套的 input/select/textarea 照常可编辑。 */
  const guardEdit = useCallback((event: { target: unknown; preventDefault: () => void }) => {
    const target = event.target as { closest?: (sel: string) => unknown } | null
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, option')) return
    event.preventDefault()
  }, [])

  useEffect(() => {
    let stop = false
    void (async () => {
      try {
        const res = await fetch('/api/dbbrain-limit/status')
        const json = await res.json()
        if (!stop) setStatus(json)
      } catch (e) {
        if (!stop) setError('自检失败：' + String((e as Error).message || e))
      }
    })()
    return () => {
      stop = true
    }
  }, [])

  /** 只把输入写回块数据——结果不落文档（避免页面被撑大）。 */
  const persist = useCallback(
    (patch: Record<string, unknown>) => {
      update(patch)
    },
    [update],
  )

  const loadSessions = useCallback(async () => {
    if (!instanceId.trim()) {
      setError('请先填实例 ID')
      return
    }
    setBusy('sessions')
    setError('')
    setNotice('')
    setPending(null)
    try {
      const json = await api('/api/dbbrain-limit/sessions', {
        instanceId: instanceId.trim(),
        region: region.trim(),
        user: fUser.trim(),
        db: fDb.trim(),
        state: fState.trim(),
        command: fCommand.trim(),
        time: fTime.trim(),
        info: fInfo.trim(),
        limit: fLimit,
      })
      if (!json.ok) {
        setError(json.error || '查询失败')
        setSessions(null)
      } else {
        setSessions(json.rows)
        setSessAt(json.at)
        if (json.region && json.region !== region) setRegion(json.region)
      }
    } catch (e) {
      setError('查询失败：' + String((e as Error).message || e))
    } finally {
      setBusy('')
    }
  }, [instanceId, region, fUser, fDb, fState, fCommand, fTime, fInfo, fLimit])

  const loadTasks = useCallback(async () => {
    if (!instanceId.trim()) {
      setError('请先填实例 ID')
      return
    }
    setBusy('tasks')
    setError('')
    setNotice('')
    setPending(null)
    try {
      const json = await api('/api/dbbrain-limit/filters/list', {
        instanceId: instanceId.trim(),
        region: region.trim(),
        statuses: taskStatuses,
        limit: 50,
      })
      if (!json.ok) {
        setError(json.error || '查询失败')
        setTasks(null)
      } else {
        setTasks(json.rows)
        setTaskTotal(json.total)
        if (json.region && json.region !== region) setRegion(json.region)
      }
    } catch (e) {
      setError('查询失败：' + String((e as Error).message || e))
    } finally {
      setBusy('')
    }
  }, [instanceId, region, taskStatuses])

  const verifyAccount = useCallback(async () => {
    setBusy('verify')
    setError('')
    setNotice('')
    try {
      const json = await api('/api/dbbrain-limit/verify', {
        instanceId: instanceId.trim(),
        region: region.trim(),
        user: dbUser.trim(),
        password: dbPassword,
      })
      if (!json.ok) {
        setTokenReady(false)
        setError(json.error || '账号验证失败')
        return
      }
      setTokenReady(true)
      setNeedToken(false)
      setNotice(`账号验证通过，会话 token 已就绪（宿主内存缓存，5 分钟）`)
      persist({ authUser: dbUser.trim() })
    } finally {
      setBusy('')
    }
  }, [instanceId, region, dbUser, dbPassword, persist])

  /** 危险操作统一收口。 */
  const runPending = useCallback(async () => {
    if (!pending) return
    const p = pending
    setBusy('act')
    setError('')
    setNotice('')
    try {
      if (p.kind === 'kill') {
        const json = await api('/api/dbbrain-limit/kill', {
          instanceId: instanceId.trim(),
          region: region.trim(),
          threads: [Number(p.row.id)],
        })
        if (!json.ok) {
          setError(`Kill 失败（${json.phase || '?'} 阶段）：${json.error}`)
        } else {
          setNotice(`已 Kill 会话 ${json.killed.join(', ') || p.row.id}`)
          setPending(null)
          await loadSessions()
        }
      } else if (p.kind === 'terminate' || p.kind === 'delete') {
        const path = p.kind === 'terminate' ? '/api/dbbrain-limit/filters/modify' : '/api/dbbrain-limit/filters/delete'
        const json = await api(path, {
          instanceId: instanceId.trim(),
          region: region.trim(),
          user: dbUser.trim(),
          password: dbPassword,
          filterIds: [Number(p.row.id)],
        })
        if (!json.ok) {
          if (json.needToken) setNeedToken(true)
          setError((p.kind === 'terminate' ? '终止失败：' : '删除失败：') + (json.error || ''))
        } else {
          setNotice(p.kind === 'terminate' ? `已终止限流任务 ${p.row.id}` : `已删除限流任务 ${p.row.id}`)
          setPending(null)
          await loadTasks()
        }
      }
    } catch (e) {
      setError('操作失败：' + String((e as Error).message || e))
    } finally {
      setBusy('')
    }
  }, [pending, instanceId, region, dbUser, dbPassword, loadSessions, loadTasks])

  const createFilter = useCallback(async () => {
    if (!cFilterKey.trim()) {
      setError('请填 SQL 关键词')
      return
    }
    setBusy('create')
    setError('')
    setNotice('')
    try {
      const json = await api('/api/dbbrain-limit/filters/create', {
        instanceId: instanceId.trim(),
        region: region.trim(),
        user: dbUser.trim(),
        password: dbPassword,
        sqlType: cSqlType,
        filterKey: cFilterKey.trim(),
        maxConcurrency: Number(cMax) || 0,
        duration: Number(cDuration),
      })
      if (!json.ok) {
        if (json.needToken) setNeedToken(true)
        setError('创建失败：' + (json.error || ''))
        return
      }
      setNotice(`已创建限流任务，FilterId = ${json.filterId}`)
      // 创建成功后清空关键词，避免误重复创建；草稿同步落盘（先取消挂起的防抖，防止旧值回写）。
      setCFilterKey('')
      if (draftTimer.current) clearTimeout(draftTimer.current)
      update({ draft: { sqlType: cSqlType, filterKey: '', maxConcurrency: cMax, duration: cDuration } })
      setTaskStatuses(['RUNNING'])
      await loadTasks()
    } finally {
      setBusy('')
    }
  }, [instanceId, region, dbUser, dbPassword, cSqlType, cFilterKey, cMax, cDuration, loadTasks, update])

  const credOk = status?.hasCredential !== false
  const maxZero = Number(cMax) === 0

  const block = (
    <div
      style={max ? S.wrapMax : S.wrap}
      data-testid="dbbrain-limit-block"
      data-dbbrain-max={max ? '' : undefined}
      onMouseDown={stopMouseDown}
      // 非全屏时：编辑器容器是 contenteditable，其下 contenteditable=false 的子树
      // 会被 Chrome 当原子对象 → 文字选不中。这里把块设为可编辑岛屿换取文本选择权，
      // 再用 onBeforeInput 拦掉真正的改动（块是只读的）。
      // 全屏时块已移出编辑器（Portal 到 body），无需这一手。
      contentEditable={max ? undefined : true}
      suppressContentEditableWarning
      spellCheck={false}
      // 可编辑岛屿会带一个闪烁光标，这里隐掉；选中高亮不受影响。
      onBeforeInput={max ? undefined : guardEdit}
      onDrop={max ? undefined : guardEdit}
    >
      <div style={S.head}>
        <div style={S.title}>
          DBbrain 限流 & 会话
          {status ? (
            <span style={S.chip(true, credOk ? 'rgba(46,158,91,.18)' : 'rgba(217,83,79,.18)')}>
              {credOk ? `凭证 OK · ${status.credential?.secretId || ''}` : '无凭证'}
            </span>
          ) : null}
          {status?.instanceCount ? <span style={S.muted}>DBbrain 托管 {status.instanceCount} 个实例</span> : null}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={S.tab(tab === 'sessions')} onClick={() => { setTab('sessions'); persist({ tab: 'sessions' }) }}>
            当前会话
          </span>
          <span style={S.tab(tab === 'filters')} onClick={() => { setTab('filters'); persist({ tab: 'filters' }) }}>
            SQL 限流
          </span>
          <button
            type="button"
            style={S.btn(true, false, true)}
            title={max ? '退出全屏（Esc）' : '最大化，铺满整个屏幕'}
            onClick={() => setMax(!max)}
          >
            {max ? '退出全屏' : '全屏'}
          </button>
        </div>
      </div>

      {status && !credOk ? <div style={S.err}>{status.error}</div> : null}

      <div style={S.row}>
        <div style={S.field}>
          <span style={S.label}>实例 ID</span>
          <input
            style={{ ...S.input, width: 170 }}
            placeholder="cdb-xxxxxxxx"
            value={instanceId}
            onChange={(e: any) => {
              setInstanceId(e.target.value)
              persist({ instanceId: e.target.value })
            }}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>地域（留空自动解析）</span>
          <input
            style={{ ...S.input, width: 140 }}
            placeholder="ap-guangzhou"
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
            style={{ ...S.input, width: 110 }}
            placeholder="root"
            value={dbUser}
            onChange={(e: any) => setDbUser(e.target.value)}
          />
        </div>
        <div style={S.field}>
          <span style={S.label}>数据库密码（不落盘）</span>
          <input
            style={{ ...S.input, width: 150 }}
            type="password"
            placeholder="限流写操作需要"
            value={dbPassword}
            onChange={(e: any) => setDbPassword(e.target.value)}
          />
        </div>
        <button style={S.btn(!!dbUser && !busy)} disabled={!dbUser || !!busy} onClick={verifyAccount}>
          {busy === 'verify' ? '验证中…' : tokenReady ? '重新验证' : '验证账号'}
        </button>
        {tokenReady ? <span style={{ ...S.muted, color: '#2e9e5b' }}>token 就绪</span> : null}
      </div>

      {needToken ? <div style={S.warn}>限流写操作需要先验证数据库账号（上方填账号密码 → 点「验证账号」）。</div> : null}

      {tab === 'sessions' ? (
        <div>
          <div style={{ ...S.row, marginTop: 12 }}>
            <div style={S.field}>
              <span style={S.label}>User</span>
              <input style={{ ...S.input, width: 88 }} value={fUser} onChange={(e: any) => setFUser(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>DB</span>
              <input style={{ ...S.input, width: 88 }} value={fDb} onChange={(e: any) => setFDb(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>State</span>
              <input style={{ ...S.input, width: 90 }} value={fState} onChange={(e: any) => setFState(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>Command</span>
              <input style={{ ...S.input, width: 90 }} value={fCommand} onChange={(e: any) => setFCommand(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>时长 ≥ (秒)</span>
              <input style={{ ...S.input, width: 78 }} value={fTime} onChange={(e: any) => setFTime(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>SQL 含</span>
              <input style={{ ...S.input, width: 120 }} value={fInfo} onChange={(e: any) => setFInfo(e.target.value)} />
            </div>
            <div style={S.field}>
              <span style={S.label}>Limit</span>
              <input style={{ ...S.input, width: 62 }} value={fLimit} onChange={(e: any) => setFLimit(e.target.value)} />
            </div>
            <button style={S.btn(!busy)} disabled={!!busy} onClick={loadSessions}>
              {busy === 'sessions' ? '查询中…' : '查询会话'}
            </button>
          </div>

          {sessions ? (
            <div style={S.muted}>
              共 {sessions.length} 条 · 查询于 {fmtTime(sessAt)}
              {sessions.length === 0 ? '（该实例此刻没有会话）' : ''}
            </div>
          ) : null}

          {sessions && sessions.length ? (
            <div style={{ ...S.tableWrap, maxHeight: max ? '60vh' : 460 }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>ID</th>
                    <th style={S.th}>User</th>
                    <th style={S.th}>Host</th>
                    <th style={S.th}>DB</th>
                    <th style={S.th}>Command</th>
                    <th style={S.th}>Time</th>
                    <th style={S.th}>State</th>
                    <th style={S.th}>SQL</th>
                    <th style={S.th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...S.td, ...S.mono }}>{r.id}</td>
                      <td style={S.td}>{r.user}</td>
                      <td style={{ ...S.td, ...S.mono }}>{r.host}</td>
                      <td style={S.td}>{r.db}</td>
                      <td style={S.td}>{r.command}</td>
                      <td style={{ ...S.td, ...S.mono }}>{r.time}</td>
                      <td style={S.td}>{r.state}</td>
                      <td style={S.td}>
                        {r.info ? (
                          <span
                            style={max ? { ...S.mono, whiteSpace: 'normal', maxWidth: 900 } : S.sql}
                            title={r.info}
                            onClick={() => setExpanded(expanded === r.id ? '' : r.id)}
                          >
                            {expanded === r.id ? r.info : r.info}
                          </span>
                        ) : (
                          <span style={S.muted}>—</span>
                        )}
                      </td>
                      <td style={S.td}>
                        <button
                          style={S.btn(!!writable && !busy, true, true)}
                          disabled={!writable || !!busy}
                          onClick={() => {
                            setPending({ kind: 'kill', row: r })
                            setNotice('')
                          }}
                        >
                          Kill
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : (
        <div>
          <div style={{ ...S.row, marginTop: 12 }}>
            <span style={{ ...S.label, alignSelf: 'center' }}>状态筛选</span>
            {STATUSES.map((s) => (
              <span
                key={s}
                style={S.chip(taskStatuses.includes(s))}
                onClick={() =>
                  setTaskStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : prev.concat(s)))
                }
              >
                {s}
              </span>
            ))}
            <button style={S.btn(!busy)} disabled={!!busy} onClick={loadTasks}>
              {busy === 'tasks' ? '查询中…' : '查询任务'}
            </button>
          </div>

          {tasks ? (
            <div style={S.muted}>
              共 {taskTotal} 条（本页 {tasks.length} 条）
            </div>
          ) : null}

          {tasks && tasks.length ? (
            <div style={{ ...S.tableWrap, maxHeight: max ? '60vh' : 460 }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Id</th>
                    <th style={S.th}>状态</th>
                    <th style={S.th}>类型</th>
                    <th style={S.th}>并发/上限</th>
                    <th style={S.th}>已拒绝</th>
                    <th style={S.th}>关键词</th>
                    <th style={S.th}>创建</th>
                    <th style={S.th}>过期</th>
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
                      <td style={S.td}>{t.sqlType}</td>
                      <td style={{ ...S.td, ...S.mono }}>
                        {t.currentConcurrency} / {t.maxConcurrency}
                      </td>
                      <td style={{ ...S.td, ...S.mono }}>{t.rejectedSqlCount}</td>
                      <td style={{ ...S.td, ...S.mono }} title={t.originRule}>
                        {t.originKeys}
                      </td>
                      <td style={{ ...S.td, ...S.mono }}>{t.createTime}</td>
                      <td style={{ ...S.td, ...S.mono }}>{t.expireTime}</td>
                      <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                        {t.status === 'RUNNING' ? (
                          <button
                            style={{ ...S.btn(!!writable && !busy, true, true), marginRight: 4 }}
                            disabled={!writable || !!busy}
                            onClick={() => {
                              setPending({ kind: 'terminate', row: t })
                              setNotice('')
                            }}
                          >
                            终止
                          </button>
                        ) : null}
                        <button
                          style={S.btn(!!writable && !busy, false, true)}
                          disabled={!writable || !!busy}
                          onClick={() => {
                            setPending({ kind: 'delete', row: t })
                            setNotice('')
                          }}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div style={S.panel}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>新建限流任务</div>
            <div style={S.row}>
              <div style={S.field}>
                <span style={S.label}>SQL 类型</span>
                <select
                  style={{ ...S.input, width: 100 }}
                  value={cSqlType}
                  onChange={(e: any) => { setCSqlType(e.target.value); patchDraft({ sqlType: e.target.value }) }}
                >
                  {SQL_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div style={S.field}>
                <span style={S.label}>关键词（逗号=与）</span>
                <input
                  style={{ ...S.input, width: 210 }}
                  placeholder="t1,t2"
                  value={cFilterKey}
                  onChange={(e: any) => { setCFilterKey(e.target.value); patchDraft({ filterKey: e.target.value }) }}
                />
              </div>
              <div style={S.field}>
                <span style={S.label}>最大并发</span>
                <input style={{ ...S.input, width: 80 }} value={cMax} onChange={(e: any) => { setCMax(e.target.value); patchDraft({ maxConcurrency: e.target.value }) }} />
              </div>
              <div style={S.field}>
                <span style={S.label}>时长（秒，-1 永久）</span>
                <input
                  style={{ ...S.input, width: 110 }}
                  value={cDuration}
                  onChange={(e: any) => { setCDuration(e.target.value); patchDraft({ duration: e.target.value }) }}
                />
              </div>
              <button style={S.btn(!busy && !!cFilterKey, false)} disabled={!!busy || !cFilterKey} onClick={createFilter}>
                {busy === 'create' ? '创建中…' : '创建限流'}
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              <span style={S.muted}>多个关键词之间是「逻辑与」；逗号不能作为关键词。</span>
            </div>
            {maxZero ? (
              <div style={S.warn}>
                ⚠️ 最大并发填 <b>0</b> 表示<b>限制所有匹配的 SQL 执行</b>（等于全部拒绝），确认这是你要的效果。
              </div>
            ) : null}
            <div style={S.warn}>
              创建会立即对线上 SQL 生效（Duration 到点自动结束）。建议先用较长时间 + 较大并发试探，确认关键词命中范围无误再收紧。
            </div>
          </div>
        </div>
      )}

      {pending ? (
        <div style={S.confirm}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            {pending.kind === 'kill' ? (
              <>
                确认 <b style={{ color: '#d9534f' }}>Kill</b> 会话 <b>{pending.row.id}</b>（user={pending.row.user} db=
                {pending.row.db} time={pending.row.time}s）？
              </>
            ) : pending.kind === 'terminate' ? (
              <>
                确认 <b style={{ color: '#d9534f' }}>终止</b> 限流任务 <b>{pending.row.id}</b>（{pending.row.sqlType}{' '}
                {pending.row.originKeys}）？
              </>
            ) : (
              <>
                确认 <b style={{ color: '#d9534f' }}>删除</b> 限流任务 <b>{pending.row.id}</b>？删除后记录不可恢复。
              </>
            )}
          </div>
          {pending.kind === 'kill' && pending.row.info ? (
            <div
              style={{
                ...S.mono,
                background: 'rgba(127,127,127,.10)',
                borderRadius: 6,
                padding: '6px 8px',
                marginBottom: 8,
                maxHeight: 120,
                overflow: 'auto',
              }}
            >
              {pending.row.info}
            </div>
          ) : null}
          {pending.kind === 'kill' ? (
            <div style={S.muted}>Kill 会中断该会话当前语句，业务侧可能看到连接断开/事务回滚，请确认影响面。</div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={S.btn(!!busy, true)} disabled={!!busy} onClick={runPending}>
              {busy === 'act' ? '执行中…' : '确认执行'}
            </button>
            <button style={S.btn(!busy, false)} disabled={!!busy} onClick={() => setPending(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {notice ? <div style={S.ok}>{notice}</div> : null}
      {error ? <div style={S.err}>{error}</div> : null}

      {!sessions && !tasks && !error ? (
        <div style={{ ...S.muted, marginTop: 10 }}>
          填实例 ID → 选「当前会话」查活跃会话并逐个 Kill，或选「SQL 限流」查/建/终止/删除限流任务。
          <br />
          地域留空会自动按实例 ID 解析；限流写操作需要先验证数据库账号。
        </div>
      ) : null}
    </div>
  )

  // 非最大化：就地渲染。
  if (!max) return block

  // 最大化：挂到 body 顶层。编辑器的 .page-block 带 overflow:hidden + isolation:isolate，
  // 就地做 fixed 会被裁掉/压不住；只有脱离该容器才能真正铺满。
  return createPortal(block, document.body)
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
    kind: 'dbbrain-limit',
    plugin: name,
    label: 'DBbrain 限流 & 会话',
    blockType: 'basic',
    blockTypeLabel: '基础',
    hint: '查活跃会话并 Kill，管理 SQL 限流（建/终止/删）',
    aliases: ['dbbrain', 'limit', '限流', '会话', 'processlist', 'kill', 'cdb'],
    // 本块不引用任何资产文件，显式声明空数组，避免宿主告警与误 GC
    assets: [],
    defaults: () => ({
      tab: 'sessions',
      instanceId: '',
      region: '',
      authUser: 'root',
    }),
    View: DbbrainLimitBlock,
  })
}
