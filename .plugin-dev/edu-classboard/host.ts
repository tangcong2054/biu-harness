import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const name = 'edu-classboard'
export const inject = ['http', 'sandbox']

/**
 * 教育答题与学情 —— 底层能力。
 *
 * 这个插件只做两件事，但两件都必须是真的：
 *   1) 学生真答题 → 真 INSERT 进 edu_demo.t_attempt（返回新的 attempt_id），
 *      所以「谁做过哪道题、对错、用了多久」是一条条记录，不是一段对话。
 *   2) 老师按记录算学情 → 按知识点正确率、按学生正确率自动分组，
 *      点「写下备课计划」把分组结论落成 edu_demo.t_group_plan 的一条记录。
 *
 * 安全边界：写操作白名单只有 t_attempt / t_group_plan 两张表，
 * 每条 SQL 都是本文件里写死的模板（参数只做字面量转义），不接受外部传入的任意 SQL。
 */

const DEFAULT_CONN = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: 'edu_demo',
}

const WRITE_TABLES = new Set(['t_attempt', 't_group_plan'])
const DEFAULT_TIMEOUT = 15000
const MAX_ROWS = 3000

type Conn = {
  host: string
  port: number
  user: string
  database: string
  password: string
}

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

/** 字面量转义：数字不带引号，其余一律单引号 + 反斜杠转义。 */
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

class SqlError extends Error {
  readonly rejected: string
  constructor(message: string, rejected: string) {
    super(message)
    this.rejected = rejected
  }
}

/** 只读 + 单条语句检查；写操作另走 assertWrite。 */
function assertReadOnly(sql: string) {
  const trimmed = sql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trim()
  if (!/^select\b/i.test(trimmed)) {
    throw new SqlError('只允许 SELECT，收到「' + (trimmed.split(/\s+/)[0] || '(空)') + '」', trimmed.slice(0, 200))
  }
  if (/;[\s\S]*\S/.test(trimmed)) throw new SqlError('只允许一条语句，检测到分号拼接', trimmed.slice(0, 200))
  return trimmed.replace(/;\s*$/, '').trim()
}

/**
 * 写操作：必须是 INSERT，且目标表在白名单里。
 * 不是靠正则「猜」危险词，而是解析出表名后按白名单放行。
 */
function assertWrite(sql: string) {
  const trimmed = sql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trim()
  if (/;[\s\S]*\S/.test(trimmed)) throw new SqlError('只允许一条语句，检测到分号拼接', trimmed.slice(0, 200))
  const hit = /^insert\s+(?:ignore\s+)?into\s+[`"']?([A-Za-z_][\w]*)['"`]?/i.exec(trimmed)
  if (!hit) throw new SqlError('写操作只允许 INSERT 开头的一条语句', trimmed.slice(0, 200))
  const table = hit[1].toLowerCase()
  if (!WRITE_TABLES.has(table)) {
    throw new SqlError('写操作只允许写 ' + [...WRITE_TABLES].join(' / ') + '，拒绝写入「' + table + '」', trimmed.slice(0, 200))
  }
  const tail = trimmed.slice(hit[0].length)
  if (/\b(select|update|delete|drop|alter|truncate|grant|create)\b/i.test(tail)) {
    throw new SqlError('INSERT 语句里出现了嵌套的写/查语句，已拒绝', trimmed.slice(0, 200))
  }
  return trimmed
}

function runSql(bin: string, conn: Conn, sql: string, cwd: string, env: Record<string, string | undefined>, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const args = [
      '-h', conn.host,
      '-P', String(conn.port),
      '-u', conn.user,
      '--connect-timeout=8',
      '--batch',
      '--raw',
      '--default-character-set=utf8mb4',
      '-D', conn.database,
      '-e', sql,
    ]
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(-2)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { stderr += String(error); done(-1) })
    child.on('close', (code) => done(code ?? 0))
  })
}

function parseTable(stdout: string) {
  const lines = stdout.split('\n')
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (!lines.length) return { columns: [] as string[], rows: [] as string[][], truncated: false }
  const columns = lines[0].split('\t')
  const rows: string[][] = []
  let truncated = false
  for (const line of lines.slice(1)) {
    if (rows.length >= MAX_ROWS) { truncated = true; break }
    const cells = line.split('\t')
    while (cells.length < columns.length) cells.push('')
    rows.push(cells.slice(0, columns.length))
  }
  return { columns, rows, truncated }
}

/** route.query 是 URLSearchParams，取值统一走这里。 */
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

  async function readSelect(sql: string, conn: Conn) {
    return query(assertReadOnly(sql), conn)
  }

  // ── 健康检查 ──────────────────────────────────────────────
  ctx.http.route('GET', '/api/edu-classboard/health', (route: any) => {
    route.send(200, { ok: true, plugin: name, bin, defaults: DEFAULT_CONN, writes: [...WRITE_TABLES] })
  })

  // ── 班级名单 ──────────────────────────────────────────────
  ctx.http.route('GET', '/api/edu-classboard/classes', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await readSelect(
        'SELECT class_name AS 班级, COUNT(DISTINCT student_name) AS 人数, COUNT(*) AS 作答次数 ' +
        'FROM t_attempt WHERE student_name IS NOT NULL GROUP BY class_name ORDER BY class_name',
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 某个班的学生名单 —— 从真实作答记录里取，不是写死的。 */
  ctx.http.route('GET', '/api/edu-classboard/roster', async (route: any) => {
    try {
      const conn = qsConn(route)
      const className = str(qs(route, 'class'), '数二A班')
      const out = await readSelect(
        'SELECT student_name FROM t_attempt WHERE class_name = ' + lit(className) + ' AND student_name IS NOT NULL ' +
        'GROUP BY student_name ORDER BY student_name',
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 取下一道题：优先给这个班最弱的知识点，且这个学生还没做过。 */
  ctx.http.route('GET', '/api/edu-classboard/next', async (route: any) => {
    try {
      const conn = qsConn(route)
      const className = str(qs(route, 'class'), '数二A班')
      const student = str(qs(route, 'student'), '数二A班01')
      const kpId = Number(qs(route, 'kp_id'))

      let kpRow: string[][] = []
      if (Number.isFinite(kpId) && kpId > 0) {
        kpRow = [[String(kpId), '']]
      } else {
        const weak = await readSelect(
          'SELECT k.kp_id FROM t_kp k ' +
          'JOIN t_question q ON q.kp_id = k.kp_id JOIN t_attempt a ON a.q_id = q.q_id ' +
          'WHERE a.class_name = ' + lit(className) + ' ' +
          'GROUP BY k.kp_id ORDER BY AVG(a.correct) ASC LIMIT 1',
          conn,
        )
        kpRow = weak.rows
      }
      const targetKp = Number(kpRow[0] ? kpRow[0][0] : 0)

      const baseCols =
        'SELECT q.q_id, q.stem, q.difficulty, k.kp_id, k.kp_name, k.chapter, q.source, ' +
        '(SELECT COUNT(*) FROM t_attempt a2 WHERE a2.student_name = ' + lit(student) + ') AS my_total, ' +
        '(SELECT ROUND(100*AVG(a3.correct),1) FROM t_attempt a3 WHERE a3.student_name = ' + lit(student) + ') AS my_acc ' +
        'FROM t_question q JOIN t_kp k ON k.kp_id = q.kp_id '

      const picked = await readSelect(
        baseCols + 'WHERE k.kp_id = ' + lit(targetKp) +
        ' AND NOT EXISTS (SELECT 1 FROM t_attempt a WHERE a.q_id = q.q_id AND a.student_name = ' + lit(student) + ') ' +
        'ORDER BY q.difficulty ASC LIMIT 1',
        conn,
      )

      let row = picked.rows[0]
      let repeat = false
      if (!row) {
        repeat = true
        const again = await readSelect(baseCols + 'WHERE k.kp_id = ' + lit(targetKp) + ' LIMIT 1', conn)
        row = again.rows[0]
      }
      if (!row) { route.send(200, { ok: false, error: '这个知识点下没有题' }); return }

      const qid = Number(row[0])
      const key = await readSelect('SELECT option_a, option_b, option_c, option_d FROM t_qkey WHERE q_id = ' + lit(qid), conn)
      const k = key.rows[0]
      const options = k
        ? [k[0], k[1], k[2], k[3]].map((text, i) => ({ key: 'ABCD'[i], text })).filter((item) => item.text)
        : []
      route.send(200, {
        ok: true,
        question: {
          q_id: qid,
          stem: row[1],
          difficulty: Number(row[2]),
          kp_id: Number(row[3]),
          kp_name: row[4],
          chapter: row[5],
          source: row[6],
          options,
        },
        student: { name: student, class_name: className, total: Number(row[7] ?? 0), acc: row[8] === '' ? null : Number(row[8]) },
        weak_kp_id: targetKp,
        repeat,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /**
   * 学生提交答案 —— 真的判分并真的 INSERT 一条作答记录。
   * 这一条 INSERT 就是整个论点的证据：它有 ID、有身份、有时间、下次还查得到。
   */
  ctx.http.route('POST', '/api/edu-classboard/submit', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const className = str(body.class_name, '数二A班')
      const student = str(body.student_name, '数二A班01')
      const qid = Number(body.q_id)
      const answer = str(body.answer).toUpperCase().slice(0, 4)
      const seconds = num(body.answer_seconds, 0) || Math.max(3, Math.round((Number(body.elapsed_ms) || 30000) / 1000))

      if (!Number.isFinite(qid) || qid <= 0) { route.send(200, { ok: false, error: 'q_id 缺失' }); return }
      if (!/^[ABCD]$/.test(answer)) { route.send(200, { ok: false, error: 'answer 必须是 A/B/C/D' }); return }

      const key = await readSelect('SELECT answer FROM t_qkey WHERE q_id = ' + lit(qid), conn)
      const right = (key.rows[0] ? String(key.rows[0][0]) : '').trim().toUpperCase()
      if (!right) { route.send(200, { ok: false, error: 't_qkey 里没有 q_id=' + qid + ' 的答案' }); return }
      const correct = right === answer ? 1 : 0
      const usedOn = new Date().toISOString().slice(0, 10)

      const insert = assertWrite(
        'INSERT INTO t_attempt (q_id, class_name, correct, answer_seconds, used_on, student_name) VALUES (' +
        lit(qid) + ', ' + lit(className) + ', ' + correct + ', ' + lit(seconds) + ', ' + lit(usedOn) + ', ' + lit(student) + ')',
      )
      await query(insert, conn)

      const after = await readSelect(
        'SELECT attempt_id FROM t_attempt WHERE student_name = ' + lit(student) + ' ORDER BY attempt_id DESC LIMIT 1',
        conn,
      )
      const attemptId = Number(after.rows[0] ? after.rows[0][0] : 0)
      const stat = await readSelect(
        'SELECT COUNT(*) AS n, ROUND(100*AVG(correct),1) AS acc FROM t_attempt WHERE student_name = ' + lit(student),
        conn,
      )
      route.send(200, {
        ok: true,
        attempt_id: attemptId,
        correct: Boolean(correct),
        answer,
        correct_answer: right,
        answer_seconds: seconds,
        used_on: usedOn,
        student: { name: student, class_name: className, total: Number(stat.rows[0] ? stat.rows[0][0] : 0), acc: Number(stat.rows[0] ? stat.rows[0][1] : 0) },
        wrote: insert,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 某个学生的作答历史 —— 「历史」是这张表的行，不是聊天记录。 */
  ctx.http.route('GET', '/api/edu-classboard/history', async (route: any) => {
    try {
      const conn = qsConn(route)
      const student = str(qs(route, 'student'), '数二A班01')
      const limit = Math.min(200, Math.max(1, Number(qs(route, 'limit')) || 20))
      const out = await readSelect(
        'SELECT a.attempt_id, q.stem, k.kp_name, a.correct, a.answer_seconds, a.used_on, a.class_name ' +
        'FROM t_attempt a JOIN t_question q ON q.q_id = a.q_id JOIN t_kp k ON k.kp_id = q.kp_id ' +
        'WHERE a.student_name = ' + lit(student) + ' ORDER BY a.attempt_id DESC LIMIT ' + limit,
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 老师看的学情：按知识点正确率 + 按学生正确率 + 自动分三组。 */
  ctx.http.route('GET', '/api/edu-classboard/stats', async (route: any) => {
    try {
      const conn = qsConn(route)
      const className = str(qs(route, 'class'), '数二A班')
      const kp = await readSelect(
        'SELECT k.kp_id, k.kp_name, k.chapter, COUNT(DISTINCT q.q_id) AS qs, COUNT(a.attempt_id) AS n, ' +
        'ROUND(100*AVG(a.correct),1) AS acc ' +
        'FROM t_kp k JOIN t_question q ON q.kp_id = k.kp_id JOIN t_attempt a ON a.q_id = q.q_id ' +
        'WHERE a.class_name = ' + lit(className) + ' ' +
        'GROUP BY k.kp_id, k.kp_name, k.chapter ORDER BY acc ASC',
        conn,
      )
      const stu = await readSelect(
        'SELECT a.student_name, COUNT(*) AS n, ROUND(100*AVG(a.correct),1) AS acc ' +
        'FROM t_attempt a WHERE a.class_name = ' + lit(className) + ' AND a.student_name IS NOT NULL ' +
        'GROUP BY a.student_name ORDER BY acc ASC',
        conn,
      )
      // 阈值跟随真实分数区间，避免「所有人都在重讲组」这种没信息量的分组
      const accs = stu.rows.map((row) => Number(row[2])).filter((n) => Number.isFinite(n))
      const lo = Math.round(Math.min(...accs) + (Math.max(...accs) - Math.min(...accs)) / 3)
      const hi = Math.round(Math.min(...accs) + 2 * (Math.max(...accs) - Math.min(...accs)) / 3)
      const groups: Record<string, string[]> = { 重讲: [], 巩固: [], 跳过: [] }
      for (const row of stu.rows) {
        const acc = Number(row[2])
        const nick = String(row[0])
        if (acc < lo) groups.重讲.push(nick)
        else if (acc < hi) groups.巩固.push(nick)
        else groups.跳过.push(nick)
      }
      route.send(200, {
        ok: true,
        class_name: className,
        kp: kp.rows,
        students: stu.rows,
        lo,
        hi,
        groups,
        thresholds: { 重讲: '<' + lo + '%', 巩固: lo + '–' + hi + '%', 跳过: '≥' + hi + '%', lo, hi },
        ms: kp.ms + stu.ms,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 把分组结论落成一条备课计划 —— 结论从「对话里的一段话」变成「表里的一行」。 */
  ctx.http.route('POST', '/api/edu-classboard/plan', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 12) : []
      const confirmedBy = str(body.confirmed_by, '教研组')
      if (!rows.length) { route.send(200, { ok: false, error: 'rows 为空' }); return }
      const className = str(body.class_name, '数二A班')
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const values = rows.map((row: Record<string, unknown>) => {
        const group = str(row.target_group, '巩固')
        const students = Array.isArray(row.students) ? row.students.join('、') : str(row.students)
        return '(' + lit(className) + ', ' + lit(Number(row.kp_id) || null) + ', ' + lit(row.kp_name) + ', ' +
          (Number(row.acc) || 0) + ', ' + lit(group) + ', ' + lit(students).slice(0, 400) + ', ' +
          lit(row.note) + ', ' + lit(confirmedBy) + ', ' + lit(stamp) + ')'
      })
      const insert = assertWrite(
        'INSERT INTO t_group_plan (class_name, kp_id, kp_name, acc, target_group, students, note, confirmed_by, created_at) VALUES ' +
        values.join(', '),
      )
      await query(insert, conn)
      const back = await readSelect(
        'SELECT plan_id, kp_name, ROUND(acc,1), target_group, students, confirmed_by, created_at ' +
        'FROM t_group_plan WHERE class_name = ' + lit(className) + ' ORDER BY plan_id DESC LIMIT ' + rows.length,
        conn,
      )
      route.send(200, { ok: true, written: rows.length, plans: back.rows, wrote: insert })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 已落盘的备课计划（跨页面可查 —— 这是「留下来了」的证据）。 */
  ctx.http.route('GET', '/api/edu-classboard/plans', async (route: any) => {
    try {
      const conn = qsConn(route)
      const className = str(qs(route, 'class'), '')
      const where = className ? 'WHERE class_name = ' + lit(className) : ''
      const out = await readSelect(
        'SELECT plan_id, class_name, kp_name, ROUND(acc,1) AS acc, target_group, students, confirmed_by, created_at ' +
        'FROM t_group_plan ' + where + ' ORDER BY plan_id DESC LIMIT 20',
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })
}
