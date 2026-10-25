const React = globalThis.React
const { useState, useCallback, useEffect } = React
const h = React.createElement

export const name = 'audit-findings'
export const inject = ['pageEditor', 'uiActions']

type BlockProps = { data: Record<string, unknown>; update: (patch: Record<string, unknown>) => void; writable: boolean }

const STYLE_ID = 'audit-findings-style-v1'
const CSS = `
.af{margin:12px 0;border:1px solid var(--dsw-border);border-radius:10px;font-family:var(--font-sans);font-size:13.5px;color:var(--dsw-label);background:var(--dsw-bg);overflow:hidden}
.af *{box-sizing:border-box}
.af-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.04))}
.af-title{font-weight:700;font-size:12.5px}
.af-meta{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-3)}
.af-grow{flex:1}
.af-btn{height:27px;padding:0 11px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.af-btn:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.af-btn.pri{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff}
.af-btn.sm{height:23px;padding:0 8px;font-size:12px}
.af-btn:disabled{opacity:.5;cursor:default}
.af-body{padding:11px 12px}
.af-sec{font-size:12px;color:var(--dsw-label-3);margin:12px 0 6px;font-weight:650;letter-spacing:.02em}
.af-sec:first-child{margin-top:0}
.af-rule{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dsw-border);border-radius:8px;margin-bottom:5px}
.af-rule.on{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 7%,transparent)}
.af-chk{flex:none;width:14px;height:14px;accent-color:var(--dsw-pick,#4a6cf7)}
.af-rname{flex:1;min-width:0;font-size:13px}
.af-risk{flex:none;padding:1px 7px;border-radius:999px;font-size:11px;font-family:var(--font-mono);border:1px solid var(--dsw-border)}
.af-risk.high{color:var(--dsw-danger,#d9534f);border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border))}
.af-risk.mid{color:var(--dsw-warn,#d29922);border-color:color-mix(in srgb,var(--dsw-warn,#d29922) 45%,var(--dsw-border))}
.af-ver{flex:none;font-family:var(--font-mono);font-size:11px;color:var(--dsw-label-3)}
.af-hit{border:1px solid var(--dsw-border);border-radius:8px;margin-bottom:6px;overflow:hidden}
.af-hit-hd{display:flex;align-items:center;gap:8px;padding:7px 9px;background:var(--dsw-surface,rgba(127,127,127,.04))}
.af-hit-sub{font-weight:650;font-size:13px;flex:none;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.af-hit-det{flex:1;min-width:0;font-size:12px;color:var(--dsw-label-2,var(--dsw-label));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.af-amt{flex:none;font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:var(--dsw-danger,#d9534f)}
.af-hit-bd{padding:8px 10px;border-top:1px solid var(--dsw-border)}
.af-code{margin:0 0 7px;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.05));font-family:var(--font-mono);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}
.af-inp{width:100%;height:26px;padding:0 8px;margin-bottom:6px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-input,transparent);color:var(--dsw-label);font:inherit;font-size:12.5px;outline:none}
.af-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.af-tbl th{padding:5px 8px;border-bottom:1px solid var(--dsw-border);text-align:left;font-weight:650;color:var(--dsw-label-3);font-size:11.5px;white-space:nowrap}
.af-tbl td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-border) 55%,transparent)}
.af-num{font-family:var(--font-mono);font-size:11.5px;white-space:nowrap}
.af-bad{color:var(--dsw-danger,#d9534f)}
.af-ok{color:var(--dsw-ok,#3fb950)}
.af-box{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-border);font-size:13px;line-height:1.65}
.af-box.ok{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-ok,#3fb950) 9%,transparent)}
.af-box.bad{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent)}
.af-empty{padding:22px 12px;border:1px dashed var(--dsw-border);border-radius:8px;color:var(--dsw-label-3);font-size:12.5px;text-align:center;line-height:1.7}
.af-diff{display:flex;gap:10px;flex-wrap:wrap;margin-top:7px}
.af-dchip{padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-border);font-size:11.5px;font-family:var(--font-mono)}
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

  const [rules, setRules] = useState<string[][]>([])
  const [on, setOn] = useState<number[]>([1, 2, 3, 4])
  const [run, setRun] = useState<Record<string, any> | null>(null)
  const [open, setOpen] = useState<string>('')
  const [sqlOf, setSqlOf] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, any> | null>(null)
  const [findings, setFindings] = useState<string[][]>([])
  const [summary, setSummary] = useState<string[] | null>(null)
  const [contrast, setContrast] = useState<Record<string, any> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const connQ = 'conn=' + encodeURIComponent(JSON.stringify(conn))
  const who = String(data.confirmed_by ?? '审计一组（李）')

  const loadRules = useCallback(async () => {
    const out = await getJson('/api/audit-findings/rules?' + connQ)
    if (out.ok) setRules(out.rows as string[][])
    else setErr(String(out.error ?? ''))
  }, [connQ])

  const loadFindings = useCallback(async () => {
    const out = await getJson('/api/audit-findings/findings?' + connQ + '&limit=15')
    if (out.ok) { setFindings(out.rows as string[][]); setSummary(out.summary as string[]) }
  }, [connQ])

  const doRun = useCallback(async () => {
    setBusy(true); setErr(''); setSaved(null)
    try {
      const out = await postJson('/api/audit-findings/run', { conn, rule_ids: on })
      if (!out.ok) setErr(String(out.error ?? '跑规则失败'))
      else setRun(out)
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, on])

  const loadSql = useCallback(async (ruleId: number) => {
    const out = await getJson('/api/audit-findings/rule-sql?' + connQ + '&rule_id=' + ruleId)
    if (out.ok && out.row) setSqlOf((prev) => ({ ...prev, [ruleId]: String(out.row[0] ?? '') }))
  }, [connQ])

  const confirm = useCallback(async (hit: Record<string, any>) => {
    setBusy(true); setErr('')
    try {
      const out = await postJson('/api/audit-findings/confirm', {
        conn, confirmed_by: who,
        items: [{ ...hit, conclusion: notes[hit.fingerprint] || '已核对，待整改' }],
      })
      if (!out.ok) setErr(String(out.error ?? '落底稿失败'))
      else { setSaved({ ...out, subject: hit.subject }); void loadFindings() }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, loadFindings, notes, who])

  useEffect(() => { void loadRules(); void loadFindings() }, [loadRules, loadFindings])
  useEffect(() => {
    getJson('/api/audit-findings/contrast?' + connQ).then((out) => { if (out.ok) setContrast(out) }).catch(() => undefined)
  }, [connQ])

  const hits: Array<Record<string, any>> = run?.hits ?? []
  const riskCls = (risk: string) => (risk === '高' ? 'af-risk high' : 'af-risk mid')

  return h('div', { className: 'af', 'data-biu-testid': 'audit-findings' },
    h('div', { className: 'af-hd' },
      h('span', { className: 'af-title' }, '审计发现底稿'),
      h('span', { className: 'af-meta' }, 'audit_demo · 规则存在表里，跑规则是真执行 SQL'),
      h('span', { className: 'af-grow' }),
      h('button', { className: 'af-btn pri', disabled: busy || ro, onClick: () => void doRun(), 'data-biu-testid': 'af-run' }, busy ? '跑规则中…' : '跑选中的规则'),
    ),

    h('div', { className: 'af-body' },
      err ? h('div', { className: 'af-box bad', style: { marginBottom: 10 } }, err) : null,

      h('div', { className: 'af-sec' }, '① 规则是表里的数据（audit_demo.t_audit_rule · 有 rule_id、version、owner）'),
      rules.length ? h('div', null, rules.map((r) => {
        const ruleId = Number(r[0])
        const picked = on.includes(ruleId)
        return h('div', { key: ruleId, className: 'af-rule' + (picked ? ' on' : '') },
          h('input', { className: 'af-chk', type: 'checkbox', checked: picked, disabled: ro, onChange: () => setOn(picked ? on.filter((n) => n !== ruleId) : [...on, ruleId]) }),
          h('span', { className: 'af-rname' }, r[1]),
          h('span', { className: riskCls(String(r[2])) }, String(r[2])),
          h('span', { className: 'af-ver' }, 'v' + r[3]),
          h('span', { className: 'af-ver' }, r[4] ?? ''),
          h('button', { className: 'af-btn sm', onClick: () => { const id = ruleId; if (open === String(id)) { setOpen(''); return } setOpen(String(id)); if (!sqlOf[id]) void loadSql(id) } }, '看规则原文'),
        )
      })) : h('div', { className: 'af-empty' }, '读规则中…'),

      open ? h('pre', { className: 'af-code', style: { marginTop: 4 } }, sqlOf[Number(open)] ?? '读取中…') : null,

      run ? h('div', null,
        h('div', { className: 'af-sec' }, '② 跑规则的结果 —— ' + hits.length + ' 条命中，合计 ' + money(run.totalAmount) + ' 元'),
        h('div', { className: 'af-meta', style: { marginBottom: 8 } },
          (run.rules as Array<Record<string, any>>).map((r) => r.rule_name + ' → ' + r.hit + ' 条/' + r.ms + 'ms' + (r.ok ? '' : '（失败）')).join('　·　'),
        ),
        hits.length ? hits.map((hit) => {
          const fp = String(hit.fingerprint)
          const isOpen = open === fp
          return h('div', { key: fp, className: 'af-hit' },
            h('div', { className: 'af-hit-hd' },
              h('span', { className: 'af-hit-sub' }, String(hit.subject)),
              h('span', { className: 'af-hit-det' }, String(hit.detail ?? '').slice(0, 90)),
              h('span', { className: 'af-amt' }, money(hit.amount)),
              h('button', { className: 'af-btn sm', onClick: () => setOpen(isOpen ? '' : fp) }, isOpen ? '收起' : '展开'),
            ),
            isOpen ? h('div', { className: 'af-hit-bd' },
              h('div', { className: 'af-meta', style: { marginBottom: 6 } },
                '规则：' + hit.rule_name + '　v' + hit.rule_version + ' ｜ 指纹 ' + fp + ' ｜ 证据：' + hit.cnt + ' 张 / ' + money(hit.amount) + ' 元'),
              h('pre', { className: 'af-code' }, '命中条件：' + String(hit.rule_hit) + '\n明细：' + String(hit.detail)),
              h('input', { className: 'af-inp', placeholder: '写一句结论（会一起落到底稿里）', value: notes[fp] ?? '', disabled: ro, onChange: (e: any) => setNotes({ ...notes, [fp]: e.target.value }) }),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', { className: 'af-btn pri sm', disabled: busy || ro, onClick: () => void confirm(hit), 'data-biu-testid': 'af-confirm' }, '确认并落底稿'),
                h('span', { className: 'af-meta' }, '写入 audit_demo.t_audit_finding，带规则版本 + 指纹 + 确认人 + 时间'),
              ),
            ) : null,
          )
        }) : h('div', { className: 'af-empty' }, '这次的规则一条都没命中。'),

        h('div', { className: 'af-sec' }, '③ 和上一次重跑的 diff（指纹比对）'),
        h('div', { className: 'af-diff' },
          h('span', { className: 'af-dchip' }, '本次命中 ' + hits.length),
          h('span', { className: 'af-dchip', style: { color: 'var(--dsw-danger,#d9534f)' } }, '新增待复核 ' + (run.diff?.fresh?.length ?? 0)),
          h('span', { className: 'af-dchip' }, '上次有本次没有 ' + (run.diff?.gone?.length ?? 0)),
          h('span', { className: 'af-dchip', style: { color: 'var(--dsw-ok,#3fb950)' } }, '已落底稿 ' + (summary ? summary[0] : 0) + ' 条'),
        ),
        run.diff?.fresh?.length ? h('div', { className: 'af-meta', style: { marginTop: 5 } }, '新增：' + run.diff.fresh.slice(0, 6).join('、')) : null,
      ) : h('div', { className: 'af-empty' }, '点右上「跑选中的规则」—— 这会把规则表里的 SQL 真跑到 t_invoice 上。'),

      saved && saved.ok ? h('div', { className: 'af-box ok', style: { marginTop: 10 }, 'data-biu-testid': 'af-saved' },
        h('div', null, h('b', null, '✔ 已落底稿 1 条'), h('span', { className: 'af-meta' }, '　表 audit_demo.t_audit_finding · finding_id=' + (saved.findings?.[0]?.[0] ?? ''))),
        h('pre', { className: 'af-code', style: { marginTop: 6 } }, '真实执行的 SQL：\n' + String(saved.wrote ?? '').slice(0, 600)),
      ) : null,

      h('div', { className: 'af-sec' }, '④ 底稿留痕（换个页面、换个人打开，这里的东西还在）'),
      findings.length ? h('table', { className: 'af-tbl', 'data-biu-testid': 'af-findings' },
        h('thead', null, h('tr', null, ['finding_id', '规则', 'v', '对象', '金额', '结论', '确认人', '时间'].map((t) => h('th', { key: t }, t)))),
        h('tbody', null, findings.map((r, i) => h('tr', { key: i },
          h('td', { className: 'af-num' }, r[0]),
          h('td', null, String(r[1] ?? '').slice(0, 22)),
          h('td', { className: 'af-num' }, r[2]),
          h('td', null, String(r[3] ?? '').slice(0, 20)),
          h('td', { className: 'af-amt', style: { color: 'inherit' } }, money(r[4])),
          h('td', { className: 'af-meta' }, String(r[5] ?? '').slice(0, 24)),
          h('td', { className: 'af-meta' }, r[6]),
          h('td', { className: 'af-num' }, r[7]),
        ))),
      ) : h('div', { className: 'af-empty' }, '还没有底稿 —— 上面展开一条命中，写结论、点「确认并落底稿」。'),
      summary ? h('div', { className: 'af-meta', style: { marginTop: 6 } }, '累计底稿 ' + summary[0] + ' 条 · 合计 ' + money(summary[1]) + ' 元 · 覆盖 ' + summary[2] + ' 条规则') : null,

      contrast && contrast.ok ? h('div', { className: 'af-sec' }, '⑤ 为什么「单张都能查，合起来查不出来」——现场真跑的两组数') : null,
      contrast && contrast.ok ? h('div', null,
        h('table', { className: 'af-tbl' },
          h('thead', null, h('tr', null, ['看单张：全部发票', '张数', '单张最大', '单张平均'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, (contrast.single as string[][]).map((r, i) => h('tr', { key: i },
            h('td', null, '当前库里的 ' + r[0] + ' 张发票'),
            h('td', { className: 'af-num' }, r[0]),
            h('td', { className: 'af-num' }, money(r[1])),
            h('td', { className: 'af-num' }, money(r[2])),
          ))),
        ),
        h('div', { className: 'af-meta', style: { margin: '6px 0' } }, '每张单子都合规 —— 所以单张规则引擎一个都不报。但把记录合起来看：'),
        h('table', { className: 'af-tbl' },
          h('thead', null, h('tr', null, ['看模式：同一供应商同一天', '日期', '同日张数', '同日合计'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, (contrast.pattern as string[][]).map((r, i) => h('tr', { key: i },
            h('td', null, r[0]),
            h('td', { className: 'af-num' }, r[1]),
            h('td', { className: 'af-num af-bad' }, r[2]),
            h('td', { className: 'af-amt', style: { color: 'inherit' } }, money(r[3])),
          ))),
        ),
        h('div', { className: 'af-meta', style: { marginTop: 6 } }, '上面两张表是同一个时刻、同一个库跑出来的 —— 差别不在 AI 会不会看，在「它看的是记录还是对话」。'),
      ) : null,
    ),
  )
}

export function apply(ctx: any) {
  ctx.pageEditor.registerBlock({
    kind: 'audit-findings',
    plugin: name,
    label: '审计发现底稿',
    blockType: 'audit',
    blockTypeLabel: '审计',
    hint: '规则从表里读（有版本），跑规则真执行 SQL，每条命中带证据可展开；「确认并落底稿」把结论写成一行（带规则版本/指纹/确认人/时间），重跑自动 diff',
    aliases: ['audit', 'finding', '审计', '底稿', '凭证', '发票', '规则'],
    defaults: {
      confirmed_by: '审计一组（李）',
      conn: { host: '127.0.0.1', port: 3306, user: 'root', password: 'Abc123456', database: 'audit_demo' },
    },
    View,
  })
}
