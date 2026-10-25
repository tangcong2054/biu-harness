const React = globalThis.React
const { useState, useCallback, useEffect } = React
const h = React.createElement

export const name = 'cost-reconcile'
export const inject = ['pageEditor', 'uiActions']

type BlockProps = { data: Record<string, unknown>; update: (patch: Record<string, unknown>) => void; writable: boolean }

const STYLE_ID = 'cost-reconcile-style-v1'
const CSS = `
.cr{margin:12px 0;border:1px solid var(--dsw-border);border-radius:10px;font-family:var(--font-sans);font-size:13.5px;color:var(--dsw-label);background:var(--dsw-bg);overflow:hidden}
.cr *{box-sizing:border-box}
.cr-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.04))}
.cr-title{font-weight:700;font-size:12.5px}
.cr-meta{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-3)}
.cr-grow{flex:1}
.cr-btn{height:27px;padding:0 11px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.cr-btn:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.cr-btn.pri{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff}
.cr-btn.sm{height:23px;padding:0 8px;font-size:12px}
.cr-btn:disabled{opacity:.5;cursor:default}
.cr-sel,.cr-inp{height:26px;padding:0 7px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-input,transparent);color:var(--dsw-label);font:inherit;font-size:12.5px;outline:none}
.cr-body{padding:11px 12px}
.cr-sec{font-size:12px;color:var(--dsw-label-3);margin:13px 0 6px;font-weight:650;letter-spacing:.02em}
.cr-sec:first-child{margin-top:0}
.cr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.cr-card{border:1px solid var(--dsw-border);border-radius:8px;padding:8px 10px;min-width:0}
.cr-card.warn{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 7%,transparent)}
.cr-card.ok{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 42%,var(--dsw-border))}
.cr-klab{font-size:11px;color:var(--dsw-label-3);margin-bottom:3px}
.cr-kval{font-family:var(--font-mono);font-size:16px;font-weight:700}
.cr-wrap{max-height:330px;overflow:auto;border:1px solid var(--dsw-border);border-radius:8px}
.cr-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.cr-tbl th{position:sticky;top:0;padding:5px 8px;border-bottom:1px solid var(--dsw-border);text-align:left;font-weight:650;color:var(--dsw-label-3);font-size:11.5px;white-space:nowrap;background:var(--dsw-bg)}
.cr-tbl td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-border) 55%,transparent);white-space:nowrap}
.cr-num{font-family:var(--font-mono);font-size:11.5px}
.cr-bad{color:var(--dsw-danger,#d9534f);font-weight:700}
.cr-ok{color:var(--dsw-ok,#3fb950)}
.cr-warn{color:var(--dsw-warn,#d29922)}
.cr-flag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-family:var(--font-mono)}
.cr-flag.d{border:1px solid color-mix(in srgb,var(--dsw-danger,#d9534f) 50%,var(--dsw-border));color:var(--dsw-danger,#d9534f)}
.cr-flag.w{border:1px solid color-mix(in srgb,var(--dsw-warn,#d29922) 50%,var(--dsw-border));color:var(--dsw-warn,#d29922)}
.cr-flag.o{border:1px solid var(--dsw-border);color:var(--dsw-label-3)}
.cr-box{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-border);font-size:13px;line-height:1.65}
.cr-box.ok{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-ok,#3fb950) 9%,transparent)}
.cr-box.bad{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent)}
.cr-code{margin:7px 0 0;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.05));font-family:var(--font-mono);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.cr-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:7px;align-items:end;padding:9px 10px;border:1px dashed var(--dsw-border);border-radius:8px}
.cr-empty{padding:20px 12px;border:1px dashed var(--dsw-border);border-radius:8px;color:var(--dsw-label-3);font-size:12.5px;text-align:center;line-height:1.7}
.cr-delta{font-family:var(--font-mono);font-weight:700}
`

function useStyle() {
  useEffect(() => {
    const found = document.getElementById(STYLE_ID)
    const el = found instanceof HTMLStyleElement ? found : document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

function money(v: unknown) {
  const n = Number(v) || 0
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function n1(v: unknown) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** HTTP 失败（5xx、非 JSON、鉴权失败）也要落到 `{ ok:false, error }`，不能让界面静默停在旧数据上。 */
async function readResult(res: Response): Promise<Record<string, any>> {
  const body = (await res.json().catch(() => null)) as Record<string, any> | null
  if (!res.ok) return { ...(body ?? {}), ok: false, error: String(body?.error ?? `HTTP ${res.status}`) }
  if (!body || typeof body !== 'object') return { ok: false, error: '服务返回的不是 JSON' }
  return body
}
async function getJson(url: string) {
  try {
    return await readResult(await fetch(url))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
async function postJson(url: string, body: unknown) {
  try {
    return await readResult(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const COLS: Array<[string, string]> = [
  ['proj_name', '项目'], ['code', '清单编码'], ['item_name', '子目'], ['unit', '单位'],
  ['contract_qty', '合同量'], ['contract_price', '合同价'], ['contract_amt', '合同金额'],
  ['changed_qty', '变更后量'], ['changed_price', '变更后价'], ['changed_amt', '变更后金额'],
  ['settle_qty', '结算量'], ['settle_price', '结算价'], ['settle_amt', '结算金额'],
  ['delta', '差额'], ['over_rate', '偏差%'], ['reported_by', '报送方'],
]
const MONEY_COLS = new Set(['contract_price', 'contract_amt', 'changed_price', 'changed_amt', 'settle_price', 'settle_amt'])

function View(props: BlockProps) {
  useStyle()
  const { data, update } = props
  const ro = props.writable === false
  const conn = (data.conn as Record<string, unknown>) ?? {}
  const connQ = 'conn=' + encodeURIComponent(JSON.stringify(conn))

  const [projects, setProjects] = useState<string[][]>([])
  const [projId, setProjId] = useState(String(data.proj_id ?? '5'))
  const [rec, setRec] = useState<Record<string, any> | null>(null)
  const [changes, setChanges] = useState<string[][]>([])
  const [diffs, setDiffs] = useState<string[][]>([])
  const [summary, setSummary] = useState<string[] | null>(null)
  const [saved, setSaved] = useState<Record<string, any> | null>(null)
  const [added, setAdded] = useState<Record<string, any> | null>(null)
  const [material, setMaterial] = useState<string[][]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ code: '010101001', change_type: '量增', qty_delta: '80', price_delta: '0', reason: '现场签认：土方外运距离增加' })

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const r = await getJson('/api/cost-reconcile/reconcile?' + connQ + '&proj_id=' + projId)
      if (!r.ok) setErr(String(r.error ?? '对账失败')); else setRec(r)
      const c = await getJson('/api/cost-reconcile/changes?' + connQ + '&proj_id=' + projId)
      if (c.ok) setChanges(c.rows as string[][])
      const d = await getJson('/api/cost-reconcile/diffs?' + connQ)
      if (d.ok) { setDiffs(d.rows as string[][]); setSummary(d.summary as string[]) }
      const m = await getJson('/api/cost-reconcile/material?' + connQ)
      if (m.ok) setMaterial(m.rows as string[][])
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [connQ, projId])

  useEffect(() => {
    getJson('/api/cost-reconcile/projects?' + connQ).then((out) => {
      if (out.ok) {
        setProjects(out.rows as string[][])
        const ids = (out.rows as string[][]).map((r) => r[0])
        if (ids.length && !ids.includes(projId)) setProjId(ids[0])
      }
    }).catch(() => undefined)
  }, [connQ])

  useEffect(() => { void load() }, [load])

  const addChange = useCallback(async () => {
    setBusy(true); setErr(''); setAdded(null); setSaved(null)
    try {
      const out = await postJson('/api/cost-reconcile/change', {
        conn, proj_id: Number(projId), code: form.code, change_type: form.change_type,
        qty_delta: Number(form.qty_delta) || 0, price_delta: Number(form.price_delta) || 0,
        reason: form.reason, approved: true,
      })
      if (!out.ok) setErr(String(out.error ?? '写签证失败'))
      else { setAdded(out); await load() }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, form, load, projId])

  const writeDiffs = useCallback(async () => {
    if (!rec) return
    setBusy(true); setErr(''); setAdded(null)
    try {
      const iCode = rec.columns.indexOf('code')
      const iDelta = rec.columns.indexOf('delta')
      const items = (rec.rows as string[][])
        .map((r, i) => ({ r, i }))
        .filter((x) => rec.flags[x.i] !== '一致')
        .slice(0, 8)
        .map(({ r }) => {
          const get = (name: string) => r[rec.columns.indexOf(name)]
          return {
            proj_id: Number(get('proj_id')), proj_name: get('proj_name'), code: r[iCode], item_name: get('item_name'),
            contract_amt: Number(get('contract_amt')), changed_amt: Number(get('changed_amt')), settle_amt: Number(get('settle_amt')),
            delta: r[iDelta], over_rate: get('over_rate'),
            reason: get('delta') > 0 ? '结算高于变更后金额，需核对签证与工程量' : '结算低于变更后金额，需核对核减是否已入账',
          }
        })
      if (!items.length) { setErr('没有差异可写'); setBusy(false); return }
      const out = await postJson('/api/cost-reconcile/write-diff', { conn, items, confirmed_by: String(data.confirmed_by ?? '造价组') })
      if (!out.ok) setErr(String(out.error ?? '写结论失败'))
      else { setSaved(out); await load() }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, data.confirmed_by, load, rec])

  const cols = rec?.columns as string[] | undefined
  const flagCls = (f: string) => (f === '超支' ? 'cr-flag d' : f === '一致' ? 'cr-flag o' : 'cr-flag w')

  return h('div', { className: 'cr', 'data-biu-testid': 'cost-reconcile' },
    h('div', { className: 'cr-hd' },
      h('span', { className: 'cr-title' }, '造价三方对账'),
      h('span', { className: 'cr-meta' }, '合同清单 / 签证变更 / 结算 · 三张表按编码 join'),
      h('span', { className: 'cr-grow' }),
      h('span', { className: 'cr-meta' }, '项目'),
      h('select', { className: 'cr-sel', value: projId, disabled: ro, 'data-biu-testid': 'cr-project', onChange: (e: any) => { setProjId(e.target.value); update({ proj_id: e.target.value }) } },
        (projects.length ? projects : [['5', '环城路改扩建']]).map((p) => h('option', { key: p[0], value: p[0] }, p[1]))),
      h('button', { className: 'cr-btn pri', disabled: busy, onClick: () => void load(), 'data-biu-testid': 'cr-reconcile' }, busy ? '对账中…' : '重新对账'),
    ),

    h('div', { className: 'cr-body' },
      err ? h('div', { className: 'cr-box bad', style: { marginBottom: 10 } }, err) : null,

      rec ? h('div', null,
        h('div', { className: 'cr-sec' }, '① 三方对齐结果（跨三张表真 join：合同 → 加签证 → 对结算）'),
        h('div', { className: 'cr-cards' },
          h('div', { className: 'cr-card' }, h('div', { className: 'cr-klab' }, '清单子目数'), h('div', { className: 'cr-kval' }, rec.itemCount)),
          h('div', { className: 'cr-card' }, h('div', { className: 'cr-klab' }, '合同金额合计'), h('div', { className: 'cr-kval' }, money(rec.contractTotal))),
          h('div', { className: 'cr-card' + (rec.diffCount ? ' warn' : ' ok') }, h('div', { className: 'cr-klab' }, '对不上的子目'), h('div', { className: 'cr-kval' }, rec.diffCount + ' 条')),
          h('div', { className: 'cr-card' + (rec.absAmount ? ' warn' : ' ok') }, h('div', { className: 'cr-klab' }, '差异绝对值合计'), h('div', { className: 'cr-kval' }, money(rec.absAmount))),
          h('div', { className: 'cr-card' }, h('div', { className: 'cr-klab' }, '本次对账耗时'), h('div', { className: 'cr-kval' }, rec.ms + 'ms')),
        ),

        h('div', { className: 'cr-wrap', style: { marginTop: 9 } },
          h('table', { className: 'cr-tbl', 'data-biu-testid': 'cr-table' },
            h('thead', null, h('tr', null, COLS.map(([key, label]) => h('th', { key }, label)).concat([h('th', { key: 'flag' }, '判定')]))),
            h('tbody', null, (rec.rows as string[][]).map((r, i) => {
              const flag = rec.flags[i]
              return h('tr', { key: i },
                COLS.map(([key]) => {
                  const idx = cols ? cols.indexOf(key) : -1
                  const v = idx >= 0 ? r[idx] : ''
                  if (key === 'delta') {
                    const dv = n1(v)
                    return h('td', { key, className: 'cr-delta ' + (Math.abs(dv) > 1 ? 'cr-bad' : 'cr-ok') }, (dv > 0 ? '+' : '') + money(dv))
                  }
                  if (key === 'over_rate') {
                    const ov = n1(v)
                    return h('td', { key, className: 'cr-num ' + (Math.abs(ov) >= 10 ? 'cr-bad' : Math.abs(ov) > 0 ? 'cr-warn' : 'cr-ok') }, ov ? ov + '%' : '0%')
                  }
                  return h('td', { key, className: MONEY_COLS.has(key) ? 'cr-num' : (key === 'proj_name' || key === 'item_name' ? undefined : 'cr-meta') },
                    MONEY_COLS.has(key) ? money(v) : String(v ?? ''))
                }),
                h('td', { key: 'f' }, h('span', { className: flagCls(flag) }, flag)),
              )
            })),
          ),
        ),
      ) : h('div', { className: 'cr-empty' }, busy ? '对账中…' : '选项目后点「重新对账」。'),

      h('div', { className: 'cr-sec' }, '② 加一条签证 → 差异立刻重算（真写入 t_cost_change）'),
      h('div', { className: 'cr-form' },
        h('div', null, h('div', { className: 'cr-klab' }, '清单编码'), h('input', { className: 'cr-inp', style: { width: '100%' }, value: form.code, disabled: ro, onChange: (e: any) => setForm({ ...form, code: e.target.value }) })),
        h('div', null, h('div', { className: 'cr-klab' }, '类型'), h('select', { className: 'cr-inp', style: { width: '100%' }, value: form.change_type, disabled: ro, onChange: (e: any) => setForm({ ...form, change_type: e.target.value }) },
          ['量增', '量减', '价调'].map((t) => h('option', { key: t, value: t }, t)))),
        h('div', null, h('div', { className: 'cr-klab' }, '工程量增减'), h('input', { className: 'cr-inp', style: { width: '100%' }, value: form.qty_delta, disabled: ro, 'data-biu-testid': 'cr-qty', onChange: (e: any) => setForm({ ...form, qty_delta: e.target.value }) })),
        h('div', null, h('div', { className: 'cr-klab' }, '单价增减'), h('input', { className: 'cr-inp', style: { width: '100%' }, value: form.price_delta, disabled: ro, onChange: (e: any) => setForm({ ...form, price_delta: e.target.value }) })),
        h('div', { style: { gridColumn: 'span 2' } }, h('div', { className: 'cr-klab' }, '事由'), h('input', { className: 'cr-inp', style: { width: '100%' }, value: form.reason, disabled: ro, onChange: (e: any) => setForm({ ...form, reason: e.target.value }) })),
        h('button', { className: 'cr-btn pri', disabled: busy || ro, onClick: () => void addChange(), 'data-biu-testid': 'cr-add-change' }, '写入这条签证'),
      ),

      added && added.ok ? h('div', { className: 'cr-box ok', style: { marginTop: 9 }, 'data-biu-testid': 'cr-add-result' },
        h('div', null, h('b', null, '✔ 已写入签证 change_id=' + added.change_id), h('span', { className: 'cr-meta' }, '　表 cost_demo.t_cost_change')),
        h('table', { className: 'cr-tbl', style: { marginTop: 7 } },
          h('thead', null, h('tr', null, ['', '差异条数', '差异绝对值', '这个子目的差额'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null,
            h('tr', null, h('td', null, '写入前'), h('td', { className: 'cr-num' }, added.before.diffCount), h('td', { className: 'cr-num' }, money(added.before.absAmount)),
              h('td', { className: 'cr-num' }, added.before.item ? (added.before.item.item_name + ' ' + money(added.before.item.delta)) : '—')),
            h('tr', null, h('td', { style: { fontWeight: 650 } }, '写入后'), h('td', { className: 'cr-num cr-bad' }, added.after.diffCount), h('td', { className: 'cr-num cr-bad' }, money(added.after.absAmount)),
              h('td', { className: 'cr-num cr-bad' }, added.after.item ? (added.after.item.item_name + ' ' + money(added.after.item.delta)) : '—')),
          ),
        ),
        h('pre', { className: 'cr-code' }, '真实执行的 SQL：\n' + String(added.wrote ?? '')),
        h('div', { className: 'cr-meta', style: { marginTop: 6 } }, '这条签证有 change_id，下次谁打开这页、换成哪个项目，它都还在 —— 不是「我上一条消息说过」。'),
      ) : null,

      rec ? h('div', { style: { marginTop: 10 } },
        h('button', { className: 'cr-btn pri', disabled: busy || ro, onClick: () => void writeDiffs(), 'data-biu-testid': 'cr-write-diff' }, '把 ' + rec.diffCount + ' 条差异写成结论'),
        h('span', { className: 'cr-meta', style: { marginLeft: 8 } }, '→ 写入 cost_demo.t_cost_diff（子目 / 差额 / 偏差 / 原因 / 确认人）'),
      ) : null,

      saved && saved.ok ? h('div', { className: 'cr-box ok', style: { marginTop: 9 }, 'data-biu-testid': 'cr-diff-result' },
        h('div', null, h('b', null, '✔ 已写入 ' + saved.written + ' 条差异结论'), h('span', { className: 'cr-meta' }, '　表 cost_demo.t_cost_diff')),
      ) : null,

      h('div', { className: 'cr-sec' }, '③ 签证台账（t_cost_change 的真实行）'),
      changes.length ? h('div', { className: 'cr-wrap', style: { maxHeight: 190 } },
        h('table', { className: 'cr-tbl' },
          h('thead', null, h('tr', null, ['change_id', '项目', '编码', '子目', '类型', '量增减', '价增减', '事由', '日期'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, changes.map((r, i) => h('tr', { key: i },
            h('td', { className: 'cr-meta' }, r[0]),
            h('td', null, r[1]),
            h('td', { className: 'cr-meta' }, r[2]),
            h('td', null, r[3]),
            h('td', { className: 'cr-meta' }, r[4]),
            h('td', { className: 'cr-num ' + (n1(r[5]) >= 0 ? '' : 'cr-warn') }, r[5]),
            h('td', { className: 'cr-num' }, r[6]),
            h('td', { className: 'cr-meta' }, String(r[7] ?? '').slice(0, 26)),
            h('td', { className: 'cr-meta' }, r[8]),
          ))),
        ),
      ) : h('div', { className: 'cr-empty' }, '这个项目暂无签证记录。'),

      h('div', { className: 'cr-sec' }, '④ 已落盘的差异结论（t_cost_diff · 留痕）'),
      diffs.length ? h('div', null,
        h('table', { className: 'cr-tbl', 'data-biu-testid': 'cr-diffs' },
          h('thead', null, h('tr', null, ['diff_id', '项目', '子目', '合同', '变更后', '结算', '差额', '偏差', '确认人', '时间'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, diffs.map((r, i) => h('tr', { key: i },
            h('td', { className: 'cr-meta' }, r[0]),
            h('td', null, r[1]),
            h('td', null, r[3]),
            h('td', { className: 'cr-num' }, money(r[4])),
            h('td', { className: 'cr-num' }, money(r[5])),
            h('td', { className: 'cr-num' }, money(r[6])),
            h('td', { className: 'cr-delta ' + (n1(r[7]) > 0 ? 'cr-bad' : 'cr-ok') }, money(r[7])),
            h('td', { className: 'cr-num' }, r[8] + '%'),
            h('td', { className: 'cr-meta' }, r[10]),
            h('td', { className: 'cr-meta' }, r[11]),
          ))),
        ),
        summary ? h('div', { className: 'cr-meta', style: { marginTop: 6 } }, '累计 ' + summary[0] + ' 条 · 差额合计 ' + money(summary[1]) + ' 元') : null,
      ) : h('div', { className: 'cr-empty' }, '还没有差异结论。'),

      material.length ? h('div', null,
        h('div', { className: 'cr-sec' }, '⑤ 材料信息价：本市 vs 邻市（t_material_price 的 18 行真算的）'),
        h('table', { className: 'cr-tbl' },
          h('thead', null, h('tr', null, ['材料', '本市 2026-03', '邻市 2026-03', '价差'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, material.map((r, i) => h('tr', { key: i },
            h('td', null, r[0]),
            h('td', { className: 'cr-num' }, money(r[1])),
            h('td', { className: 'cr-num' }, money(r[2])),
            h('td', { className: 'cr-num ' + (Math.abs(n1(r[3])) >= 5 ? 'cr-bad' : '') }, n1(r[3]) + '%'),
          ))),
        ),
      ) : null,
    ),
  )
}

export function apply(ctx: any) {
  ctx.pageEditor.registerBlock({
    kind: 'cost-reconcile',
    plugin: name,
    label: '造价三方对账',
    blockType: 'cost',
    blockTypeLabel: '造价',
    hint: '合同清单 / 签证变更 / 结算三张表按编码对齐算差额；写入一条签证后差异立刻重算（前后对比），并可把差异写成一行结论留痕',
    aliases: ['cost', '造价', '对账', '清单', '签证', '结算', '工程'],
    defaults: {
      proj_id: '5',
      confirmed_by: '造价组',
      conn: { host: '127.0.0.1', port: 3306, user: 'root', password: 'Abc123456', database: 'cost_demo' },
    },
    View,
  })
}
