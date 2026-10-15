const React = globalThis.React
const { useState, useCallback, useEffect } = React

export const name = 'plugin-selftest'
export const inject = ['slots', 'uiActions']

type Case = { id: string; label: string; run: () => any }
type Result = { id: string; label: string; ok: boolean; ms: number; detail: string }

const CASES: Case[] = [
  {
    id: 'react',
    label: 'React 运行时已注入（useState 可用）',
    run: () => (typeof useState === 'function' ? 'useState ok' : 'missing'),
  },
  {
    id: 'jsx',
    label: 'JSX 编译产物可渲染（<div/>）',
    run: () => {
      const el = <div data-testid="probe">ok</div>
      if (!el || typeof el !== 'object') throw new Error('element 不是对象')
      return 'type=' + (el.type === 'div' ? 'div' : String(el.type))
    },
  },
  {
    id: 'math',
    label: '基础运算 1 + 1 === 2',
    run: () => {
      if (1 + 1 !== 2) throw new Error('算术异常')
      return '2'
    },
  },
  {
    id: 'json',
    label: 'JSON 往返一致',
    run: () => {
      const s = JSON.stringify({ a: [1, 2, 3], b: '中文' })
      const back = JSON.parse(s)
      if (back.a.length !== 3 || back.b !== '中文') throw new Error('往返不一致')
      return s
    },
  },
  {
    id: 'uuid',
    label: 'crypto.randomUUID 可用',
    run: () => {
      const c = (globalThis as any).crypto
      if (!c || typeof c.randomUUID !== 'function') throw new Error('无 crypto.randomUUID')
      return c.randomUUID().slice(0, 8) + '…'
    },
  },
  {
    id: 'async',
    label: 'Promise / async-await 正常',
    run: async () => {
      const v = await Promise.resolve(41).then((x) => x + 1)
      if (v !== 42) throw new Error('得到 ' + v)
      return '42'
    },
  },
  {
    id: 'origin',
    label: '页面 origin 可达',
    run: () => {
      const o = (globalThis as any).location && (globalThis as any).location.origin
      if (!o) throw new Error('无 location.origin')
      return o
    },
  },
  {
    id: 'storage',
    label: 'localStorage 可读写',
    run: () => {
      const key = '__selftest_probe__'
      const ls = (globalThis as any).localStorage
      if (!ls) throw new Error('无 localStorage')
      ls.setItem(key, '1')
      const v = ls.getItem(key)
      ls.removeItem(key)
      if (v !== '1') throw new Error('读回 ' + String(v))
      return 'ok'
    },
  },
  {
    id: 'fetch',
    label: 'fetch 存在（不发实际请求）',
    run: () => {
      if (typeof (globalThis as any).fetch !== 'function') throw new Error('无 fetch')
      return 'ok'
    },
  },
  {
    id: 'viewport',
    label: '窗口尺寸 / DPR 可读',
    run: () => window.innerWidth + 'x' + window.innerHeight + ' @' + window.devicePixelRatio + 'x',
  },
]

async function runAll(): Promise<Result[]> {
  const out: Result[] = []
  for (const c of CASES) {
    const t0 = performance.now()
    try {
      const detail = await c.run()
      out.push({ id: c.id, label: c.label, ok: true, ms: performance.now() - t0, detail: String(detail) })
    } catch (e: any) {
      out.push({
        id: c.id,
        label: c.label,
        ok: false,
        ms: performance.now() - t0,
        detail: e && e.message ? e.message : String(e),
      })
    }
  }
  return out
}

// 组件与 uiActions 共享的结果仓
let lastResults: Result[] | null = null
const listeners = new Set<() => void>()

function publish(next: Result[] | null) {
  lastResults = next
  for (const fn of listeners) fn()
}

function summary(rs: Result[]) {
  const failed = rs.filter((r) => !r.ok)
  return {
    passed: rs.length - failed.length,
    total: rs.length,
    status: failed.length ? 'fail' : 'pass',
    failed: failed.map((r) => r.id + ': ' + r.detail),
    cases: rs.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail, ms: Math.round(r.ms * 10) / 10 })),
  }
}

const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const border = '1px solid var(--dsw-border, #e5e5e5)'
const btn = (disabled: boolean) => ({
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--dsw-border, #ccc)',
  background: 'transparent',
  color: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.55 : 1,
})

function Card() {
  const [results, setResults] = useState<Result[] | null>(lastResults)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const fn = () => setResults(lastResults)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])

  const onRun = useCallback(async () => {
    setBusy(true)
    try {
      publish(await runAll())
    } finally {
      setBusy(false)
    }
  }, [])

  const passed = results ? results.filter((r) => r.ok).length : 0
  const total = results ? results.length : 0
  const allOk = !!results && passed === total

  return (
    <div style={{ fontFamily: 'var(--font-sans, sans-serif)', color: 'var(--dsw-label, #111)', padding: 16, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>运行时自检</h2>
        {results && (
          <span
            data-selftest-summary
            style={{ fontSize: 12, padding: '1px 6px', borderRadius: 999, background: allOk ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)', color: allOk ? '#16a34a' : '#dc2626' }}
          >
            {passed}/{total} 通过
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, opacity: 0.65 }}>
        点「跑一遍」，在当前窗口里逐条执行运行时检查，验证插件窗口这条链路。
      </div>

      <div style={{ flex: 1, overflow: 'auto', border, borderRadius: 8 }}>
        {!results && <div style={{ padding: 12, fontSize: 12, opacity: 0.4 }}>还没有结果，点下面的按钮开始。</div>}
        {results &&
          results.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 10px', borderTop: border, fontSize: 12 }}>
              <span style={{ width: 44, flex: 'none', fontWeight: 600, color: r.ok ? '#16a34a' : '#dc2626' }}>{r.ok ? '通过' : '失败'}</span>
              <span style={{ flex: 1 }}>
                {r.label}
                <span style={{ fontFamily: mono, opacity: 0.55, marginLeft: 6 }}>{r.detail}</span>
              </span>
              <span style={{ fontFamily: mono, opacity: 0.4 }}>{r.ms.toFixed(1)}ms</span>
            </div>
          ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onRun} disabled={busy} style={btn(busy)}>
          {busy ? '运行中…' : '跑一遍'}
        </button>
        <button onClick={() => publish(null)} disabled={!results || busy} style={btn(!results || busy)}>
          清空
        </button>
      </div>
    </div>
  )
}

export function apply(ctx: any) {
  ctx.slots.place('plugin-store-extras', Card, { key: name })

  if (!ctx.uiActions) return
  ctx.uiActions.register({
    plugin: name,
    instanceId: name + ':card',
    kind: 'selftest',
    label: '运行时自检卡片',
    state: () => (lastResults ? { summary: summary(lastResults) } : { ran: false }),
    actions: {
      run: {
        description: '在当前浏览器窗口里跑一遍全部运行时自检，返回通过/失败明细',
        risk: 'submit',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => summary(await runAllAndPublish()),
      },
      read_result: {
        description: '读取上一次自检结果；还没跑过时 ran=false',
        risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => (lastResults ? { ran: true, ...summary(lastResults) } : { ran: false }),
      },
      clear: {
        description: '清空当前显示的自检结果',
        risk: 'write',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          publish(null)
          return { cleared: true }
        },
      },
    },
  })
}

async function runAllAndPublish(): Promise<Result[]> {
  const rs = await runAll()
  publish(rs)
  return rs
}
