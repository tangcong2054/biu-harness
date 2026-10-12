import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const name = 'med-ruleset'
export const inject = ['http', 'sandbox']

/**
 * 医疗口径版本 —— 规则不是对话里的一句话，是有版本、能重跑、能 diff 的对象。
 *
 * 三件事必须是真的：
 *   1) 入组规则住在 med_demo.t_rule 表里（rule_id + version + condition_text）
 *   2) 「发布新版本」真 INSERT 一条 version+1 的规则，老版本留着（口径变更可追溯）
 *   3) 「按这条规则跑」用本文件里的受限解析器把 condition_text（如「年龄>=60 AND 收缩压>=140」）
 *      翻成 SQL 真查患者，人数 + 名单写进 med_demo.t_rule_run，并与上一版结果 diff（多出/少了谁）
 *
 * 每个指标值都能点回它的来源病历（t_record.source_file / doc_no）—— 这是「数据能不能过审」的那一步。
 *
 * 安全边界：
 *   - 写操作白名单只有 t_rule / t_rule_run
 *   - 规则条件只接受本文件白名单里的字段名与比较符，不把任意文本拼进 SQL
 */

const DEFAULT_CONN = { host: '127.0.0.1', port: 3306, user: 'root', database: 'med_demo' }
const WRITE_TABLES = new Set(['t_rule', 't_rule_run'])
const MAX_ROWS = 2000
const DEFAULT_TIMEOUT = 20000

type Conn = { host: string; port: number; user: string; database: string; password: string }

function str(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function intOf(value: unknown, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function normalizeConn(input: unknown): Conn {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const port = intOf(raw.port, DEFAULT_CONN.port)
  return {
    host: str(raw.host, DEFAULT_CONN.host),
    port: port > 0 && port < 65536 ? port : DEFAULT_CONN.port,
    user: str(raw.user, DEFAULT_CONN.user),
    database: str(raw.database, DEFAULT_CONN.database),
    password: typeof raw.password === 'string' ? raw.password : '',
  }
}

function mysqlBin() {
  const candidates = [
    process.env.BIU_MYSQL_BIN,
    '/opt/homebrew/opt/mysql-client/bin/mysql',
    '/opt/homebrew/opt/mysql@8.0/bin/mysql',
    '/opt/homebrew/bin/mysql',
    '/usr/local/bin/mysql',
    '/usr/bin/mysql',
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'mysql'
}

/** 字面量转义；注意前导零串必须按字符串（编号类字段）。 */
function lit(value: unknown) {
  // null / undefined 落成 NULL，而不是空串（空串对 INT 列会报 1366）
  if (value == null) return 'NULL'
  const text = String(value)
  const t = text.trim()
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(t) && t !== '-0') return t
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

function qs(route: any, key: string) {
  const raw = route && route.query
  if (!raw) return ''
  if (typeof raw.get === 'function') return String(raw.get(key) ?? '')
  const value = (raw as Record<string, unknown>)[key]
  return value == null ? '' : String(value)
}

function qsConn(route: any): Conn {
  const raw = qs(route, 'conn')
  if (!raw) return normalizeConn(undefined)
  try { return normalizeConn(JSON.parse(raw)) } catch { return normalizeConn(undefined) }
}

class SqlError extends Error {
  readonly rejected: string
  constructor(message: string, rejected: string) { super(message); this.rejected = rejected }
}

function assertReadOnly(sql: string) {
  const trimmed = sql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trim()
  if (!/^select\b/i.test(trimmed)) {
    throw new SqlError('只允许 SELECT，收到「' + (trimmed.split(/\s+/)[0] || '(空)') + '」', trimmed.slice(0, 200))
  }
  if (/;[\s\S]*\S/.test(trimmed)) throw new SqlError('只允许一条语句', trimmed.slice(0, 200))
  return trimmed.replace(/;\s*$/, '').trim()
}

function assertWrite(sql: string) {
  const trimmed = sql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trim()
  if (/;[\s\S]*\S/.test(trimmed)) throw new SqlError('只允许一条语句', trimmed.slice(0, 200))
  const hit = /^insert\s+(?:ignore\s+)?into\s+[`"']?([A-Za-z_][\w]*)['"`]?/i.exec(trimmed)
  if (!hit) throw new SqlError('写操作只允许 INSERT', trimmed.slice(0, 200))
  const table = hit[1].toLowerCase()
  if (!WRITE_TABLES.has(table)) {
    throw new SqlError('写操作只允许写 ' + [...WRITE_TABLES].join(' / ') + '，拒绝写入「' + table + '」', trimmed.slice(0, 200))
  }
  const tail = trimmed.slice(hit[0].length)
  if (/\b(select|update|delete|drop|alter|truncate|grant|create)\b/i.test(tail)) {
    throw new SqlError('INSERT 里出现嵌套语句，已拒绝', trimmed.slice(0, 200))
  }
  return trimmed
}

// ── 受限规则解析器 ────────────────────────────────────────────
// condition_text 形如「年龄>=60 AND 收缩压>=140」，字段名与比较符都走白名单。
const PATIENT_FIELDS: Record<string, string> = {
  年龄: 'p.age', age: 'p.age',
  性别: 'p.gender', gender: 'p.gender',
}
const METRIC_FIELDS: Record<string, { metric: string; label: string }> = {
  收缩压: { metric: 'SBP', label: '收缩压' },
  舒张压: { metric: 'DBP', label: '舒张压' },
  SBP: { metric: 'SBP', label: '收缩压' },
  DBP: { metric: 'DBP', label: '舒张压' },
  LDL: { metric: 'LDL', label: 'LDL 低密度脂蛋白' },
  低密度脂蛋白: { metric: 'LDL', label: 'LDL 低密度脂蛋白' },
}
const OPS = ['>=', '<=', '<>', '!=', '>', '<', '=']

type Cond = { kind: 'patient' | 'metric'; expr: string; label: string; field: string; op: string; value: string }

function parseCondition(text: string): Cond[] {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) throw new SqlError('规则条件为空', '')
  const parts = raw.split(/\s+(?:AND|and|且|并且)\s+/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new SqlError('规则条件无法解析', raw.slice(0, 200))
  return parts.map((part) => {
    const m = /^([^\s<>=!]+)\s*(>=|<=|<>|!=|>|<|=)\s*([^\s]+)$/.exec(part)
    if (!m) throw new SqlError('这段条件不认识：' + part + '（只支持「字段 比较符 值」，多个条件用 AND 连）', part.slice(0, 120))
    const field = m[1]
    const op = m[2] === '!=' ? '<>' : m[2]
    const valueRaw = m[3].replace(/^['"]|['"]$/g, '')
    if (!/^-?\d+(?:\.\d+)?$/.test(valueRaw)) {
      throw new SqlError('条件「' + part + '」的值必须是数字（现在收到 ' + m[3] + '）', part.slice(0, 120))
    }
    const metricHit = METRIC_FIELDS[field]
    if (metricHit) {
      return { kind: 'metric' as const, expr: metricHit.metric, label: metricHit.label, field, op, value: valueRaw }
    }
    const patientHit = PATIENT_FIELDS[field]
    if (patientHit) {
      return { kind: 'patient' as const, expr: patientHit, label: field, field, op, value: valueRaw }
    }
    throw new SqlError('字段「' + field + '」不在白名单（支持：' + Object.keys(PATIENT_FIELDS).concat(Object.keys(METRIC_FIELDS)).join(' / ') + '）', part.slice(0, 120))
  })
}

/** 把条件翻成真 SQL（只 SELECT）。 */
function conditionToSql(conds: Cond[]) {
  const patientConds = conds.filter((c) => c.kind === 'patient')
  const metricConds = conds.filter((c) => c.kind === 'metric')
  const where = patientConds.map((c) => c.expr + ' ' + c.op + ' ' + c.value)
  for (const c of metricConds) {
    where.push(
      'EXISTS (SELECT 1 FROM t_metric m WHERE m.patient_id = p.patient_id AND m.metric = ' + lit(c.expr) +
      ' AND m.value ' + c.op + ' ' + c.value + ')',
    )
  }
  return [
    'SELECT p.patient_code AS 患者编号, p.age AS 年龄, p.gender AS 性别,',
    '  (SELECT MAX(m.value) FROM t_metric m WHERE m.patient_id = p.patient_id AND m.metric = "SBP") AS 收缩压,',
    '  (SELECT MAX(m.value) FROM t_metric m WHERE m.patient_id = p.patient_id AND m.metric = "DBP") AS 舒张压,',
    '  (SELECT MAX(m.value) FROM t_metric m WHERE m.patient_id = p.patient_id AND m.metric = "LDL") AS LDL',
    'FROM t_patient p',
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    'ORDER BY p.patient_code',
  ].filter(Boolean).join('\n')
}

function runSql(bin: string, conn: Conn, sql: string, cwd: string, env: Record<string, string | undefined>, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = spawn(bin, [
      '-h', conn.host, '-P', String(conn.port), '-u', conn.user,
      '--connect-timeout=8', '--batch', '--raw', '--default-character-set=utf8mb4',
      '-D', conn.database, '-e', sql,
    ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(-2) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { stderr += String(error); done(-1) })
    child.on('close', (code) => done(code ?? 0))
  })
}

function parseTable(stdout: string) {
  const lines = stdout.split('\n')
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (!lines.length) return { columns: [] as string[], rows: [] as string[][] }
  const columns = lines[0].split('\t')
  const rows: string[][] = []
  for (const line of lines.slice(1)) {
    if (rows.length >= MAX_ROWS) break
    const cells = line.split('\t')
    while (cells.length < columns.length) cells.push('')
    rows.push(cells.slice(0, columns.length))
  }
  return { columns, rows }
}

type Ctx = {
  http: { route: (method: string, path: string, handler: (route: any) => unknown) => void }
  sandbox: { wrap: (input: { argv: string[] }) => { cwd?: string; env?: Record<string, string> } }
}

export function apply(ctx: Ctx) {
  const bin = mysqlBin()

  async function query(sql: string, conn: Conn, timeoutMs = DEFAULT_TIMEOUT) {
    let cwd = process.cwd()
    const env: Record<string, string | undefined> = { ...process.env }
    try {
      const wrapped = ctx.sandbox.wrap({ argv: [bin] })
      if (wrapped.cwd) cwd = wrapped.cwd
      Object.assign(env, wrapped.env)
    } catch { /* ok */ }
    if (conn.password) env.MYSQL_PWD = conn.password
    else delete env.MYSQL_PWD
    const started = Date.now()
    const result = await runSql(bin, conn, sql, cwd, env, timeoutMs)
    const ms = Date.now() - started
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || ('mysql 退出码 ' + result.code)).trim().split('\n').slice(0, 3).join(' · '))
    }
    return { ...parseTable(result.stdout), ms }
  }

  ctx.http.route('GET', '/api/med-ruleset/health', (route: any) => {
    route.send(200, { ok: true, plugin: name, bin, defaults: DEFAULT_CONN, writes: [...WRITE_TABLES] })
  })

  /** 规则列表（全部版本，含历史）—— 口径变更看得见。 */
  ctx.http.route('GET', '/api/med-ruleset/rules', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT rule_id, rule_name, condition_text, version, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") AS created ' +
          'FROM t_rule ORDER BY rule_id, version DESC',
        ),
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 按规则跑 —— 条件文本 → SQL → 真查患者；并行与上一次同规则结果 diff。 */
  ctx.http.route('POST', '/api/med-ruleset/run', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const ruleId = intOf(body.rule_id, 0)
      const conditionRaw = str(body.condition_text)
      const ranBy = str(body.ran_by, '临床数据组')

      let ruleName = str(body.rule_name, '未命名规则')
      let version = intOf(body.version, 1)
      let condition = conditionRaw
      if (!condition && ruleId > 0) {
        const hit = await query(
          assertReadOnly('SELECT rule_name, condition_text, version FROM t_rule WHERE rule_id = ' + lit(ruleId)),
          conn,
        )
        const row = hit.rows[0]
        if (!row) { route.send(200, { ok: false, error: 't_rule 里没有 rule_id=' + ruleId }); return }
        ruleName = row[0]
        condition = row[1]
        version = Number(row[2]) || 1
      }
      if (!condition) { route.send(200, { ok: false, error: 'condition_text 为空' }); return }

      let conds: Cond[]
      try {
        conds = parseCondition(condition)
      } catch (error) {
        route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error), rejected: (error as SqlError).rejected })
        return
      }

      const sql = conditionToSql(conds)
      const out = await query(assertReadOnly(sql), conn)
      const codes = out.rows.map((r) => r[0])
      const iCode = 0

      // 和上一次同规则的结果 diff：多出谁、少了谁
      const prev = await query(
        assertReadOnly(
          'SELECT patient_count, patient_codes, rule_version FROM t_rule_run WHERE rule_name = ' + lit(ruleName) +
          ' ORDER BY run_id DESC LIMIT 1',
        ),
        conn,
      ).catch(() => ({ rows: [] as string[][] }))
      const prevRow = prev.rows[0]
      const prevCodes = prevRow && prevRow[1] ? String(prevRow[1]).split(',') : []
      const prevCount = prevRow ? Number(prevRow[0]) || 0 : null
      const prevVersion = prevRow ? Number(prevRow[2]) || null : null
      const added = codes.filter((c) => !prevCodes.includes(c))
      const removed = prevCodes.filter((c) => !codes.includes(c))

      // 参保/入组情况顺带算一下「人群画像」，让结论不是干巴巴一个人数
      const profile = await query(
        assertReadOnly(
          'SELECT p.gender, COUNT(*) FROM t_patient p WHERE p.patient_code IN (' +
          (codes.length ? codes.map((c) => lit(c)).join(',') : "''") + ') GROUP BY p.gender',
        ),
        conn,
      ).catch(() => ({ rows: [] as string[][] }))

      route.send(200, {
        ok: true,
        rule_id: ruleId,
        rule_name: ruleName,
        version,
        condition_text: condition,
        conditions: conds.map((c) => ({ field: c.label, op: c.op, value: c.value, on: c.kind === 'metric' ? '指标表 t_metric' : '患者表 t_patient' })),
        patient_count: codes.length,
        patients: out.rows,
        columns: out.columns,
        codes,
        indexCode: iCode,
        prev: prevCount == null ? null : { count: prevCount, version: prevVersion },
        added,
        removed,
        profile: profile.rows,
        ms: out.ms,
        sql,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 发布新版本 —— 真 INSERT 一条 version+1 的规则，老版本留着。 */
  ctx.http.route('POST', '/api/med-ruleset/publish', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const ruleId = intOf(body.rule_id, 0)
      const condition = str(body.condition_text)
      if (ruleId <= 0) { route.send(200, { ok: false, error: 'rule_id 必填' }); return }
      if (!condition) { route.send(200, { ok: false, error: 'condition_text 必填' }); return }
      let conds: Cond[]
      try {
        conds = parseCondition(condition)
      } catch (error) {
        route.send(200, { ok: false, error: '条件不合规：' + String(error instanceof Error ? error.message : error) })
        return
      }

      const cur = await query(
        assertReadOnly('SELECT rule_name, version FROM t_rule WHERE rule_id = ' + lit(ruleId) + ' ORDER BY version DESC LIMIT 1'),
        conn,
      )
      const row = cur.rows[0]
      if (!row) { route.send(200, { ok: false, error: 't_rule 里没有 rule_id=' + ruleId }); return }
      const ruleName = str(body.rule_name, row[0])
      // 版本链挂在「规则名」上：rule_id 是行主键，同一个规则的多版本是同一名字的多行
      const verHit = await query(
        assertReadOnly('SELECT COALESCE(MAX(version), 1) FROM t_rule WHERE rule_name = ' + lit(ruleName)),
        conn,
      )
      const nextVersion = (Number(verHit.rows[0] ? verHit.rows[0][0] : 1) || 1) + 1
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const insert = assertWrite(
        'INSERT INTO t_rule (rule_name, condition_text, version, created_at) VALUES (' +
        lit(ruleName) + ', ' + lit(condition) + ', ' + nextVersion + ', ' + lit(stamp) + ')',
      )
      await query(insert, conn)
      const back = await query(
        assertReadOnly('SELECT rule_id, rule_name, condition_text, version, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") FROM t_rule WHERE rule_name = ' + lit(ruleName) + ' ORDER BY version DESC LIMIT 8'),
        conn,
      )
      const newId = await query(
        assertReadOnly('SELECT rule_id FROM t_rule WHERE rule_name = ' + lit(ruleName) + ' AND version = ' + nextVersion + ' ORDER BY rule_id DESC LIMIT 1'),
        conn,
      )
      route.send(200, {
        ok: true,
        published: {
          rule_id: Number(newId.rows[0] ? newId.rows[0][0] : ruleId),
          rule_name: ruleName,
          version: nextVersion,
          condition_text: condition,
        },
        versions: back.rows,
        wrote: insert,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 把这一版的结果落成一次 rule_run（人数 + 名单 + 与上一版的 diff）。 */
  ctx.http.route('POST', '/api/med-ruleset/save-run', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const ruleId = intOf(body.rule_id, 0)
      const version = intOf(body.version, 1)
      const codes: string[] = Array.isArray(body.codes) ? body.codes.map((c: unknown) => String(c)).slice(0, 200) : []
      const added: string[] = Array.isArray(body.added) ? body.added.map((c: unknown) => String(c)).slice(0, 200) : []
      const removed: string[] = Array.isArray(body.removed) ? body.removed.map((c: unknown) => String(c)).slice(0, 200) : []
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const insert = assertWrite(
        'INSERT INTO t_rule_run (rule_id, rule_version, rule_name, condition_text, patient_count, patient_codes, prev_count, added, removed, ran_by, ran_at) VALUES (' +
        [
          lit(ruleId), version, lit(body.rule_name), lit(body.condition_text),
          codes.length, lit(codes.join(',')).slice(0, 600),
          lit(body.prev_count == null ? null : intOf(body.prev_count, 0)),
          lit(added.join(',')).slice(0, 400), lit(removed.join(',')).slice(0, 400),
          lit(str(body.ran_by, '临床数据组')), lit(stamp),
        ].join(', ') + ')',
      )
      await query(insert, conn)
      const back = await query(
        assertReadOnly(
          'SELECT run_id, rule_name, rule_version, patient_count, prev_count, added, removed, ran_by, DATE_FORMAT(ran_at, "%Y-%m-%d %H:%i") ' +
          'FROM t_rule_run ORDER BY run_id DESC LIMIT 6',
        ),
        conn,
      )
      route.send(200, { ok: true, runs: back.rows, wrote: insert })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  ctx.http.route('GET', '/api/med-ruleset/runs', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT run_id, rule_name, rule_version, patient_count, prev_count, added, removed, ran_by, DATE_FORMAT(ran_at, "%Y-%m-%d %H:%i") ' +
          'FROM t_rule_run ORDER BY run_id DESC LIMIT 12',
        ),
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /**
   * 指标溯源 —— 每个值点回它出自哪份病历。
   * 这是医疗这一行最硬的那一步：数据要能过审。
   */
  ctx.http.route('GET', '/api/med-ruleset/trace', async (route: any) => {
    try {
      const conn = qsConn(route)
      const patientCode = str(qs(route, 'patient_code'), 'P0001')
      const metric = str(qs(route, 'metric'))
      const where = metric ? ' AND m.metric = ' + lit(metric) : ''
      const out = await query(
        assertReadOnly(
          'SELECT m.metric_id, m.metric, m.value, m.unit, m.rule_id, r.record_date, r.record_type, r.doc_no, r.source_file ' +
          'FROM t_metric m JOIN t_patient p ON p.patient_id = m.patient_id ' +
          'LEFT JOIN t_record r ON r.record_id = m.record_id ' +
          'WHERE p.patient_code = ' + lit(patientCode) + where +
          ' ORDER BY r.record_date DESC LIMIT 40',
        ),
        conn,
      )
      const counts = await query(
        assertReadOnly(
          'SELECT r.record_type, COUNT(DISTINCT r.source_file) FROM t_record r JOIN t_patient p ON p.patient_id = r.patient_id ' +
          'WHERE p.patient_code = ' + lit(patientCode) + ' GROUP BY r.record_type',
        ),
        conn,
      )
      route.send(200, { ok: true, patient_code: patientCode, ...out, byType: counts.rows })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 指标提取总览：SBP/DBP/LDL 各多少条、来自多少份文件、被哪条规则提取的。 */
  ctx.http.route('GET', '/api/med-ruleset/metrics', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT m.metric, COUNT(*) AS 条数, COUNT(DISTINCT m.patient_id) AS 覆盖患者, COUNT(DISTINCT r.source_file) AS 来源文件, ' +
          'COUNT(DISTINCT m.rule_id) AS 规则数, ROUND(AVG(m.value),2) AS 均值 ' +
          'FROM t_metric m LEFT JOIN t_record r ON r.record_id = m.record_id GROUP BY m.metric ORDER BY m.metric',
        ),
        conn,
      )
      const src = await query(
        assertReadOnly('SELECT COUNT(*) AS 病历数, COUNT(DISTINCT source_file) AS 文件数 FROM t_record'),
        conn,
      )
      route.send(200, { ok: true, ...out, recordSummary: src.rows[0] ?? null })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })
}
