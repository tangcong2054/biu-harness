const React = globalThis.React
const { useState, useCallback, useEffect } = React
const h = React.createElement

export const name = 'med-ruleset'
export const inject = ['pageEditor', 'uiActions']

type BlockProps = { data: Record<string, unknown>; update: (patch: Record<string, unknown>) => void; writable: boolean }

const STYLE_ID = 'med-ruleset-style-v1'
const CSS = `
.mr{margin:12px 0;border:1px solid var(--dsw-border);border-radius:10px;font-family:var(--font-sans);font-size:13.5px;color:var(--dsw-label);background:var(--dsw-bg);overflow:hidden}
.mr *{box-sizing:border-box}
.mr-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.04))}
.mr-title{font-weight:700;font-size:12.5px}
.mr-meta{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-3)}
.mr-grow{flex:1}
.mr-btn{height:27px;padding:0 11px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.mr-btn:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.mr-btn.pri{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff}
.mr-btn.sm{height:23px;padding:0 8px;font-size:12px}
.mr-btn:disabled{opacity:.5;cursor:default}
.mr-body{padding:11px 12px}
.mr-sec{font-size:12px;color:var(--dsw-label-3);margin:13px 0 6px;font-weight:650;letter-spacing:.02em}
.mr-sec:first-child{margin-top:0}
.mr-rule{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dsw-border);border-radius:8px;margin-bottom:5px}
.mr-rule.on{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 7%,transparent)}
.mr-rname{flex:1;min-width:0;font-size:13px}
.mr-cond{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-2,var(--dsw-label));background:color-mix(in srgb,var(--dsw-border) 45%,transparent);padding:1px 6px;border-radius:4px}
.mr-ver{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--dsw-pick,#4a6cf7)}
.mr-inp{width:100%;height:27px;padding:0 8px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-input,transparent);color:var(--dsw-label);font:inherit;font-size:12.5px;outline:none}
.mr-code{margin:7px 0 0;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.05));font-family:var(--font-mono);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}
.mr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.mr-card{border:1px solid var(--dsw-border);border-radius:8px;padding:8px 10px;min-width:0}
.mr-card.hi{border-color:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 50%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 7%,transparent)}
.mr-klab{font-size:11px;color:var(--dsw-label-3);margin-bottom:3px}
.mr-kval{font-family:var(--font-mono);font-size:16px;font-weight:700}
.mr-wrap{max-height:290px;overflow:auto;border:1px solid var(--dsw-border);border-radius:8px}
.mr-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.mr-tbl th{position:sticky;top:0;padding:5px 8px;border-bottom:1px solid var(--dsw-border);text-align:left;font-weight:650;color:var(--dsw-label-3);font-size:11.5px;white-space:nowrap;background:var(--dsw-bg)}
.mr-tbl td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-border) 55%,transparent);white-space:nowrap}
.mr-num{font-family:var(--font-mono);font-size:11.5px}
.mr-link{color:var(--dsw-pick,#4a6cf7);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}
.mr-box{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-border);font-size:13px;line-height:1.65}
.mr-box.ok{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-ok,#3fb950) 9%,transparent)}
.mr-box.bad{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent)}
.mr-box.wn{border-color:color-mix(in srgb,var(--dsw-warn,#d29922) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-warn,#d29922) 8%,transparent)}
.mr-empty{padding:20px 12px;border:1px dashed var(--dsw-border);border-radius:8px;color:var(--dsw-label-3);font-size:12.5px;text-align:center;line-height:1.7}
.mr-diff{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}
.mr-dchip{padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-border);font-size:11.5px;font-family:var(--font-mono)}
.mr-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0 0;font-size:12px}
.mr-step{padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-border);font-family:var(--font-mono);font-size:11.5px}
.mr-arrow{color:var(--dsw-label-3)}
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

function View(props: BlockProps) {
  useStyle()
  const { data } = props
  const ro = props.writable === false
  const conn = (data.conn as Record<string, unknown>) ?? {}
  const connQ = 'conn=' + encodeURIComponent(JSON.stringify(conn))

  const [rules, setRules] = useState<string[][]>([])
  const [ruleId, setRuleId] = useState(String(data.rule_id ?? '1'))
  const [draft, setDraft] = useState(String(data.condition_text ?? '年龄>=60 AND 收缩压>=140'))
  const [result, setResult] = useState<Record<string, any> | null>(null)
  const [published, setPublished] = useState<Record<string, any> | null>(null)
  const [runs, setRuns] = useState<string[][]>([])
  const [metrics, setMetrics] = useState<string[][]>([])
  const [recordSummary, setRecordSummary] = useState<string[] | null>(null)
  const [trace, setTrace] = useState<Record<string, any> | null>(null)
  const [traceWho, setTraceWho] = useState('P0001')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadRules = useCallback(async () => {
    const out = await getJson('/api/med-ruleset/rules?' + connQ)
    if (out.ok) setRules(out.rows as string[][])
  }, [connQ])

  const loadRuns = useCallback(async () => {
    const out = await getJson('/api/med-ruleset/runs?' + connQ)
    if (out.ok) setRuns(out.rows as string[][])
  }, [connQ])

  const loadMetrics = useCallback(async () => {
    const out = await getJson('/api/med-ruleset/metrics?' + connQ)
    if (out.ok) { setMetrics(out.rows as string[][]); setRecordSummary(out.recordSummary as string[]) }
  }, [connQ])

  const doRun = useCallback(async (cond?: string, rule?: string) => {
    setBusy(true); setErr(''); setPublished(null)
    try {
      const out = await postJson('/api/med-ruleset/run', {
        conn, rule_id: Number(rule ?? ruleId), condition_text: cond ?? draft,
        ran_by: String(data.ran_by ?? '临床数据组'),
      })
      if (!out.ok) setErr(String(out.error ?? '跑规则失败')); else setResult(out)
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, data.ran_by, draft, ruleId])

  const publish = useCallback(async () => {
    setBusy(true); setErr(''); setResult(null)
    try {
      const out = await postJson('/api/med-ruleset/publish', { conn, rule_id: Number(ruleId), condition_text: draft })
      if (!out.ok) setErr(String(out.error ?? '发布失败'))
      else { setPublished(out); await loadRules() }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, draft, loadRules, ruleId])

  const saveRun = useCallback(async () => {
    if (!result) return
    setBusy(true); setErr('')
    try {
      const out = await postJson('/api/med-ruleset/save-run', {
        conn, rule_id: result.rule_id, rule_name: result.rule_name, version: result.version,
        condition_text: result.condition_text, codes: result.codes,
        prev_count: result.prev ? result.prev.count : null,
        added: result.added, removed: result.removed,
        ran_by: String(data.ran_by ?? '临床数据组'),
      })
      if (!out.ok) setErr(String(out.error ?? '保存失败')); else await loadRuns()
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, data.ran_by, loadRuns, result])

  const loadTrace = useCallback(async (code: string) => {
    setTraceWho(code)
    const out = await getJson('/api/med-ruleset/trace?' + connQ + '&patient_code=' + encodeURIComponent(code))
    if (out.ok) setTrace(out)
  }, [connQ])

  useEffect(() => { void loadRules(); void loadRuns(); void loadMetrics(); void loadTrace('P0001') }, [loadRules, loadRuns, loadMetrics, loadTrace])

  const latestVersion = result?.version
  const prev = result?.prev
  const delta = prev ? (result.patient_count - prev.count) : null

  return h('div', { className: 'mr', 'data-biu-testid': 'med-ruleset' },
    h('div', { className: 'mr-hd' },
      h('span', { className: 'mr-title' }, '医疗口径版本'),
      h('span', { className: 'mr-meta' }, 'med_demo · 规则有版本，改阈值 = 发布新版本，能 diff 两版人数'),
      h('span', { className: 'mr-grow' }),
      h('button', { className: 'mr-btn pri', disabled: busy || ro, onClick: () => void doRun(), 'data-biu-testid': 'mr-run' }, busy ? '执行中…' : '按这条规则跑（真查患者）'),
    ),

    h('div', { className: 'mr-body' },
      err ? h('div', { className: 'mr-box bad', style: { marginBottom: 10 } }, err) : null,

      h('div', { className: 'mr-sec' }, '① 入组规则存在表里（med_demo.t_rule · 每个版本一行，老版本不删）'),
      rules.length ? h('div', null, rules.map((r) => {
        const rid = String(r[0])
        return h('div', { key: rid + '-' + r[3], className: 'mr-rule' + (rid === ruleId ? ' on' : '') },
          h('span', { className: 'mr-ver' }, 'v' + r[3]),
          h('span', { className: 'mr-rname' }, r[1]),
          h('span', { className: 'mr-cond' }, r[2]),
          h('span', { className: 'mr-meta' }, String(r[4] ?? '').slice(5, 16)),
          h('button', { className: 'mr-btn sm', disabled: busy, onClick: () => { setRuleId(rid); if (rid === '1') setDraft(r[2]) } }, '用这一条'),
        )
      })) : h('div', { className: 'mr-empty' }, '读规则中…'),

      h('div', { className: 'mr-sec' }, '② 改口径 → 发布新版本（不是改提示词，是给规则表加一行）'),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('input', { className: 'mr-inp', value: draft, disabled: ro, 'data-biu-testid': 'mr-condition', onChange: (e: any) => setDraft(e.target.value) }),
        h('button', { className: 'mr-btn', disabled: busy || ro, onClick: () => void publish(), 'data-biu-testid': 'mr-publish' }, '发布新版本'),
      ),
      h('div', { className: 'mr-meta', style: { marginTop: 5 } },
        '条件写法：字段 + 比较符 + 数字，多条件用 AND。可选字段：年龄 / 性别 / 收缩压 / 舒张压 / LDL。' +
        '不接受任意 SQL —— 字段与比较符都走白名单，值必须是数字。',
      ),

      published && published.ok ? h('div', { className: 'mr-box wn', style: { marginTop: 9 }, 'data-biu-testid': 'mr-published' },
        h('div', null, h('b', null, '✔ 已发布 v' + published.published.version), h('span', { className: 'mr-meta' }, '　' + published.published.condition_text)),
        h('table', { className: 'mr-tbl', style: { marginTop: 6 } },
          h('thead', null, h('tr', null, ['版本', '规则名', '条件', '创建时间'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, (published.versions as string[][]).map((r, i) => h('tr', { key: i },
            h('td', { className: 'mr-ver' }, 'v' + r[3]),
            h('td', null, r[1]),
            h('td', { className: 'mr-cond' }, r[2]),
            h('td', { className: 'mr-num' }, r[4]),
          ))),
        ),
        h('div', { className: 'mr-meta', style: { marginTop: 6 } }, '旧版本还在 —— 半年后有人问「当初为什么是 60 岁」，这里查得到。'),
      ) : null,

      result && result.ok ? h('div', null,
        h('div', { className: 'mr-sec' }, '③ 按 v' + result.version + ' 真跑的结果（条件是表里那一条，SQL 是插件翻出来的）'),
        h('div', { className: 'mr-cards' },
          h('div', { className: 'mr-card hi' }, h('div', { className: 'mr-klab' }, '入组人数'), h('div', { className: 'mr-kval' }, result.patient_count + ' 人')),
          h('div', { className: 'mr-card' }, h('div', { className: 'mr-klab' }, '上一版人数'), h('div', { className: 'mr-kval' }, prev ? prev.count + ' 人（v' + prev.version + '）' : '—')),
          h('div', { className: 'mr-card' + (delta === 0 || delta == null ? '' : ' hi') }, h('div', { className: 'mr-klab' }, '两版差'), h('div', { className: 'mr-kval' }, delta == null ? '—' : (delta > 0 ? '+' : '') + delta + ' 人')),
          h('div', { className: 'mr-card' }, h('div', { className: 'mr-klab' }, '查询耗时'), h('div', { className: 'mr-kval' }, result.ms + 'ms')),
        ),

        h('div', { className: 'mr-flow' },
          result.conditions.map((c: Record<string, string>, i: number) => [
            i ? h('span', { key: 'a' + i, className: 'mr-arrow' }, 'AND') : null,
            h('span', { key: 'c' + i, className: 'mr-step' }, c.field + ' ' + c.op + ' ' + c.value + '（' + c.on + '）'),
          ]),
        ),

        (result.added.length || result.removed.length) ? h('div', { className: 'mr-box wn', style: { marginTop: 9 }, 'data-biu-testid': 'mr-diff' },
          h('div', null, h('b', null, '两版人群差异')),
          h('div', { className: 'mr-diff' },
            h('span', { className: 'mr-dchip' }, '新增入组 ' + result.added.length + ' 人'),
            h('span', { className: 'mr-dchip' }, '不再入组 ' + result.removed.length + ' 人'),
          ),
          result.added.length ? h('div', { className: 'mr-meta', style: { marginTop: 5 } }, '新增：' + result.added.slice(0, 12).join('、')) : null,
          result.removed.length ? h('div', { className: 'mr-meta', style: { marginTop: 3 } }, '移除：' + result.removed.slice(0, 12).join('、')) : null,
        ) : h('div', { className: 'mr-meta', style: { marginTop: 7 } }, '和上一版相比人群没有变化。'),

        h('div', { style: { marginTop: 9, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { className: 'mr-btn', disabled: busy || ro, onClick: () => void saveRun(), 'data-biu-testid': 'mr-save-run' }, '把这次结果落成一条 run'),
          h('span', { className: 'mr-meta' }, '写入 med_demo.t_rule_run：人数 + 名单 + 与上一版的 diff'),
        ),

        h('div', { style: { marginTop: 9 } },
          h('div', { className: 'mr-meta', style: { marginBottom: 4 } }, '命中名单（点患者编号看他的指标出自哪份病历）'),
          h('div', { className: 'mr-wrap' },
            h('table', { className: 'mr-tbl', 'data-biu-testid': 'mr-patients' },
              h('thead', null, h('tr', null, (result.columns as string[]).map((c) => h('th', { key: c }, c)))),
              h('tbody', null, (result.patients as string[][]).map((r, i) => h('tr', { key: i },
                r.map((cell, j) => h('td', { key: j, className: j === 0 ? 'mr-link mr-num' : 'mr-num' },
                  j === 0 ? h('span', { onClick: () => void loadTrace(cell) }, cell) : cell)),
              ))),
            ),
          ),
        ),

        h('pre', { className: 'mr-code' }, '插件把表里的条件翻成的 SQL：\n' + String(result.sql ?? '').slice(0, 900)),
      ) : null,

      h('div', { className: 'mr-sec' }, '④ 每次跑都留痕（med_demo.t_rule_run）'),
      runs.length ? h('table', { className: 'mr-tbl', 'data-biu-testid': 'mr-runs' },
        h('thead', null, h('tr', null, ['run_id', '规则', '版本', '人数', '上一版', '新增', '移除', '执行人', '时间'].map((t) => h('th', { key: t }, t)))),
        h('tbody', null, runs.map((r, i) => h('tr', { key: i },
          h('td', { className: 'mr-num' }, r[0]),
          h('td', null, String(r[1] ?? '').slice(0, 14)),
          h('td', { className: 'mr-ver' }, 'v' + r[2]),
          h('td', { className: 'mr-num' }, r[3] + ' 人'),
          h('td', { className: 'mr-num' }, r[4] ?? '—'),
          h('td', { className: 'mr-num' }, String(r[5] ?? '').split(',').filter(Boolean).length || '—'),
          h('td', { className: 'mr-num' }, String(r[6] ?? '').split(',').filter(Boolean).length || '—'),
          h('td', { className: 'mr-meta' }, r[7]),
          h('td', { className: 'mr-num' }, r[8]),
        ))),
      ) : h('div', { className: 'mr-empty' }, '还没有 run 记录 —— 上面跑一次，再点「落成一条 run」。'),

      h('div', { className: 'mr-sec' }, '⑤ 每个值都能点回它的来源（这是「能不能过审」的那一步）'),
      trace && trace.ok ? h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 7 } },
          h('span', { className: 'mr-meta' }, '患者编号'),
          h('input', { className: 'mr-inp', style: { width: 110 }, value: traceWho, onChange: (e: any) => setTraceWho(e.target.value) }),
          h('button', { className: 'mr-btn sm', onClick: () => void loadTrace(traceWho) }, '查来源'),
          (trace.byType as string[][]).map((r, i) => h('span', { key: i, className: 'mr-dchip' }, r[0] + ' ' + r[1] + ' 份')),
        ),
        h('div', { className: 'mr-wrap', style: { maxHeight: 220 } },
          h('table', { className: 'mr-tbl', 'data-biu-testid': 'mr-trace' },
            h('thead', null, h('tr', null, ['指标', '值', '单位', '规则', '病历日期', '类型', '病历号', '来源文件'].map((t) => h('th', { key: t }, t)))),
            h('tbody', null, (trace.rows as string[][]).map((r, i) => h('tr', { key: i },
              h('td', null, r[1]),
              h('td', { className: 'mr-num' }, r[2]),
              h('td', { className: 'mr-meta' }, r[3]),
              h('td', { className: 'mr-meta' }, 'rule ' + r[4]),
              h('td', { className: 'mr-num' }, r[5]),
              h('td', { className: 'mr-meta' }, r[6]),
              h('td', { className: 'mr-meta' }, r[7]),
              h('td', { className: 'mr-meta' }, String(r[8] ?? '')),
            ))),
          ),
        ),
        h('div', { className: 'mr-meta', style: { marginTop: 6 } }, '每一个 SBP/DBP/LDL 都能指到具体哪份文件、哪张单子 —— 这不是「AI 说这个患者血压 144」，是「这份病历第几页写着 144」。'),
      ) : h('div', { className: 'mr-empty' }, '读溯源数据中…'),

      metrics.length ? h('div', null,
        h('div', { className: 'mr-sec' }, '⑥ 指标提取总览（' + (recordSummary ? recordSummary[0] + ' 份病历 / ' + recordSummary[1] + ' 个文件' : '') + '）'),
        h('table', { className: 'mr-tbl' },
          h('thead', null, h('tr', null, ['指标', '条数', '覆盖患者', '来源文件', '规则数', '均值'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, metrics.map((r, i) => h('tr', { key: i },
            h('td', null, r[0]),
            h('td', { className: 'mr-num' }, r[1]),
            h('td', { className: 'mr-num' }, r[2]),
            h('td', { className: 'mr-num' }, r[3]),
            h('td', { className: 'mr-num' }, r[4]),
            h('td', { className: 'mr-num' }, r[5]),
          ))),
        ),
      ) : null,
    ),
  )
}

export function apply(ctx: any) {
  ctx.pageEditor.registerBlock({
    kind: 'med-ruleset',
    plugin: name,
    label: '医疗口径版本',
    blockType: 'medical',
    blockTypeLabel: '医疗',
    hint: '入组规则存在表里带版本；改阈值 = 发布新版本（老版本留着）；按规则跑真查患者并与上一版 diff 人数；每个指标值可点回来源病历',
    aliases: ['med', 'medical', 'rule', '医疗', '入组', '口径', '溯源'],
    defaults: {
      rule_id: '1',
      condition_text: '年龄>=60 AND 收缩压>=140',
      ran_by: '临床数据组',
      conn: { host: '127.0.0.1', port: 3306, user: 'root', password: 'Abc123456', database: 'med_demo' },
    },
    View,
  })
}
