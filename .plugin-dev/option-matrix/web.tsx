import { createPortal } from 'react-dom'

const React = globalThis.React
const { useState, useMemo, useEffect, useRef } = React

export const name = 'option-matrix'
export const inject = ['pageEditor']

type Criterion = { name: string; weight: number; higherIsBetter: boolean }
type Scores = Record<string, Record<string, number>>
type ViewMode = 'matrix' | 'cards' | 'rank'
type Density = 'comfortable' | 'compact'
type Data = {
  title?: string
  scale?: number
  options?: string[]
  criteria?: Criterion[]
  scores?: Scores
  /** 呈现方式：matrix 矩阵 / cards 卡片 / rank 排名。不填按规模自动挑。 */
  view?: ViewMode
  /** 疏密：comfortable 舒适 / compact 紧凑。 */
  density?: Density
  /** 只显示权重不低于平均值的维度。 */
  foldMinor?: boolean
}

type Cell = { name: string; raw: number; norm: number; weighted: number }

const SCALE = 5
const BEST_BG = 'rgba(255,196,0,.22)'
const WIN_BG = 'rgba(46,160,120,.10)'
const WIN_SOFT = 'rgba(46,160,120,.09)'
const WIN_LINE = 'rgba(46,160,120,.5)'
const LINE = 'var(--dsw-border)'
const FAINT = 'rgba(127,127,127,.16)'
const FILL = 'rgba(127,127,127,.45)'
const SURFACE = 'var(--dsw-bg)'

const STYLE_CSS = `
.om-root{color:var(--dsw-label);border-color:var(--dsw-border)}
`
function useOmStyle() {
  useEffect(() => {
    const id = 'option-matrix-style-v3'
    const existing = document.getElementById(id)
    const el = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
    el.id = id
    el.textContent = STYLE_CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: 'matrix', label: '矩阵' },
  { id: 'cards', label: '卡片' },
  { id: 'rank', label: '排名' },
]

const DEFAULTS: Data = {
  title: '登录方案选型',
  scale: SCALE,
  options: ['手机号+验证码', '微信一键登录', '账号密码'],
  criteria: [
    { name: '开发成本', weight: 3, higherIsBetter: false },
    { name: '安全性', weight: 5, higherIsBetter: true },
    { name: '转化率', weight: 5, higherIsBetter: true },
  ],
  scores: {
    '手机号+验证码': { 开发成本: 4, 安全性: 4, 转化率: 4 },
    '微信一键登录': { 开发成本: 3, 安全性: 4, 转化率: 5 },
    '账号密码': { 开发成本: 5, 安全性: 2, 转化率: 2 },
  },
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function normScore(raw: number, higherIsBetter: boolean, scale: number): number {
  const v = Math.max(0, Math.min(scale, raw))
  // 关键：越低越好的维度反向计入 —— 高分代表成本高，这里换成 (scale+1-v)
  return higherIsBetter ? v : scale + 1 - v
}

/** 「为什么推荐它」：只讲结论，不把 8 个维度重复念一遍。
    全都赢 → 一句话；只赢一部分 → 报「拿下 M/N」+ 没拿下的维度归了谁。
    折叠低权重维度时只讲还在台上的那些。 */
function rationaleFor(criteria: Criterion[], rows: Row[], winner: Row, maxTotal: number): string {
  const head = `推荐「${winner.option}」：加权总分 ${winner.total.toFixed(1)} / 满分 ${maxTotal.toFixed(1)}（${(winner.percent * 100).toFixed(1)}%）。`
  if (!criteria.length) return head
  const bestNamesOf = (c: Criterion) => {
    const bestNorm = Math.max(...rows.map((r) => (r.cells.find((x) => x.name === c.name)?.norm ?? -Infinity)), -Infinity)
    return rows.filter((r) => (r.cells.find((x) => x.name === c.name)?.norm ?? -Infinity) === bestNorm).map((r) => r.option)
  }
  const mine: string[] = []
  const others: string[] = []
  criteria.forEach((c) => {
    const names = bestNamesOf(c)
    if (names.indexOf(winner.option) >= 0) mine.push(c.name)
    else others.push(`「${c.name}」${c.higherIsBetter === false ? '（越低越好）' : ''} → ${names.join(' / ')}`)
  })
  if (!others.length) return `${head}${criteria.length} 个维度全部最优。`
  const mineText = mine.length ? `拿下 ${mine.length}/${criteria.length} 个维度${mine.length <= 3 ? `（${mine.join('、')}）` : ''}；` : ''
  const shown = others.slice(0, 3).join('；')
  const rest = others.length > 3 ? `；另有 ${others.length - 3} 个维度未拿最优` : ''
  return `${head}${mineText}其余：${shown}${rest}。`
}

type Row = { option: string; cells: (Cell & { best: boolean })[]; total: number; percent: number; rank: number }

function compute(data: Data) {
  const scale = Math.max(1, num(data.scale, SCALE))
  const options = data.options ?? []
  const criteria = data.criteria ?? []
  const scores = data.scores ?? {}
  const maxTotal = criteria.reduce((a, c) => a + Math.max(0, num(c.weight, 0)) * scale, 0)

  const rawRows: Row[] = options.map((option) => {
    const cells = criteria.map((c) => {
      const raw = Math.max(0, Math.min(scale, num(scores[option]?.[c.name], 0)))
      const higherIsBetter = c.higherIsBetter !== false
      const norm = normScore(raw, higherIsBetter, scale)
      const weighted = num(c.weight, 0) * norm
      return { name: c.name, raw, norm, weighted, best: false }
    })
    const total = cells.reduce((a, x) => a + x.weighted, 0)
    return { option, cells, total, percent: maxTotal ? total / maxTotal : 0, rank: 0 }
  })

  // 每个维度的最优格高亮（越高越好取最大，越低越好取最小 → 归一化后都是最大）
  criteria.forEach((_, ci) => {
    const bestNorm = Math.max(...rawRows.map((r) => (r.cells[ci] ? r.cells[ci].norm : -Infinity)), -Infinity)
    rawRows.forEach((r) => {
      if (r.cells[ci] && bestNorm > -Infinity && r.cells[ci].norm === bestNorm) r.cells[ci].best = true
    })
  })

  const ranked = [...rawRows].sort((a, b) => b.total - a.total || a.option.localeCompare(b.option))
  ranked.forEach((r, i) => {
    r.rank = i + 1
  })

  const winner = ranked[0] ?? null
  const rationale = winner ? rationaleFor(criteria, rawRows, winner, maxTotal) : ''

  return { scale, options, criteria, rows: rawRows, ranked, maxTotal, winner, rationale }
}

function toMarkdown(data: Data): string {
  const { scale, criteria, ranked } = compute(data)
  const arrow = (c: Criterion) => (c.higherIsBetter === false ? '↓越低越好' : '↑越高越好')
  const head = ['方案', ...criteria.map((c) => `${c.name} (权重${c.weight}, ${arrow(c)})`), '加权总分', '推荐']
  const sep = head.map(() => '---')
  const lines = [
    `### ${data.title || '方案对比'}（满分 ${criteria.reduce((a, c) => a + num(c.weight, 0) * scale, 0).toFixed(1)}）`,
    '',
    `| ${head.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
  ]
  ranked.forEach((r) => {
    const cells = criteria.map((c) => {
      const cell = r.cells.find((x) => x.name === c.name)
      return cell ? (c.higherIsBetter === false ? `${cell.raw}（反向${cell.norm}）` : String(cell.raw)) : ''
    })
    lines.push(`| ${r.option} | ${cells.join(' | ')} | ${r.total.toFixed(1)} | ${r.rank === 1 ? '推荐' : `#${r.rank}`} |`)
  })
  lines.push('')
  lines.push('> 算法：总分 = Σ(权重 × 归一化分)；越低越好的维度归一化分 = scale+1 − 原分。')
  return lines.join('\n')
}

/** 维度多、方案多的时候一张大表会挤成一团：默认换成卡片，把每个方案拆成一张卡。 */
function autoView(optionCount: number, criterionCount: number): ViewMode {
  return criterionCount >= 6 || optionCount * criterionCount >= 16 ? 'cards' : 'matrix'
}

function readView(data: Data, optionCount: number, criterionCount: number): ViewMode {
  const v = data.view
  if (v === 'matrix' || v === 'cards' || v === 'rank') return v
  return autoView(optionCount, criterionCount)
}

/** 放大：把同一棵子树 portal 到 body 顶层的 fixed 覆盖层 —— 不搬 DOM，React 合成事件照常触发，
    所以放大后照样能切视图、改分数。顺带尽力申请浏览器全屏；Esc 或「缩小」退出。 */
function useMaximize() {
  const [max, setMax] = useState(false)
  const layerRef = useRef<HTMLDivElement | null>(null)

  const close = () => {
    const el = layerRef.current
    layerRef.current = null
    if (el && el.parentNode) el.parentNode.removeChild(el)
    setMax(false)
    if (document.fullscreenElement) void document.exitFullscreen?.()
  }

  const open = () => {
    if (layerRef.current) return
    const el = document.createElement('div')
    el.setAttribute('data-option-matrix-zoom', '')
    el.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'max-width:none',
      'max-height:none',
      'margin:0',
      'padding:0',
      'box-sizing:border-box',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      `background:${SURFACE}`,
      'z-index:2147483000',
    ].join(';')
    document.body.appendChild(el)
    layerRef.current = el
    setMax(true)
    // 浏览器全屏只是加成：拿不到（非用户手势 / 权限）也照样有覆盖层。
    try {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
      if (p && typeof p.catch === 'function') void p.catch(() => {})
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    if (!max) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    const onFs = () => {
      if (!document.fullscreenElement) close()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [max])

  // 组件卸载兜底还原
  useEffect(() => () => {
    const el = layerRef.current
    if (el && el.parentNode) el.parentNode.removeChild(el)
    layerRef.current = null
  }, [])

  return { max, layer: layerRef.current, open, close }
}

function Bar({ ratio, accent, height }: { ratio: number; accent?: boolean; height: number }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100
  return (
    <div style={{ position: 'relative', height, borderRadius: 999, background: FAINT, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${pct}%`,
          borderRadius: 999,
          background: accent ? 'linear-gradient(90deg,#2ea078,#5ccfa6)' : FILL,
        }}
      />
    </div>
  )
}

function Seg<T extends string>({
  items,
  value,
  onChange,
  compact,
}: {
  items: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  compact: boolean
}) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${LINE}`, borderRadius: 999, overflow: 'hidden' }}>
      {items.map((it) => {
        const on = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(it.id)}
            style={{
              font: 'inherit',
              fontSize: compact ? '0.76em' : '0.82em',
              padding: compact ? '2px 8px' : '3px 10px',
              border: 'none',
              background: on ? 'rgba(127,127,127,.2)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontWeight: on ? 700 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

function ScoreInput({ value, max, onChange, readOnly }: { value: number; max: number; onChange: (v: number) => void; readOnly: boolean }) {
  if (readOnly) return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  return (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      onChange={(e: { target: { value: string } }) => onChange(Math.max(0, Math.min(max, num(e.target.value, 0))))}
      style={{
        width: 44,
        padding: '2px 4px',
        textAlign: 'center',
        font: 'inherit',
        fontVariantNumeric: 'tabular-nums',
        border: `1px solid ${LINE}`,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
      }}
    />
  )
}

function OptionMatrix({ data, update, writable }: { data: Data; update: (patch: Record<string, unknown>) => void; writable: boolean }) {
  useOmStyle()
  const [showMd, setShowMd] = useState(false)
  const [copied, setCopied] = useState(false)
  const [draftTitle, setDraftTitle] = useState(data.title ?? '')
  const titleTouched = useRef(false)
  const zoom = useMaximize()

  useEffect(() => {
    if (!titleTouched.current) setDraftTitle(data.title ?? '')
  }, [data.title])

  const key = JSON.stringify(data)
  const m = useMemo(() => compute(data), [key])
  const scale = m.scale
  const options = m.options
  const criteria = m.criteria
  const scores = data.scores ?? {}
  const readOnly = !writable

  const [view, setViewState] = useState<ViewMode>(() => readView(data, options.length, criteria.length))
  const [density, setDensityState] = useState<Density>(data.density === 'compact' ? 'compact' : 'comfortable')
  const [fold, setFold] = useState(data.foldMinor === true)
  const compact = density === 'compact'

  // 视图 / 疏密是「看的人」的选择：只读也能切；可写时顺手记进块数据，下次打开还是这个看法。
  const setView = (v: ViewMode) => {
    setViewState(v)
    if (!readOnly) update({ view: v })
  }
  const setDensity = (d: Density) => {
    setDensityState(d)
    if (!readOnly) update({ density: d })
  }
  const toggleFold = () => {
    const next = !fold
    setFold(next)
    if (!readOnly) update({ foldMinor: next })
  }

  const setCriteria = (next: Criterion[]) => update({ criteria: next })
  const setScores = (next: Scores) => update({ scores: next })
  const setCell = (opt: string, crit: string, v: number) => {
    setScores({ ...scores, [opt]: { ...(scores[opt] ?? {}), [crit]: v } })
  }
  const renameCriterion = (ci: number, name: string) => {
    const old = criteria[ci]?.name
    const next = criteria.map((c, i) => (i === ci ? { ...c, name } : c))
    const ns: Scores = {}
    options.forEach((o) => {
      const row = { ...(scores[o] ?? {}) }
      if (old && old !== name) {
        row[name] = row[old] ?? 0
        delete row[old]
      }
      ns[o] = row
    })
    update({ criteria: next, scores: ns })
  }
  const renameOption = (oi: number, option: string) => {
    const old = options[oi]
    const next = options.map((o, i) => (i === oi ? option : o))
    const ns: Scores = { ...scores }
    if (old && old !== option) {
      ns[option] = ns[old] ?? {}
      delete ns[old]
    }
    update({ options: next, scores: ns })
  }

  const btn = (extra?: Record<string, unknown>): Record<string, unknown> => ({
    font: 'inherit',
    padding: '3px 10px',
    borderRadius: 6,
    border: `1px solid ${LINE}`,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    ...(extra ?? {}),
  })
  const field = (extra?: Record<string, unknown>): Record<string, unknown> => ({
    font: 'inherit',
    padding: '2px 4px',
    border: `1px solid ${LINE}`,
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    ...(extra ?? {}),
  })

  // 折叠低权重维度：8 个维度平铺太挤时，先只看权重在平均值以上的那几个。
  const avgWeight = criteria.length ? criteria.reduce((a, c) => a + num(c.weight, 0), 0) / criteria.length : 0
  const minorCount = criteria.filter((c) => num(c.weight, 0) < avgWeight).length
  const visible = criteria.map((c, ci) => ({ c, ci })).filter(({ c }) => !(fold && num(c.weight, 0) < avgWeight))

  // 推荐句跟着折叠走：收起低权重维度后，结论只讲还在台上的维度。
  const shownCriteria = visible.map(({ c }) => c)
  const rationale = m.winner ? rationaleFor(shownCriteria, m.rows, m.winner, m.maxTotal) : ''

  const md = useMemo(() => toMarkdown(data), [key])

  const cellStyle: Record<string, unknown> = {
    borderBottom: `1px solid rgba(127,127,127,.22)`,
    borderRight: `1px solid rgba(127,127,127,.22)`,
    padding: compact ? '3px 6px' : '6px 8px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  }

  // ── 矩阵视图：表头与首列吸顶/吸左，能横向滚动也不会看丢自己在看哪一格。
  const headCell: Record<string, unknown> = {
    ...cellStyle,
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: SURFACE,
    verticalAlign: 'top',
    fontWeight: 600,
    whiteSpace: compact ? 'normal' : 'nowrap',
    maxWidth: 200,
  }

  const headCells = [
    <th key="corner" style={{ ...headCell, left: 0, zIndex: 3, textAlign: 'left', opacity: 0.7 }}>方案 \ 维度</th>,
    ...visible.map(({ c, ci }) =>
      readOnly ? (
        <th key={`c${ci}`} style={headCell}>
          <div style={{ fontWeight: 700 }}>{c.name}</div>
          <div style={{ fontSize: '0.78em', opacity: 0.6, fontWeight: 400 }}>
            {`权重 ${num(c.weight, 0)} · ${c.higherIsBetter === false ? '↓越低越好' : '↑越高越好'}`}
          </div>
        </th>
      ) : (
        <th key={`c${ci}`} style={headCell}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
            <input value={c.name} onChange={(e: { target: { value: string } }) => renameCriterion(ci, e.target.value)} style={field({ fontWeight: 700, textAlign: 'center', width: 96 })} />
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ opacity: 0.6, fontSize: '0.8em' }}>权重</span>
              <input
                type="number"
                min={0}
                max={9}
                value={c.weight}
                onChange={(e: { target: { value: string } }) => setCriteria(criteria.map((x, i) => (i === ci ? { ...x, weight: num(e.target.value, 0) } : x)))}
                style={field({ width: 40, textAlign: 'center' })}
              />
            </div>
            <button
              type="button"
              title="点击切换维度方向"
              onClick={() => setCriteria(criteria.map((x, i) => (i === ci ? { ...x, higherIsBetter: x.higherIsBetter === false } : x)))}
              style={field({ fontSize: '0.78em', padding: '1px 6px', borderRadius: 999 })}
            >
              {c.higherIsBetter === false ? '↓ 越低越好' : '↑ 越高越好'}
            </button>
            <button
              type="button"
              style={{ font: 'inherit', fontSize: '0.75em', opacity: 0.6, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
              onClick={() => {
                const ns: Scores = { ...scores }
                options.forEach((o) => {
                  if (ns[o]) {
                    const row = { ...ns[o] }
                    delete row[c.name]
                    ns[o] = row
                  }
                })
                update({ criteria: criteria.filter((_, i) => i !== ci), scores: ns })
              }}
            >
              删除
            </button>
          </div>
        </th>
      ),
    ),
    <th key="total" style={{ ...headCell, right: 0, zIndex: 3, background: SURFACE }}>加权总分</th>,
  ]

  const bodyRows = m.rows.map((row, ri) => {
    const isWinner = !!m.winner && m.winner.option === row.option
    const stickyBg = isWinner ? `linear-gradient(${WIN_BG},${WIN_BG}), ${SURFACE}` : SURFACE
    return (
      <tr key={`r${ri}`} style={isWinner ? { background: WIN_BG } : {}}>
        <th style={{ ...cellStyle, position: 'sticky', left: 0, zIndex: 1, textAlign: 'left', background: stickyBg }}>
          {readOnly ? (
            <span style={{ fontWeight: isWinner ? 700 : 500 }}>{`${isWinner ? '✅ ' : ''}${row.option}`}</span>
          ) : (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input value={row.option} onChange={(e: { target: { value: string } }) => renameOption(ri, e.target.value)} style={field({ width: 130 })} />
              <button
                type="button"
                style={{ border: 'none', background: 'transparent', color: 'inherit', opacity: 0.5, cursor: 'pointer', font: 'inherit' }}
                onClick={() => {
                  const ns: Scores = { ...scores }
                  delete ns[row.option]
                  update({ options: options.filter((_, i) => i !== ri), scores: ns })
                }}
              >
                ×
              </button>
            </div>
          )}
        </th>
        {visible.map(({ c, ci }) => {
          const cell = row.cells[ci]
          const best = !!(cell && cell.best)
          return (
            <td key={`d${ci}`} style={{ ...cellStyle, background: best ? BEST_BG : undefined, fontWeight: best ? 700 : 400 }}>
              <ScoreInput value={(cell && cell.raw) || 0} max={scale} readOnly={readOnly} onChange={(v: number) => setCell(row.option, c.name, v)} />
              {c.higherIsBetter === false ? <span style={{ opacity: 0.5, fontSize: '0.78em' }}>{` →${(cell && cell.norm) || 0}`}</span> : null}
            </td>
          )
        })}
        <td
          key="t"
          style={{ ...cellStyle, position: 'sticky', right: 0, zIndex: 1, background: stickyBg, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        >
          {row.total.toFixed(1)}
          <div style={{ fontWeight: 400, fontSize: '0.78em', opacity: 0.65 }}>{`${(row.percent * 100).toFixed(1)}%`}</div>
        </td>
      </tr>
    )
  })

  const matrixView = (
    <div style={{ overflow: 'auto', maxHeight: zoom.max ? 'none' : compact ? 260 : 330, border: `1px solid ${LINE}`, borderRadius: 10 }}>
      <table
        data-testid="option-matrix-table"
        style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', fontSize: zoom.max ? (compact ? '0.9em' : '1em') : compact ? '0.8em' : '0.88em' }}
      >
        <thead>
          <tr>{headCells}</tr>
        </thead>
        <tbody>{bodyRows}</tbody>
      </table>
    </div>
  )

  // ── 卡片视图：一个方案一张卡，维度纵向排开，不再挤成一张宽表。
  const cardsView = (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 210 : 260}px, 1fr))`, gap: compact ? 10 : 14 }}>
      {m.ranked.map((row) => {
        const isWinner = !!m.winner && m.winner.option === row.option
        return (
          <article
            key={row.option}
            data-testid="option-matrix-card"
            style={{
              border: `1px solid ${isWinner ? WIN_LINE : LINE}`,
              borderRadius: 12,
              padding: compact ? 10 : 14,
              background: isWinner ? WIN_SOFT : 'transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: compact ? 8 : 11,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: '0.76em', fontWeight: 800, opacity: 0.6 }}>{`#${row.rank}`}</span>
              <strong style={{ fontSize: compact ? '0.96em' : '1.04em', lineHeight: 1.3, minWidth: 0, fontWeight: 800 }}>
                {`${isWinner ? '✅ ' : ''}${row.option}`}
              </strong>
              <span style={{ flex: 1 }} />
              <span style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{row.total.toFixed(1)}</span>
            </div>
            <Bar ratio={row.percent} accent={isWinner} height={compact ? 6 : 8} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 9 }}>
              {visible.map(({ c, ci }) => {
                const cell = row.cells[ci]
                const best = !!(cell && cell.best)
                const reversed = c.higherIsBetter === false
                return (
                  <div
                    key={c.name}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: best ? '3px 6px' : undefined,
                      margin: best ? '-3px -6px' : undefined,
                      borderRadius: 6,
                      background: best ? BEST_BG : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: '0.82em' }}>
                      <span style={{ minWidth: 0, fontWeight: best ? 700 : 500 }}>{c.name}</span>
                      <span style={{ opacity: 0.55, fontSize: '0.85em', whiteSpace: 'nowrap' }}>{`权重${num(c.weight, 0)}${reversed ? ' ↓' : ' ↑'}`}</span>
                      <span style={{ flex: 1, minWidth: 4 }} />
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{cell ? cell.raw : 0}</span>
                      {reversed ? <span style={{ opacity: 0.5, fontSize: '0.85em' }}>{`→${cell ? cell.norm : 0}`}</span> : null}
                    </div>
                    <Bar ratio={(cell ? cell.raw : 0) / scale} accent={best} height={compact ? 4 : 5} />
                  </div>
                )
              })}
            </div>
            <div style={{ marginTop: 'auto', fontSize: '0.76em', opacity: 0.6 }}>{`满分 ${m.maxTotal.toFixed(1)} · ${(row.percent * 100).toFixed(1)}%`}</div>
          </article>
        )
      })}
    </div>
  )

  // ── 排名视图：只留结论 —— 加权总分排序 + 每个维度的最优归属。
  const rankView = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 9 : 13 }}>
      {m.ranked.map((row) => {
        const isWinner = !!m.winner && m.winner.option === row.option
        return (
          <div key={row.option} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: compact ? '0.85em' : '0.92em', minWidth: 0 }}>
              <span style={{ opacity: 0.6, fontWeight: 800, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{row.rank === 1 ? '🏆' : `#${row.rank}`}</span>
              <strong style={{ minWidth: 0 }}>{row.option}</strong>
              <span style={{ flex: 1, minWidth: 4 }} />
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{row.total.toFixed(1)}</span>
              <span style={{ opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{`${(row.percent * 100).toFixed(1)}%`}</span>
            </div>
            <Bar ratio={row.percent} accent={isWinner} height={compact ? 8 : 11} />
          </div>
        )
      })}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
        {visible.map(({ c, ci }) => {
          const bests = m.rows.filter((r) => r.cells[ci] && r.cells[ci].best).map((r) => r.option)
          const winHas = !!m.winner && bests.indexOf(m.winner.option) >= 0
          return (
            <span
              key={c.name}
              title={`权重 ${num(c.weight, 0)} · ${c.higherIsBetter === false ? '越低越好' : '越高越好'}`}
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 6,
                fontSize: '0.76em',
                padding: '3px 9px',
                borderRadius: 999,
                border: `1px solid ${winHas ? WIN_LINE : LINE}`,
                background: winHas ? WIN_SOFT : 'transparent',
              }}
            >
              <span style={{ opacity: 0.75 }}>{c.name}</span>
              <span style={{ fontWeight: 700 }}>{bests.join(' / ')}</span>
            </span>
          )
        })}
      </div>
    </div>
  )

  const addRow = !readOnly ? (
    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <button
        type="button"
        style={btn({ border: `1px dashed ${LINE}`, fontSize: '0.85em' })}
        onClick={() => {
          const nm = `方案 ${String.fromCharCode(65 + options.length)}`
          const ns: Scores = { ...scores, [nm]: {} }
          criteria.forEach((c) => {
            ns[nm][c.name] = 3
          })
          update({ options: [...options, nm], scores: ns })
        }}
      >
        + 加方案
      </button>
      <button
        type="button"
        style={btn({ border: `1px dashed ${LINE}`, fontSize: '0.85em' })}
        onClick={() => {
          const nm = `维度 ${criteria.length + 1}`
          const ns: Scores = { ...scores }
          options.forEach((o) => {
            ns[o] = { ...(ns[o] ?? {}), [nm]: 3 }
          })
          update({ criteria: [...criteria, { name: nm, weight: 1, higherIsBetter: true }], scores: ns })
        }}
      >
        + 加维度
      </button>
      <button type="button" style={btn({ fontSize: '0.85em' })} onClick={() => update({ scale: scale >= 10 ? 5 : scale + 1 })}>
        {`满分制 ${scale} → ${scale >= 10 ? 5 : scale + 1}`}
      </button>
    </div>
  ) : null

  const mdPanel = showMd ? (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: '0.82em', opacity: 0.7 }}>Markdown（agent 可直接读）</span>
        <button
          type="button"
          style={btn({ fontSize: '0.82em', padding: '2px 8px' })}
          onClick={() => {
            const nav = globalThis.navigator
            if (nav && nav.clipboard && nav.clipboard.writeText) void nav.clipboard.writeText(md)
            setCopied(true)
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <textarea
        readOnly
        value={md}
        style={{
          width: '100%',
          minHeight: 130,
          font: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.8em',
          padding: 8,
          borderRadius: 8,
          border: `1px solid ${LINE}`,
          background: 'rgba(127,127,127,.06)',
          color: 'inherit',
        }}
      />
    </div>
  ) : null

  const titleNode = readOnly ? (
    <strong style={{ fontSize: '1.05em' }}>{data.title || '方案对比'}</strong>
  ) : (
    <input
      value={draftTitle}
      placeholder="对比标题"
      onChange={(e: { target: { value: string } }) => {
        titleTouched.current = true
        setDraftTitle(e.target.value)
      }}
      onBlur={() => {
        titleTouched.current = false
        update({ title: draftTitle })
      }}
      style={field({ fontWeight: 700, fontSize: '1.05em', minWidth: 180 })}
    />
  )

  const statNode = <span style={{ opacity: 0.6, fontSize: '0.82em', whiteSpace: 'nowrap' }}>{`${options.length} 方案 × ${criteria.length} 维度 · 满分 ${m.maxTotal.toFixed(1)}`}</span>

  // 视图 / 疏密 / 折叠 / 导出 / 放大：只读也有，看的人随时换视角。
  const controls = [
    <Seg key="view" items={VIEWS} value={view} onChange={setView} compact={compact} />,
    <button key="den" type="button" title="切换疏密" style={btn({ fontSize: '0.82em', padding: '2px 8px' })} onClick={() => setDensity(compact ? 'comfortable' : 'compact')}>
      {compact ? '紧凑' : '舒适'}
    </button>,
    criteria.length >= 6 && minorCount > 0 ? (
      <button key="fold" type="button" title="只显示权重不低于平均值的维度" style={btn({ fontSize: '0.82em', padding: '2px 8px' })} onClick={toggleFold}>
        {fold ? `显示全部维度（+${minorCount}）` : `只看高权重（-${minorCount}）`}
      </button>
    ) : null,
    <button key="md" type="button" style={btn({ fontSize: '0.82em', padding: '2px 8px' })} onClick={() => setShowMd((v) => !v)}>
      {showMd ? '隐藏 Markdown' : '导出 Markdown'}
    </button>,
    <button
      key="zoom"
      type="button"
      data-page-block-expand=""
      title={zoom.max ? '退出放大（Esc）' : '放大到全屏看'}
      aria-label={zoom.max ? '退出放大' : '放大'}
      onClick={() => (zoom.max ? zoom.close() : zoom.open())}
      style={btn({ fontSize: '0.82em', padding: '2px 8px', fontWeight: 700, whiteSpace: 'nowrap' })}
    >
      {zoom.max ? '⤡ 缩小' : '⤢ 放大'}
    </button>,
  ]

  const toolbarRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      {titleNode}
      {statNode}
      <span style={{ flex: 1, minWidth: 8 }} />
      {controls}
    </div>
  )

  const body = (
    <>
      {toolbarRow}
      {view === 'matrix' ? matrixView : null}
      {view === 'cards' ? cardsView : null}
      {view === 'rank' ? rankView : null}
      {rationale ? (
        <div
          data-testid="option-matrix-rationale"
          style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(127,127,127,.08)', fontSize: compact ? '0.84em' : '0.9em', lineHeight: 1.55 }}
        >
          {`💡 ${rationale}`}
        </div>
      ) : null}
      {addRow}
      {mdPanel}
    </>
  )

  return (
    <>
      <div
        data-testid="option-matrix"
        className="om-root"
        style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: compact ? 10 : 14, margin: '10px 0', font: 'inherit' }}
      >
        {zoom.max ? (
          <>
            {toolbarRow}
            <div style={{ fontSize: '0.82em', opacity: 0.6 }}>已放大到全屏窗口显示 —— 点「⤡ 缩小」或按 Esc 退出。</div>
          </>
        ) : (
          body
        )}
      </div>
      {zoom.max && zoom.layer
        ? createPortal(
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0, font: 'inherit', color: 'inherit' }}>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: compact ? 14 : 22 }}>{body}</div>
            </div>,
            zoom.layer,
          )
        : null}
    </>
  )
}

export function apply(ctx: {
  pageEditor: { registerBlock: (spec: Record<string, unknown>) => void }
}) {
  ctx.pageEditor.registerBlock({
    kind: 'option-matrix',
    plugin: name,
    label: '方案对比块',
    blockType: 'test',
    blockTypeLabel: '测试',
    hint: '多方案 × 多维度加权对比矩阵：矩阵 / 卡片 / 排名三种看法随时切，可放大到全屏；越低越好的维度自动反向计入',
    aliases: ['matrix', 'option', 'compare', '对比', '矩阵', '选型', '方案对比'],
    defaults: () => DEFAULTS,
    View: ({ data, update, writable }: { data: Record<string, unknown>; update: (patch: Record<string, unknown>) => void; writable: boolean }) =>
      React.createElement(OptionMatrix, { data: data as Data, update, writable }),
  })
}
