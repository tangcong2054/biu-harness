const React = globalThis.React
const { useState, useEffect, useMemo, useRef, useCallback } = React

export const name = 'app-store-view'
export const inject = ['databaseUi', 'uiActions']

type FsViewProps = {
  path: string
  rows: Array<Record<string, unknown> & { id: string }>
  schema?: { fields?: Record<string, { label?: string }>; contentField?: string }
  onOpen: (row: Record<string, unknown>) => void
}

type UiActionsApi = { register: (spec: Record<string, unknown>) => () => void }
let uiActions: UiActionsApi | undefined

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'installed', label: '已安装' },
  { id: 'update', label: '可更新' },
  { id: 'window', label: '应用窗口' },
  { id: 'headless', label: '无头插件' },
  { id: 'fresh', label: '未安装' },
]

const PALETTE = [
  ['#6c8cff', '#8f6cff'],
  ['#3ec7a5', '#4aa8ff'],
  ['#ff9f6c', '#ff6c9a'],
  ['#ffd166', '#ff8f4a'],
  ['#8f7bff', '#5ec8ff'],
  ['#4ad0c3', '#7be06f'],
  ['#ff7b8f', '#ffb26c'],
  ['#7f9dff', '#b18fff'],
]

function str(value: unknown) {
  return value == null ? '' : String(value)
}

function asBool(value: unknown) {
  return value === true
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : []
}

function hash(text: string) {
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 100000
  return h
}

function paletteOf(id: string): string[] {
  return PALETTE[hash(id) % PALETTE.length]!
}

function glyphOf(row: Record<string, unknown>) {
  const title = (str(row.title) || str(row.id)).trim()
  return title ? Array.from(title)[0]! : '·'
}

function humanBytes(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function shapeOf(row: Record<string, unknown>) {
  const headless = asBool(row.headless)
  const hasWeb = asBool(row.hasWeb)
  const hasHost = asBool(row.hasHost)
  if (headless && hasWeb && hasHost) return '无头 · 前后端'
  if (headless && hasWeb) return '无头 · 页面块'
  if (headless && hasHost) return '无头 · 服务端'
  if (hasWeb) return '应用窗口'
  return '插件'
}

function stateOf(row: Record<string, unknown>) {
  if (asBool(row.idConflict)) return { key: 'conflict', label: 'ID 冲突', tone: '#e05252' }
  if (asBool(row.updateAvailable)) return { key: 'update', label: '可更新', tone: '#e08b2f' }
  if (asBool(row.installed)) return { key: 'installed', label: '已安装', tone: '#38a169' }
  if (str(row.reviewStatus) === 'pending') return { key: 'pending', label: '待审核', tone: '#8a7fe0' }
  return { key: 'fresh', label: '未安装', tone: '#7b8794' }
}

function matchesCategory(row: Record<string, unknown>, category: string) {
  if (category === 'installed') return asBool(row.installed)
  if (category === 'update') return asBool(row.updateAvailable)
  if (category === 'fresh') return !asBool(row.installed)
  if (category === 'window') return asBool(row.hasWeb) && !asBool(row.headless)
  if (category === 'headless') return asBool(row.headless)
  return true
}

function matchesQuery(row: Record<string, unknown>, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = [str(row.id), str(row.title), str(row.name), str(row.blurb), str(row.author), list(row.tags).join(' ')]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

async function postAction(path: string, action: string) {
  const res = await fetch('/api/db/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, action }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  window.dispatchEvent(new Event('fsdb:change'))
}

async function fetchReadme(id: string) {
  const res = await fetch(`/api/db/content?path=${encodeURIComponent(`/plugin-catalog/${id}`)}`)
  const body = (await res.json().catch(() => ({}))) as { value?: unknown; error?: string }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return typeof body.value === 'string' ? body.value : ''
}

const S = {
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--dsw-bg, #fff)',
    color: 'var(--dsw-label, #111)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    padding: '18px 22px 12px',
    borderBottom: '1px solid var(--dsw-border, #e5e5e5)',
    flexShrink: 0,
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 12 },
  brandTile: {
    width: 40,
    height: 40,
    borderRadius: 11,
    display: 'grid',
    placeItems: 'center',
    fontSize: 19,
    fontWeight: 700,
    color: '#fff',
    background: 'linear-gradient(140deg, #6c8cff, #b06cff)',
    boxShadow: '0 4px 12px rgba(108,140,255,0.35)',
  },
  h1: { margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: 0.2 },
  sub: { margin: '3px 0 0', fontSize: 12.5, color: 'var(--dsw-label-3, #777)' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  search: {
    width: 260,
    padding: '8px 30px 8px 30px',
    borderRadius: 999,
    border: '1px solid var(--dsw-border, #e5e5e5)',
    background: 'var(--dsw-muted-fill, rgba(0,0,0,0.03))',
    color: 'inherit',
    fontSize: 13,
    outline: 'none',
  },
  searchIcon: { position: 'absolute', left: 10, fontSize: 12, color: 'var(--dsw-label-3, #999)', pointerEvents: 'none' },
  searchClear: {
    position: 'absolute',
    right: 6,
    width: 20,
    height: 20,
    border: 0,
    borderRadius: 999,
    background: 'transparent',
    color: 'var(--dsw-label-3, #999)',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
  },
  tabs: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 22px 0', flexShrink: 0, flexWrap: 'wrap' },
  tabHint: { fontSize: 11.5, color: 'var(--dsw-label-3, #999)', letterSpacing: 0.4 },
  tagRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px 12px', flexShrink: 0, flexWrap: 'wrap', minHeight: 18 },
  body: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' },
  scroller: { flex: 1, minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 22px 28px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(272px, 1fr))',
    gap: 14,
    alignContent: 'start',
    paddingTop: 8,
  },
  cardTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 650,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  author: { fontSize: 12, color: 'var(--dsw-label-3, #888)' },
  blurb: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.55,
    color: 'var(--dsw-label-2, #555)',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    minHeight: 39,
  },
  cardFoot: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 'auto',
    fontSize: 11,
    color: 'var(--dsw-label-3, #888)',
    flexWrap: 'wrap',
  },
  chip: {
    padding: '2px 7px',
    borderRadius: 5,
    border: '1px solid var(--dsw-border, #e5e5e5)',
    background: 'var(--dsw-muted-fill, rgba(0,0,0,0.03))',
    fontSize: 10.5,
    color: 'var(--dsw-label-2, #666)',
    whiteSpace: 'nowrap',
  },
  empty: { padding: '64px 0', textAlign: 'center', color: 'var(--dsw-label-3, #999)', fontSize: 13 },
  drawer: {
    width: 380,
    maxWidth: '46%',
    flexShrink: 0,
    borderLeft: '1px solid var(--dsw-border, #e5e5e5)',
    background: 'var(--dsw-surface, var(--dsw-bg, #fff))',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.06)',
  },
  drawerHead: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '18px 18px 14px',
    borderBottom: '1px solid var(--dsw-border, #e5e5e5)',
    flexShrink: 0,
  },
  drawerClose: {
    marginLeft: 'auto',
    width: 26,
    height: 26,
    border: '1px solid var(--dsw-border, #e5e5e5)',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--dsw-label-2, #666)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
  },
  drawerBody: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '14px 18px 24px' },
  btnRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
  ghostBtn: {
    padding: '7px 14px',
    borderRadius: 8,
    border: '1px solid var(--dsw-border, #e5e5e5)',
    background: 'transparent',
    color: 'var(--dsw-label-2, #555)',
    fontSize: 13,
    cursor: 'pointer',
  },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', marginTop: 16, fontSize: 12 },
  metaKey: { color: 'var(--dsw-label-3, #999)' },
  metaVal: { color: 'var(--dsw-label, #111)', wordBreak: 'break-word' },
  sectionTitle: {
    margin: '18px 0 8px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.6,
    color: 'var(--dsw-label-3, #999)',
    textTransform: 'uppercase',
  },
  readme: {
    margin: 0,
    padding: 12,
    borderRadius: 10,
    border: '1px solid var(--dsw-border, #e5e5e5)',
    background: 'var(--dsw-muted-fill, rgba(0,0,0,0.03))',
    fontSize: 12,
    lineHeight: 1.65,
    color: 'var(--dsw-label-2, #555)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: 260,
    overflowY: 'auto',
    fontFamily: 'inherit',
  },
  toast: {
    position: 'absolute',
    left: '50%',
    bottom: 20,
    transform: 'translateX(-50%)',
    padding: '8px 16px',
    borderRadius: 999,
    background: 'rgba(20,20,24,0.88)',
    color: '#fff',
    fontSize: 12.5,
    boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
    pointerEvents: 'none',
    zIndex: 5,
  },
} as Record<string, Record<string, unknown>>

function tabStyle(on: boolean) {
  return {
    padding: '5px 12px',
    borderRadius: 999,
    border: '1px solid ' + (on ? 'transparent' : 'var(--dsw-border, #e5e5e5)'),
    background: on ? 'var(--dsw-business, #3b6cff)' : 'transparent',
    color: on ? '#fff' : 'var(--dsw-label-2, #555)',
    fontSize: 12.5,
    cursor: 'pointer',
    fontWeight: on ? 600 : 400,
  }
}

function tagStyle(on: boolean) {
  return {
    padding: '3px 9px',
    borderRadius: 6,
    border: '1px solid ' + (on ? 'var(--dsw-business, #3b6cff)' : 'var(--dsw-border, #e5e5e5)'),
    background: on ? 'var(--dsw-business-soft, rgba(59,108,255,0.12))' : 'transparent',
    color: on ? 'var(--dsw-business, #3b6cff)' : 'var(--dsw-label-3, #777)',
    fontSize: 11.5,
    cursor: 'pointer',
  }
}

function cardStyle(active: boolean, hover: boolean) {
  return {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    paddingTop: 30,
    borderRadius: 14,
    border: '1px solid ' + (active ? 'var(--dsw-business, #3b6cff)' : 'var(--dsw-border, #e5e5e5)'),
    background: 'var(--dsw-surface, var(--dsw-bg, #fff))',
    boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.04)',
    transform: hover ? 'translateY(-1px)' : 'none',
    transition: 'box-shadow .15s ease, transform .15s ease, border-color .15s ease',
    cursor: 'pointer',
    textAlign: 'left',
    color: 'inherit',
    minHeight: 176,
  }
}

function pillStyle(tone: string) {
  return {
    position: 'absolute',
    top: 11,
    right: 12,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
    background: tone,
    letterSpacing: 0.2,
  }
}

function iconStyle(id: string, size: number) {
  const pair = paletteOf(id)
  return {
    width: size,
    height: size,
    borderRadius: size * 0.28,
    display: 'grid',
    placeItems: 'center',
    fontSize: size * 0.42,
    fontWeight: 700,
    color: '#fff',
    background: `linear-gradient(140deg, ${pair[0]}, ${pair[1]})`,
    boxShadow: '0 3px 10px rgba(0,0,0,0.16)',
    flexShrink: 0,
    userSelect: 'none',
  }
}

function primaryStyle(disabled: boolean) {
  return {
    padding: '7px 16px',
    borderRadius: 8,
    border: 0,
    background: disabled ? 'var(--dsw-muted-fill, rgba(0,0,0,0.06))' : 'var(--dsw-business, #3b6cff)',
    color: disabled ? 'var(--dsw-label-3, #999)' : '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
  }
}

export function StoreView({ rows, onOpen }: FsViewProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [tag, setTag] = useState('')
  const [openId, setOpenId] = useState('')
  const [hoverId, setHoverId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [toast, setToast] = useState('')
  const [readme, setReadme] = useState({ id: '', text: '', loading: false, error: '' })
  const toastTimer = useRef(0)

  const notify = useCallback((text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  const tags = useMemo(() => {
    const counter = new Map<string, number>()
    for (const row of rows) {
      for (const item of list(row.tags)) counter.set(item, (counter.get(item) ?? 0) + 1)
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 14)
      .map((entry) => ({ key: entry[0], count: entry[1] }))
  }, [rows])

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: rows.length }
    for (const item of CATEGORIES) {
      if (item.id === 'all') continue
      out[item.id] = rows.filter((row) => matchesCategory(row, item.id)).length
    }
    return out
  }, [rows])

  const visible = useMemo(() => {
    return rows
      .filter((row) => matchesCategory(row, category))
      .filter((row) => (tag ? list(row.tags).includes(tag) : true))
      .filter((row) => matchesQuery(row, query))
  }, [rows, category, tag, query])

  const opened = useMemo(() => rows.find((row) => str(row.id) === openId), [rows, openId])

  useEffect(() => {
    if (!openId) return
    let alive = true
    setReadme({ id: openId, text: '', loading: true, error: '' })
    fetchReadme(openId)
      .then((text) => {
        if (alive) setReadme({ id: openId, text, loading: false, error: '' })
      })
      .catch((error: unknown) => {
        if (alive) setReadme({ id: openId, text: '', loading: false, error: String(error) })
      })
    return () => {
      alive = false
    }
  }, [openId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openId) setOpenId('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const runAction = useCallback(
    async (row: Record<string, unknown>, action: string) => {
      const id = str(row.id)
      if (!id || busyId) return 'busy'
      setBusyId(id)
      try {
        await postAction(`/plugin-catalog/${id}`, action)
        const done = action === 'install' ? '已安装' : action === 'update' ? '已更新' : '已卸载'
        notify(`${str(row.title) || id} ${done}`)
        return `${id}:${action}:ok`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(`操作失败：${message}`)
        return `${id}:${action}:${message}`
      } finally {
        setBusyId('')
      }
    },
    [busyId, notify],
  )

  const stateRef = useRef({ query, category, tag, openId, visible: visible.map((row) => str(row.id)) })
  stateRef.current = { query, category, tag, openId, visible: visible.map((row) => str(row.id)) }
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  useEffect(() => {
    if (!uiActions) return
    return uiActions.register({
      plugin: name,
      instanceId: 'app-store-view',
      kind: 'app-store',
      label: '插件商店视图',
      surface: 'main',
      state: () => ({
        query: stateRef.current.query,
        category: stateRef.current.category,
        tag: stateRef.current.tag,
        open: stateRef.current.openId,
        total: rowsRef.current.length,
        shown: stateRef.current.visible.length,
        shownIds: stateRef.current.visible.slice(0, 30),
      }),
      actions: {
        set_search: {
          description: '设置商店搜索词（空串清空），返回命中的插件 id',
          risk: 'write',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 120 } },
            required: ['query'],
            additionalProperties: false,
          },
          run: (input: Record<string, unknown>) => {
            const next = str(input && input.query)
            setQuery(next)
            return {
              query: next,
              hits: rowsRef.current.filter((row) => matchesQuery(row, next)).map((row) => str(row.id)),
            }
          },
        },
        set_category: {
          description: '切换分类标签：all / installed / update / window / headless / fresh',
          risk: 'write',
          inputSchema: {
            type: 'object',
            properties: { category: { type: 'string', enum: CATEGORIES.map((item) => item.id) } },
            required: ['category'],
            additionalProperties: false,
          },
          run: (input: Record<string, unknown>) => {
            const wanted = str(input && input.category)
            const next = CATEGORIES.some((item) => item.id === wanted) ? wanted : 'all'
            setCategory(next)
            return { category: next, count: rowsRef.current.filter((row) => matchesCategory(row, next)).length }
          },
        },
        set_tag: {
          description: '按标签过滤（空串清空），标签来自插件 tags',
          risk: 'write',
          inputSchema: {
            type: 'object',
            properties: { tag: { type: 'string', maxLength: 60 } },
            required: ['tag'],
            additionalProperties: false,
          },
          run: (input: Record<string, unknown>) => {
            const next = str(input && input.tag)
            setTag(next)
            return { tag: next }
          },
        },
        open_app: {
          description: '打开某个插件的详情抽屉（右侧），空串关闭',
          risk: 'navigate',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', maxLength: 120 } },
            required: ['id'],
            additionalProperties: false,
          },
          run: (input: Record<string, unknown>) => {
            const next = str(input && input.id).trim()
            const hit = rowsRef.current.find((row) => str(row.id) === next)
            if (next && !hit) throw new Error(`没有这个插件：${next}`)
            setOpenId(next)
            return { open: next, title: hit ? str(hit.title) : '' }
          },
        },
        install_app: {
          description: '对商店里的某个插件执行 install / update / uninstall，真调 /api/db/action',
          risk: 'submit',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 120 },
              action: { type: 'string', enum: ['install', 'update', 'uninstall'] },
            },
            required: ['id', 'action'],
            additionalProperties: false,
          },
          run: async (input: Record<string, unknown>) => {
            const next = str(input && input.id).trim()
            const wanted = str(input && input.action)
            const act = wanted === 'update' || wanted === 'uninstall' ? wanted : 'install'
            const hit = rowsRef.current.find((row) => str(row.id) === next)
            if (!hit) throw new Error(`没有这个插件：${next}`)
            return runAction(hit, act)
          },
        },
        list_apps: {
          description: '列出商店里的插件（可选按分类/关键词收窄），返回 id、标题、状态、形态、大小',
          risk: 'read',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: CATEGORIES.map((item) => item.id) },
              query: { type: 'string', maxLength: 120 },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
            },
            additionalProperties: false,
          },
          run: (input: Record<string, unknown>) => {
            const wanted = str(input && input.category)
            const categoryId = CATEGORIES.some((item) => item.id === wanted) ? wanted : 'all'
            const limit = Math.min(200, Math.max(1, Number(input && input.limit) || 50))
            return rowsRef.current
              .filter((row) => matchesCategory(row, categoryId))
              .filter((row) => matchesQuery(row, str(input && input.query)))
              .slice(0, limit)
              .map((row) => ({
                id: str(row.id),
                title: str(row.title),
                author: str(row.author),
                state: stateOf(row).label,
                shape: shapeOf(row),
                bytes: Number(row.bytes) || 0,
              }))
          },
        },
      },
    })
  }, [runAction])

  return (
    <div style={S.root} data-testid="app-store-view">
      <div style={S.header}>
        <div style={S.brandRow}>
          <div style={S.brandTile} aria-hidden>
            ⌘
          </div>
          <div>
            <h1 style={S.h1}>插件商店</h1>
            <p style={S.sub}>
              共 {rows.length} 个应用 · 已安装 {counts.installed ?? 0} · 可更新 {counts.update ?? 0}
            </p>
          </div>
        </div>
        <div style={S.searchWrap}>
          <span style={S.searchIcon} aria-hidden>
            ⌕
          </span>
          <input
            style={S.search}
            value={query}
            placeholder="搜索插件、作者或标签"
            aria-label="搜索插件"
            onChange={(event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value)}
          />
          {query ? (
            <button type="button" style={S.searchClear} aria-label="清空搜索" onClick={() => setQuery('')}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <div style={S.tabs} role="tablist" aria-label="分类">
        {CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            style={tabStyle(category === item.id)}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
            <span style={{ opacity: 0.7, marginLeft: 5 }}>{counts[item.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div style={S.tagRow}>
        <span style={S.tabHint}>标签</span>
        {tags.length ? (
          tags.map((item) => (
            <button key={item.key} type="button" style={tagStyle(tag === item.key)} onClick={() => setTag(tag === item.key ? '' : item.key)}>
              {item.key} <span style={{ opacity: 0.6 }}>{item.count}</span>
            </button>
          ))
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--dsw-label-3, #999)' }}>暂无标签</span>
        )}
        {tag ? (
          <button type="button" style={tagStyle(false)} onClick={() => setTag('')}>
            清除筛选
          </button>
        ) : null}
      </div>

      <div style={S.body}>
        <div style={S.scroller}>
          {visible.length ? (
            <div style={S.grid}>
              {visible.map((row) => {
                const id = str(row.id)
                const state = stateOf(row)
                const active = openId === id
                const busy = busyId === id
                return (
                  <div
                    key={id}
                    role="button"
                    tabIndex={0}
                    style={cardStyle(active, hoverId === id)}
                    onClick={() => setOpenId(active ? '' : id)}
                    onKeyDown={(event: { key: string }) => {
                      if (event.key === 'Enter' || event.key === ' ') setOpenId(active ? '' : id)
                    }}
                    onMouseEnter={() => setHoverId(id)}
                    onMouseLeave={() => setHoverId('')}
                    aria-label={str(row.title) || id}
                  >
                    <span style={pillStyle(state.tone)}>{state.label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <div style={iconStyle(id, 42)} aria-hidden>
                        {glyphOf(row)}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={S.cardTitle} title={str(row.title) || id}>
                          {str(row.title) || id}
                        </p>
                        <div style={S.author}>{str(row.author) || '未署名'}</div>
                      </div>
                    </div>
                    <p style={S.blurb}>{str(row.blurb) || '这个插件还没有写简介。'}</p>
                    <div style={S.cardFoot}>
                      <span style={S.chip}>{shapeOf(row)}</span>
                      <span>{humanBytes(row.bytes)}</span>
                      {list(row.tags).slice(0, 1).map((item) => (
                        <span key={item} style={S.chip}>
                          {item}
                        </span>
                      ))}
                      {busy ? <span style={{ color: 'var(--dsw-business, #3b6cff)' }}>处理中…</span> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p style={S.empty}>
              {query || tag || category !== 'all' ? '没有匹配的插件，试试换个关键词或清除筛选。' : '商店里还没有插件。'}
            </p>
          )}
        </div>

        {opened ? (
          <aside style={S.drawer} aria-label="插件详情">
            <div style={S.drawerHead}>
              <div style={iconStyle(str(opened.id), 52)} aria-hidden>
                {glyphOf(opened)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ ...S.cardTitle, whiteSpace: 'normal', fontSize: 16 }}>{str(opened.title) || str(opened.id)}</p>
                <div style={S.author}>
                  {str(opened.author) || '未署名'} · {str(opened.id)}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <span style={S.chip}>{shapeOf(opened)}</span>
                  <span style={S.chip}>{humanBytes(opened.bytes)}</span>
                  <span style={{ ...S.chip, color: '#fff', background: stateOf(opened).tone, border: 0 }}>
                    {stateOf(opened).label}
                  </span>
                </div>
              </div>
              <button type="button" style={S.drawerClose} aria-label="关闭详情" onClick={() => setOpenId('')}>
                ✕
              </button>
            </div>

            <div style={S.drawerBody}>
              <div style={S.btnRow}>
                {!asBool(opened.installed) && !asBool(opened.idConflict) ? (
                  <button
                    type="button"
                    style={primaryStyle(Boolean(busyId))}
                    disabled={Boolean(busyId)}
                    onClick={() => void runAction(opened, 'install')}
                  >
                    {busyId === str(opened.id) ? '安装中…' : '安装'}
                  </button>
                ) : null}
                {asBool(opened.updateAvailable) ? (
                  <button
                    type="button"
                    style={primaryStyle(Boolean(busyId))}
                    disabled={Boolean(busyId)}
                    onClick={() => void runAction(opened, 'update')}
                  >
                    {busyId === str(opened.id) ? '更新中…' : '更新'}
                  </button>
                ) : null}
                {asBool(opened.installed) ? (
                  <button type="button" style={S.ghostBtn} disabled={Boolean(busyId)} onClick={() => void runAction(opened, 'uninstall')}>
                    卸载
                  </button>
                ) : null}
                <button type="button" style={S.ghostBtn} onClick={() => onOpen(opened)}>
                  打开记录
                </button>
              </div>

              <p style={{ ...S.blurb, WebkitLineClamp: 99, marginTop: 14, fontSize: 13 }}>
                {str(opened.blurb) || '这个插件还没有写简介。'}
              </p>

              <div style={S.metaGrid}>
                <span style={S.metaKey}>商店版本</span>
                <span style={S.metaVal}>{str(opened.remoteCodeVersion) || '—'}</span>
                <span style={S.metaKey}>本地版本</span>
                <span style={S.metaVal}>{str(opened.localCodeVersion) || '—'}</span>
                <span style={S.metaKey}>审核状态</span>
                <span style={S.metaVal}>{str(opened.reviewStatus) || '—'}</span>
                <span style={S.metaKey}>检测状态</span>
                <span style={S.metaVal}>{str(opened.scanStatus) || '—'}</span>
                <span style={S.metaKey}>宿主能力</span>
                <span style={S.metaVal}>
                  {asBool(opened.hasHost) ? 'Host' : '—'} / {asBool(opened.hasWeb) ? 'Web' : '—'}
                  {asBool(opened.headless) ? ' · 无头' : ''}
                </span>
                <span style={S.metaKey}>商店</span>
                <span style={S.metaVal}>{str(opened.registryId) || '—'}</span>
              </div>

              <div style={S.sectionTitle}>介绍</div>
              {readme.loading ? (
                <p style={{ fontSize: 12.5, color: 'var(--dsw-label-3, #999)' }}>读取中…</p>
              ) : readme.error ? (
                <p style={{ fontSize: 12.5, color: 'var(--dsw-danger, #d33)' }}>{readme.error}</p>
              ) : readme.text ? (
                <pre style={S.readme}>{readme.text}</pre>
              ) : (
                <p style={{ fontSize: 12.5, color: 'var(--dsw-label-3, #999)' }}>这个插件没有介绍正文。</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      {toast ? (
        <div style={S.toast} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

export function apply(ctx: any) {
  uiActions = ctx.get('uiActions') as UiActionsApi | undefined
  if (typeof ctx.inject === 'function') {
    ctx.inject(['uiActions'], (inner: any) => {
      uiActions = inner.get('uiActions') as UiActionsApi | undefined
    })
  }
  const ui = ctx.get('databaseUi')
  if (!ui) return
  ctx.effect(() =>
    ui
      .registerView('/plugin-catalog', {
        id: 'app-store',
        label: '商店',
        plugin: name,
        View: StoreView,
      })
      .dispose,
  )
}
