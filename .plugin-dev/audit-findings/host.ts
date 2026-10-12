import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const name = 'audit-findings'
export const inject = ['http', 'sandbox']

/**
 * 审计发现底稿 —— 规则是数据，发现是记录。
 *
 * 和通用 Agent 的区别就三条，都在代码里能看见：
 *   1) 规则不住在提示词里，住在 audit_demo.t_audit_rule 表里（有 rule_id、有 version、有 owner）
 *   2) 跑规则不是「生成一段话」，是真执行那条 SQL，每条命中带证据（票号、部门、金额）
 *   3) 「确认」这件事真的落库：audit_demo.t_audit_finding 一行，带规则版本、指纹、确认人、时间
 *      —— 下次重跑自动和上一次 diff（新增 / 消失 / 仍在）
 *
 * 安全边界：写操作白名单只有 t_audit_finding；规则 SQL 必须 SELECT 开头、单条语句。
 */

const DEFAULT_CONN = { host: '127.0.0.1', port: 3306, user: 'root', database: 'audit_demo' }
const WRITE_TABLES = new Set(['t_audit_finding'])
const MAX_ROWS = 2000
const DEFAULT_TIMEOUT = 20000

type Conn = { host: string; port: number; user: string; database: string; password: string }

function str(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizeConn(input: unknown): Conn {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    host: str(raw.host, DEFAULT_CONN.host),
    port: num(raw.port, DEFAULT_CONN.port),
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

/**
 * 字面量转义。注意：前导零的串（如清单编码 010101001）必须当字符串，
 * 否则被当数字会丢前导零，join 直接对不上。
 */
function lit(value: unknown) {
  // null / undefined 落成 NULL，而不是空串（空串对 INT 列会报 1366）
  if (value == null) return 'NULL'
  const text = String(value)
  const t = text.trim()
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(t) && t !== '-0') return t
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/** route.query 是 URLSearchParams。 */
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

/** 只读白名单：规则可以写在表里，但执行时仍然是「只读 + 单条」。 */
function assertReadOnly(sql: string) {
  const trimmed = sql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trim()
  if (!/^select\b/i.test(trimmed)) {
    throw new SqlError('规则 SQL 必须是 SELECT，收到「' + (trimmed.split(/\s+/)[0] || '(空)') + '」', trimmed.slice(0, 200))
  }
  if (/;[\s\S]*\S/.test(trimmed)) throw new SqlError('规则 SQL 只允许一条语句', trimmed.slice(0, 200))
  return trimmed.replace(/;\s*$/, '').trim()
}

/** 写操作按表名白名单放行，而不是猜危险词。 */
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

/** 指纹：同一规则 + 同一主体 + 同一维度 → 同一条发现。重跑时用它做 diff。 */
function fingerprint(ruleId: number, subject: string, k1: string) {
  return createHash('sha1').update(ruleId + '\u0000' + subject + '\u0000' + k1).digest('hex').slice(0, 16)
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
    } catch { /* 沙箱不可用就直接跑 */ }
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

  ctx.http.route('GET', '/api/audit-findings/health', (route: any) => {
    route.send(200, { ok: true, plugin: name, bin, defaults: DEFAULT_CONN, writes: [...WRITE_TABLES] })
  })

  /** 规则从表里读 —— 规则是数据，看得见、有版本、说得出是谁的。 */
  ctx.http.route('GET', '/api/audit-findings/rules', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT rule_id, rule_name, risk, version, owner, DATE_FORMAT(updated_at, "%Y-%m-%d %H:%i") AS upd FROM t_audit_rule ORDER BY rule_id',
        ),
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 看一条规则的原文 —— 规则不是黑箱。 */
  ctx.http.route('GET', '/api/audit-findings/rule-sql', async (route: any) => {
    try {
      const conn = qsConn(route)
      const ruleId = Number(qs(route, 'rule_id'))
      const out = await query(
        assertReadOnly('SELECT sql_text, rule_name, version, owner FROM t_audit_rule WHERE rule_id = ' + lit(ruleId)),
        conn,
      )
      route.send(200, { ok: true, row: out.rows[0] ?? null })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /**
   * 跑规则 —— 真执行。返回的每条命中都带 subject / detail / amount / rule_hit。
   * 同时和上一轮结果 diff（新增 / 消失 / 仍在）。
   */
  ctx.http.route('POST', '/api/audit-findings/run', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const ruleIds: number[] = Array.isArray(body.rule_ids) && body.rule_ids.length
        ? body.rule_ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
        : [1, 2, 3, 4]

      const rules = await query(
        assertReadOnly('SELECT rule_id, rule_name, risk, version, sql_text FROM t_audit_rule WHERE rule_id IN (' + ruleIds.join(',') + ') ORDER BY rule_id'),
        conn,
      )

      const hits: any[] = []
      const perRule: any[] = []
      for (const row of rules.rows) {
        const ruleId = Number(row[0])
        const ruleName = row[1]
        const risk = row[2]
        const version = Number(row[3])
        const sql = row[4]
        const started = Date.now()
        try {
          const out = await query(assertReadOnly(sql), conn)
          const cols = out.columns
          const idx = (name: string) => cols.findIndex((c) => c.toLowerCase() === name)
          const iSubject = idx('subject')
          const iK1 = idx('k1')
          const iDetail = idx('detail')
          const iAmount = idx('amount')
          const iCnt = idx('cnt')
          const iHit = idx('rule_hit')
          for (const r of out.rows) {
            const subject = iSubject >= 0 ? r[iSubject] : r[0]
            const k1 = iK1 >= 0 ? r[iK1] : ''
            hits.push({
              rule_id: ruleId,
              rule_name: ruleName,
              rule_version: version,
              risk,
              fingerprint: fingerprint(ruleId, subject, k1),
              subject,
              k1,
              detail: iDetail >= 0 ? r[iDetail] : '',
              amount: iAmount >= 0 ? Number(r[iAmount]) || 0 : 0,
              cnt: iCnt >= 0 ? Number(r[iCnt]) || 0 : 1,
              rule_hit: iHit >= 0 ? r[iHit] : ruleName,
            })
          }
          perRule.push({ rule_id: ruleId, rule_name: ruleName, risk, version, hit: out.rows.length, ms: Date.now() - started, ok: true })
        } catch (error) {
          perRule.push({ rule_id: ruleId, rule_name: ruleName, risk, version, hit: 0, ms: Date.now() - started, ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      }

      // 和上一轮 diff：上次跑过、这次没命中 → 消失；这次有、上次没记 → 新增
      const prev = await query(assertReadOnly('SELECT fingerprint FROM t_audit_finding'), conn).catch(() => ({ rows: [] as string[][] }))
      const known = new Set(prev.rows.map((r) => String(r[0])))
      const nowSet = new Set(hits.map((hit) => hit.fingerprint))
      const fresh = hits.filter((hit) => !known.has(hit.fingerprint))
      const gone = [...known].filter((fp) => !nowSet.has(fp))

      route.send(200, {
        ok: true,
        ranAt: Date.now(),
        rules: perRule,
        hits,
        hitCount: hits.length,
        totalAmount: Math.round(hits.reduce((sum, hit) => sum + (Number(hit.amount) || 0), 0) * 100) / 100,
        diff: { fresh: fresh.map((hit) => hit.subject), gone, stillCount: hits.length - fresh.length },
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 确认一条发现 → 真的落一行底稿。这是「发现即底稿」。 */
  ctx.http.route('POST', '/api/audit-findings/confirm', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      const confirmedBy = str(body.confirmed_by, '审计一组（李）')
      if (!items.length) { route.send(200, { ok: false, error: 'items 为空' }); return }
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const values = items.map((item: Record<string, unknown>) =>
        '(' + [
          lit(Number(item.rule_id) || 0),
          lit(item.rule_name),
          lit(Number(item.rule_version) || 1),
          lit(item.fingerprint),
          lit(item.subject),
          lit(item.detail).slice(0, 300),
          Number(item.amount) || 0,
          lit(Number(item.cnt) || 1),
          lit(item.rule_hit).slice(0, 200),
          lit(str(item.conclusion, '待复核')),
          lit(confirmedBy),
          lit(stamp),
        ].join(', ') + ')',
      )
      const insert = assertWrite(
        'INSERT INTO t_audit_finding (rule_id, rule_name, rule_version, fingerprint, subject, detail, amount, cnt, rule_hit, conclusion, confirmed_by, created_at) VALUES ' +
        values.join(', '),
      )
      await query(insert, conn)
      const back = await query(
        assertReadOnly(
          'SELECT finding_id, rule_name, rule_version, subject, amount, conclusion, confirmed_by, DATE_FORMAT(created_at, "%m-%d %H:%i") FROM t_audit_finding ORDER BY finding_id DESC LIMIT ' + items.length,
        ),
        conn,
      )
      route.send(200, { ok: true, written: items.length, findings: back.rows, wrote: insert })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 已落盘的底稿（跨页面、跨人可见 —— 这就是「留痕」）。 */
  ctx.http.route('GET', '/api/audit-findings/findings', async (route: any) => {
    try {
      const conn = qsConn(route)
      const limit = Math.min(100, Math.max(1, Number(qs(route, 'limit')) || 20))
      const out = await query(
        assertReadOnly(
          'SELECT finding_id, rule_name, rule_version, subject, ROUND(amount,2), cnt, conclusion, confirmed_by, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") ' +
          'FROM t_audit_finding ORDER BY finding_id DESC LIMIT ' + limit,
        ),
        conn,
      )
      const agg = await query(
        assertReadOnly('SELECT COUNT(*), ROUND(SUM(amount),2), COUNT(DISTINCT rule_name) FROM t_audit_finding'),
        conn,
      )
      route.send(200, { ok: true, ...out, summary: agg.rows[0] ?? null })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /**
   * 「一次对话做不到」的实证：同一个问题，问的是跨记录的模式。
   * 这里真跑一次「单张都合规、合起来有问题」的对照。
   */
  ctx.http.route('GET', '/api/audit-findings/contrast', async (route: any) => {
    try {
      const conn = qsConn(route)
      const single = await query(
        assertReadOnly(
          'SELECT COUNT(*) AS 张数, ROUND(MAX(amount),2) AS 单张最大金额, ROUND(AVG(amount),2) AS 单张平均 ' +
          'FROM t_invoice WHERE approve_node = "部门经理"',
        ),
        conn,
      )
      const pattern = await query(
        assertReadOnly(
          'SELECT v.vendor_name AS 供应商, i.invoice_date AS 日期, COUNT(*) AS 同日张数, ROUND(SUM(i.amount),2) AS 同日合计 ' +
          'FROM t_invoice i JOIN t_vendor v ON v.vendor_id = i.vendor_id ' +
          'GROUP BY v.vendor_name, i.invoice_date HAVING COUNT(*) >= 3 ORDER BY 同日合计 DESC LIMIT 5',
        ),
        conn,
      )
      route.send(200, { ok: true, single: single.rows, pattern: pattern.rows })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })
}
