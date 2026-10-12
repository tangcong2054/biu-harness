const React = globalThis.React
const { useState, useCallback, useEffect, useRef } = React
const h = React.createElement

export const name = 'edu-classboard'
export const inject = ['pageEditor', 'uiActions']

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}

const STYLE_ID = 'edu-classboard-style-v1'
const CSS = `
.ecb{margin:12px 0;border:1px solid var(--dsw-border);border-radius:10px;font-family:var(--font-sans);font-size:13.5px;color:var(--dsw-label);background:var(--dsw-bg);overflow:hidden}
.ecb *{box-sizing:border-box}
.ecb-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.04))}
.ecb-lab{font-size:12px;color:var(--dsw-label-3)}
.ecb-sel,.ecb-inp{height:26px;padding:0 7px;border:1px solid var(--dsw-border);border-radius:6px;background:var(--dsw-input,transparent);color:var(--dsw-label);font:inherit;font-size:12.5px;outline:none}
.ecb-tab{height:26px;padding:0 11px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label-2,var(--dsw-label));font:inherit;font-size:12.5px;cursor:pointer}
.ecb-tab.on{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff;font-weight:650}
.ecb-btn{height:27px;padding:0 11px;border:1px solid var(--dsw-border);border-radius:6px;background:transparent;color:var(--dsw-label);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.ecb-btn:hover{background:var(--dsw-hover,rgba(127,127,127,.08))}
.ecb-btn.pri{border-color:var(--dsw-pick,#4a6cf7);background:var(--dsw-pick,#4a6cf7);color:#fff}
.ecb-btn:disabled{opacity:.5;cursor:default}
.ecb-btn.sm{height:23px;padding:0 8px;font-size:12px}
.ecb-grow{flex:1}
.ecb-body{padding:11px 12px}
.ecb-meta{font-family:var(--font-mono);font-size:11.5px;color:var(--dsw-label-3)}
.ecb-stem{margin:2px 0 10px;font-size:15px;line-height:1.6;font-weight:600}
.ecb-tags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px}
.ecb-tag{padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-border);font-size:11px;color:var(--dsw-label-3);font-family:var(--font-mono)}
.ecb-opt{display:flex;gap:9px;align-items:flex-start;width:100%;margin-bottom:6px;padding:8px 10px;border:1px solid var(--dsw-border);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.ecb-opt:hover{border-color:var(--dsw-pick,#4a6cf7)}
.ecb-opt.on{border-color:var(--dsw-pick,#4a6cf7);background:color-mix(in srgb,var(--dsw-pick,#4a6cf7) 10%,transparent)}
.ecb-opt.ok{border-color:var(--dsw-ok,#3fb950);background:color-mix(in srgb,var(--dsw-ok,#3fb950) 12%,transparent)}
.ecb-opt.bad{border-color:var(--dsw-danger,#d9534f);background:color-mix(in srgb,var(--dsw-danger,#d9534f) 10%,transparent)}
.ecb-key{flex:none;width:20px;height:20px;border-radius:5px;border:1px solid var(--dsw-border);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:11.5px;font-weight:700}
.ecb-res{margin-top:10px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-border);font-size:13px;line-height:1.65}
.ecb-res.ok{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-ok,#3fb950) 9%,transparent)}
.ecb-res.bad{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 45%,var(--dsw-border));background:color-mix(in srgb,var(--dsw-danger,#d9534f) 8%,transparent)}
.ecb-mono{font-family:var(--font-mono);font-size:11.5px}
.ecb-code{margin:7px 0 0;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-border);background:var(--dsw-surface,rgba(127,127,127,.05));font-family:var(--font-mono);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:var(--dsw-label-2,var(--dsw-label))}
.ecb-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.ecb-tbl th{padding:5px 8px;border-bottom:1px solid var(--dsw-border);text-align:left;font-weight:650;color:var(--dsw-label-3);font-size:11.5px;white-space:nowrap}
.ecb-tbl td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-border) 55%,transparent)}
.ecb-bar0{position:relative;height:14px;border-radius:3px;background:color-mix(in srgb,var(--dsw-border) 60%,transparent);min-width:88px;overflow:hidden}
.ecb-bar1{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.ecb-num{font-family:var(--font-mono);font-size:11.5px;white-space:nowrap}
.ecb-warn{color:var(--dsw-danger,#d9534f)}
.ecb-okc{color:var(--dsw-ok,#3fb950)}
.ecb-grp{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.ecb-gcard{border:1px solid var(--dsw-border);border-radius:8px;padding:8px 9px;min-width:0}
.ecb-gcard.g1{border-color:color-mix(in srgb,var(--dsw-danger,#d9534f) 42%,var(--dsw-border))}
.ecb-gcard.g3{border-color:color-mix(in srgb,var(--dsw-ok,#3fb950) 42%,var(--dsw-border))}
.ecb-ghead{display:flex;align-items:center;gap:6px;font-weight:650;font-size:12px;margin-bottom:5px}
.ecb-chips{display:flex;flex-wrap:wrap;gap:3px}
.ecb-chip{padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-border) 50%,transparent);font-family:var(--font-mono);font-size:10.5px}
.ecb-empty{padding:22px 12px;border:1px dashed var(--dsw-border);border-radius:8px;color:var(--dsw-label-3);font-size:12.5px;text-align:center;line-height:1.7}
.ecb-hd{padding:7px 10px;border-bottom:1px solid var(--dsw-border);display:flex;align-items:center;gap:7px;flex-wrap:wrap;background:var(--dsw-surface,rgba(127,127,127,.04))}
.ecb-title{font-weight:700;font-size:12.5px}
.ecb-sec{font-size:12px;color:var(--dsw-label-3);margin:11px 0 5px;font-weight:650;letter-spacing:.02em}
.ecb-hist{max-height:190px;overflow:auto;border:1px solid var(--dsw-border);border-radius:8px}
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

function tone(acc: number) {
  if (acc < 45) return 'var(--dsw-danger,#d9534f)'
  if (acc < 65) return 'var(--dsw-warn,#d29922)'
  return 'var(--dsw-ok,#3fb950)'
}

function n1(v: unknown) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function getJson(url: string) {
  const res = await fetch(url)
  return (await res.json()) as Record<string, any>
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await res.json()) as Record<string, any>
}

function View(props: BlockProps) {
  useStyle()
  const { data, update } = props
  const ro = props.writable === false

  const [tab, setTab] = useState<'student' | 'teacher'>(String(data.tab ?? 'student') as 'student' | 'teacher')
  const [conn, setConn] = useState<Record<string, unknown>>((data.conn as Record<string, unknown>) ?? {})
  const [className, setClassName] = useState(String(data.class_name ?? '数二A班'))
  const [student, setStudent] = useState(String(data.student_name ?? '数二A班01'))
  const [roster, setRoster] = useState<string[]>([])

  const [q, setQ] = useState<Record<string, any> | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<Record<string, any> | null>(null)
  const [hist, setHist] = useState<string[][]>([])
  const [stat, setStat] = useState<Record<string, any> | null>(null)
  const [plan, setPlan] = useState<Record<string, any> | null>(null)
  const t0 = useRef(Date.now())

  const connQ = encodeURIComponent(JSON.stringify(conn))

  useEffect(() => {
    fetch('/api/edu-classboard/health').then((r) => r.json()).catch(() => undefined)
  }, [])

  const loadRoster = useCallback(async () => {
    const out = await getJson('/api/edu-classboard/roster?' + new URLSearchParams({ conn: JSON.stringify(conn), class: className }).toString())
    if (out.ok) {
      const names = (out.rows as string[][]).map((r) => r[0])
      setRoster(names)
      if (names.length && !names.includes(student)) setStudent(names[0])
    }
  }, [conn, className, student])

  const loadNext = useCallback(async (kpId?: number) => {
    setErr(''); setRes(null); setPick(''); setBusy(true)
    try {
      const p = new URLSearchParams({ conn: JSON.stringify(conn), class: className, student })
      if (kpId) p.set('kp_id', String(kpId))
      const out = await getJson('/api/edu-classboard/next?' + p.toString())
      if (!out.ok) { setErr(String(out.error ?? '取题失败')); setQ(null) } else { setQ(out.question); t0.current = Date.now() }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, className, student])

  const submit = useCallback(async () => {
    if (!q || !pick) return
    setBusy(true); setErr('')
    try {
      const out = await postJson('/api/edu-classboard/submit', {
        conn, class_name: className, student_name: student, q_id: q.q_id, answer: pick,
        elapsed_ms: Date.now() - t0.current,
      })
      if (!out.ok) setErr(String(out.error ?? '提交失败'))
      else { setRes(out); setQ({ ...q, options: q.options }) }
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, className, student, q, pick])

  const loadHist = useCallback(async () => {
    const out = await getJson('/api/edu-classboard/history?' + new URLSearchParams({ conn: JSON.stringify(conn), student, limit: '12' }).toString())
    if (out.ok) setHist(out.rows as string[][])
  }, [conn, student])

  const loadStat = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const out = await getJson('/api/edu-classboard/stats?' + new URLSearchParams({ conn: JSON.stringify(conn), class: className }).toString())
      if (!out.ok) setErr(String(out.error ?? '统计失败'))
      else setStat(out)
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, className])

  const writePlan = useCallback(async () => {
    if (!stat) return
    setBusy(true); setErr('')
    try {
      const weak = (stat.kp as string[][]).slice(0, 3)
      const rows = weak.map((row, i) => {
        const acc = n1(row[5])
        const lo = n1(stat.lo) || 60
        const hi = n1(stat.hi) || 75
        const g = acc < lo ? '重讲' : acc < hi ? '巩固' : '跳过'
        const bucket = (stat.groups as Record<string, string[]>)[g] ?? []
        return {
          kp_id: n1(row[0]), kp_name: row[1], acc,
          target_group: g,
          students: bucket.length ? bucket : ((stat.groups as Record<string, string[]>).重讲 ?? []),
          note: '全班正确率 ' + acc + '%，' + (g === '重讲' ? '整节重讲' : g === '巩固' ? '随堂巩固' : '跳过，留给自学'),
        }
      })
      const out = await postJson('/api/edu-classboard/plan', {
        conn, class_name: className, rows, confirmed_by: String(data.confirmed_by ?? '教研组'),
      })
      if (!out.ok) setErr(String(out.error ?? '写计划失败'))
      else setPlan(out)
    } catch (e) { setErr(String(e)) }
    setBusy(false)
  }, [conn, className, data.confirmed_by, stat])

  useEffect(() => { void loadRoster() }, [loadRoster])
  useEffect(() => { if (tab === 'student') { void loadNext(); void loadHist() } else { void loadStat() } }, [tab, className, student, loadNext, loadHist, loadStat])

  function setTabAnd(kind: 'student' | 'teacher') {
    setTab(kind); update({ tab: kind })
  }

  const g = (stat?.groups ?? {}) as Record<string, string[]>
  const gcards: Array<[string, string[], string]> = [
    ['重讲', g.重讲 ?? [], 'g1'],
    ['巩固', g.巩固 ?? [], 'g2'],
    ['跳过', g.跳过 ?? [], 'g3'],
  ]

  const kpRows = stat
    ? (stat.kp as string[][]).map((r, i) => {
        const acc = n1(r[5])
        const kpid = n1(r[0])
        return h('tr', { key: i },
          h('td', { style: { fontWeight: i < 3 ? 700 : 400 } }, r[1]),
          h('td', { className: 'ecb-meta' }, r[2]),
          h('td', { className: 'ecb-num' }, r[3]),
          h('td', { className: 'ecb-num' }, r[4]),
          h('td', null, h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('div', { className: 'ecb-bar0' }, h('div', { className: 'ecb-bar1', style: { width: acc + '%', background: tone(acc) } })),
            h('span', { className: 'ecb-num', style: { color: tone(acc), fontWeight: 700 } }, acc + '%'))),
          h('td', null, h('button', { className: 'ecb-btn sm', disabled: busy, title: '让这个学生做一道这个知识点的题', onClick: () => { setTabAnd('student'); void loadNext(kpid) } }, '练这道')),
        )
      })
    : []

  const kpSection = stat ? h('div', null,
    h('div', { className: 'ecb-sec' }, '① 知识点正确率（' + stat.class_name + ' · 按正确率升序，最弱在最前）'),
    h('table', { className: 'ecb-tbl', 'data-biu-testid': 'ecb-kp' },
      h('thead', null, h('tr', null, ['知识点', '章节', '题数', '作答次数', '正确率', ''].map((t) => h('th', { key: t }, t)))),
      h('tbody', null, kpRows),
    ),
    h('div', { className: 'ecb-meta', style: { marginTop: 5 } },
      '这些数是 COUNT(a.attempt_id) + AVG(a.correct) 从 t_attempt 里算出来的，不是估的 —— 学生交一次答案，这里立刻变。'),
  ) : null

  const groupSection = stat ? h('div', null,
    h('div', { className: 'ecb-sec' }, '② 按学生正确率自动分组（阈值 ' + stat.thresholds.重讲 + ' / ' + stat.thresholds.巩固 + ' / ' + stat.thresholds.跳过 + '）'),
    h('div', { className: 'ecb-grp' }, gcards.map(([label, names, cls]) => h('div', { key: label, className: 'ecb-gcard ' + cls },
      h('div', { className: 'ecb-ghead' }, h('span', null, label), h('span', { className: 'ecb-meta' }, names.length + ' 人')),
      h('div', { className: 'ecb-chips' }, names.slice(0, 20).map((nm) => h('span', { key: nm, className: 'ecb-chip' }, nm))),
      !names.length ? h('div', { className: 'ecb-meta' }, '（无人）') : null,
    ))),
  ) : null

  const planSection = stat ? h('div', null,
    h('div', { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('button', { className: 'ecb-btn pri', disabled: busy || ro, onClick: () => void writePlan(), 'data-biu-testid': 'ecb-write-plan' }, busy ? '写入中…' : '写下备课计划（真实写入）'),
      h('span', { className: 'ecb-meta' }, '把最弱的 3 个知识点的分组结论，各写成 edu_demo.t_group_plan 的一行'),
    ),
    plan && plan.ok ? h('div', { className: 'ecb-res ok', 'data-biu-testid': 'ecb-plan-result' },
      h('div', null, h('b', null, '✔ 已写入 ' + plan.written + ' 条备课计划'), h('span', { className: 'ecb-meta' }, '　表 edu_demo.t_group_plan')),
      h('table', { className: 'ecb-tbl', style: { marginTop: 6 } },
        h('thead', null, h('tr', null, ['plan_id', '知识点', '正确率', '分组', '学生', '确认人', '时间'].map((t) => h('th', { key: t }, t)))),
        h('tbody', null, (plan.plans as string[][]).map((r, i) => h('tr', { key: i },
          h('td', { className: 'ecb-num' }, r[0]),
          h('td', null, r[1]),
          h('td', { className: 'ecb-num' }, r[2] + '%'),
          h('td', null, r[3]),
          h('td', { className: 'ecb-meta' }, String(r[4] ?? '').slice(0, 46)),
          h('td', null, r[5]),
          h('td', { className: 'ecb-num' }, String(r[6] ?? '').slice(5, 16)),
        ))),
      ),
      h('div', { className: 'ecb-meta', style: { marginTop: 6 } }, '这几行不会随对话消失 —— 换个页面、换个人打开，都还在。'),
    ) : null,
  ) : null

  return h('div', { className: 'ecb', 'data-biu-testid': 'edu-classboard' },
    h('div', { className: 'ecb-hd' },
      h('span', { className: 'ecb-title' }, '教育答题与学情'),
      h('span', { className: 'ecb-meta' }, 'edu_demo · 真实 MySQL'),
      h('span', { className: 'ecb-grow' }),
      h('button', { className: 'ecb-tab' + (tab === 'student' ? ' on' : ''), onClick: () => setTabAnd('student'), 'data-biu-testid': 'ecb-tab-student' }, '学生视角 · 答题'),
      h('button', { className: 'ecb-tab' + (tab === 'teacher' ? ' on' : ''), onClick: () => setTabAnd('teacher'), 'data-biu-testid': 'ecb-tab-teacher' }, '老师视角 · 学情'),
    ),

    h('div', { className: 'ecb-bar' },
      h('span', { className: 'ecb-lab' }, '班级'),
      h('select', { className: 'ecb-sel', value: className, onChange: (e: any) => setClassName(e.target.value), 'data-biu-testid': 'ecb-class' },
        ['数二A班', '数一A班', '数一B班'].map((c) => h('option', { key: c, value: c }, c))),
      h('span', { className: 'ecb-lab' }, '学生'),
      h('select', { className: 'ecb-sel', value: student, onChange: (e: any) => setStudent(e.target.value), 'data-biu-testid': 'ecb-student' },
        (roster.length ? roster : [student]).map((s) => h('option', { key: s, value: s }, s))),
      h('span', { className: 'ecb-grow' }),
      tab === 'student'
        ? h('button', { className: 'ecb-btn sm', disabled: busy, onClick: () => void loadNext(), 'data-biu-testid': 'ecb-next' }, '换一题')
        : h('button', { className: 'ecb-btn sm', disabled: busy, onClick: () => void loadStat(), 'data-biu-testid': 'ecb-refresh' }, '重算学情'),
    ),

    h('div', { className: 'ecb-body' },
      err ? h('div', { className: 'ecb-res bad', style: { marginBottom: 10 } }, err) : null,

      tab === 'student' ? h('div', null,
        q ? h('div', null,
          h('div', { className: 'ecb-tags' },
            h('span', { className: 'ecb-tag' }, '题号 q_id=' + q.q_id),
            h('span', { className: 'ecb-tag' }, q.chapter + ' / ' + q.kp_name),
            h('span', { className: 'ecb-tag' }, '难度 ' + q.difficulty),
            h('span', { className: 'ecb-tag' }, String(q.source ?? '')),
            q.difficulty && h('span', { className: 'ecb-tag', style: { color: 'var(--dsw-pick,#4a6cf7)' } }, '本班最弱知识点优先'),
          ),
          h('div', { className: 'ecb-stem' }, String(q.stem ?? '')),
          (q.options as Array<{ key: string; text: string }>).map((opt) => {
            const cls = res
              ? (opt.key === res.correct_answer ? 'ecb-opt ok' : opt.key === pick && !res.correct ? 'ecb-opt bad' : 'ecb-opt')
              : ('ecb-opt' + (pick === opt.key ? ' on' : ''))
            return h('button', { key: opt.key, className: cls, disabled: Boolean(res) || ro, onClick: () => setPick(opt.key) },
              h('span', { className: 'ecb-key' }, opt.key),
              h('span', null, opt.text))
          }),
          !res ? h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { className: 'ecb-btn pri', disabled: !pick || busy || ro, onClick: () => void submit(), 'data-biu-testid': 'ecb-submit' }, busy ? '提交中…' : '提交答案'),
            h('span', { className: 'ecb-meta' }, pick ? '已选 ' + pick : '先选一个选项'),
          ) : null,

          res ? h('div', { className: 'ecb-res ' + (res.correct ? 'ok' : 'bad'), 'data-biu-testid': 'ecb-result' },
            h('div', null,
              h('b', null, res.correct ? '✔ 回答正确' : '✘ 回答错误'),
              h('span', { className: 'ecb-meta' }, '　正确答案 ' + res.correct_answer + '，你选了 ' + res.answer + '，用时 ' + res.answer_seconds + ' 秒'),
            ),
            h('div', { className: 'ecb-meta', style: { marginTop: 4 } },
              '这一条作答已经写进 edu_demo.t_attempt —— ',
              h('b', { style: { color: 'var(--dsw-pick,#4a6cf7)' } }, 'attempt_id = ' + res.attempt_id),
              '（' + res.student.name + ' 的第 ' + res.student.total + ' 次作答，累计正确率 ' + res.student.acc + '%）',
            ),
            h('pre', { className: 'ecb-code' }, '真实执行的 SQL：\n' + String(res.wrote ?? '')),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
              h('button', { className: 'ecb-btn pri', disabled: busy, onClick: () => void loadNext() }, '下一题 →'),
              h('button', { className: 'ecb-btn', disabled: busy, onClick: () => void loadNext(q.kp_id), title: '换个知识点' }, '换知识点'),
            ),
          ) : null,
        ) : h('div', { className: 'ecb-empty' }, busy ? '取题中…' : '点右上「换一题」取一道题。'),

        h('div', { className: 'ecb-sec' }, '这个学生的作答历史（t_attempt 里真实的行）'),
        hist.length
          ? h('div', { className: 'ecb-hist' }, h('table', { className: 'ecb-tbl' },
              h('thead', null, h('tr', null, ['#', '题目', '知识点', '对错', '用时', '日期'].map((t) => h('th', { key: t }, t)))),
              h('tbody', null, hist.map((r, i) => h('tr', { key: i },
                h('td', { className: 'ecb-num' }, r[0]),
                h('td', null, String(r[1] ?? '').slice(0, 40)),
                h('td', { className: 'ecb-meta' }, r[2]),
                h('td', { className: Number(r[3]) ? 'ecb-okc' : 'ecb-warn' }, Number(r[3]) ? '对' : '错'),
                h('td', { className: 'ecb-num' }, r[4] + 's'),
                h('td', { className: 'ecb-num' }, r[5]),
              ))),
            ))
          : h('div', { className: 'ecb-empty' }, '还没有作答记录 —— 上面提交一次就会出现。'),
      ) : null,

      tab === 'teacher' ? h('div', null,
        stat ? h('div', null, kpSection, groupSection, planSection) : h('div', { className: 'ecb-empty' }, busy ? '算学情中…' : '点右上「重算学情」从数据库算一遍。'),
      ) : null,
    ),
  )
}

export function apply(ctx: any) {
  ctx.pageEditor.registerBlock({
    kind: 'edu-classboard',
    plugin: name,
    label: '教育答题与学情',
    blockType: 'education',
    blockTypeLabel: '教育',
    hint: '左边学生真答题（提交后真写一条作答记录），右边老师按知识点正确率自动分「重讲/巩固/跳过」三组，点「写下备课计划」把结论写成数据行',
    aliases: ['edu', 'quiz', 'class', '答题', '学情', '教育', '错题'],
    defaults: {
      tab: 'student',
      class_name: '数二A班',
      student_name: '数二A班01',
      confirmed_by: '教研组',
      conn: { host: '127.0.0.1', port: 3306, user: 'root', password: 'Abc123456', database: 'edu_demo' },
    },
    View,
  })
}
