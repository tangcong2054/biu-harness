import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const name = 'cost-reconcile'
export const inject = ['http', 'sandbox']

/**
 * 造价三方对账 —— 跨表 join 是「执行」，不是「描述」。
 *
 * 三张表按清单编码对齐：合同清单 t_cost_item / 签证变更 t_cost_change / 结算 t_settlement。
 *   - 改一条签证（真 INSERT 进 t_cost_change）→ 差异立刻重算，看得见哪一条变化影响了多少钱
 *   - 写一条结论（真 INSERT 进 t_cost_diff）→ 差异从「一段话」变成一行可核的结论
 *
 * 安全边界：写操作白名单只有 t_cost_change / t_cost_diff；
 * 对账 SQL 是文件里写死的模板，外部只能传 project id，不能传 SQL。
 */

const DEFAULT_CONN = { host: '127.0.0.1', port: 3306, user: 'root', database: 'cost_demo' }
const WRITE_TABLES = new Set(['t_cost_change', 't_cost_diff'])
const MAX_ROWS = 2000
const DEFAULT_TIMEOUT = 20000

type Conn = { host: string; port: number; user: string; database: string; password: string }

function str(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeConn(input: unknown): Conn {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    host: str(raw.host, DEFAULT_CONN.host),
    port: Math.max(1, Math.round(num(raw.port, DEFAULT_CONN.port))),
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

/** 三方对齐 SQL：合同 → 变更后（含签证）→ 结算。差异 = 结算 - 变更后。 */
function reconcileSql(projId: number, threshold: number) {
  const projWhere = projId > 0 ? ' AND i.proj_id = ' + projId : ''
  return [
    'SELECT p.proj_id AS proj_id, p.proj_name AS proj_name, i.code AS code, i.item_name AS item_name, i.unit AS unit,',
    '  ROUND(i.qty,2) AS contract_qty, ROUND(i.unit_price,2) AS contract_price, ROUND(i.qty * i.unit_price, 2) AS contract_amt,',
    '  ROUND(i.qty + COALESCE(c.dq, 0), 2) AS changed_qty,',
    '  ROUND(i.unit_price + COALESCE(c.dp, 0), 2) AS changed_price,',
    '  ROUND((i.qty + COALESCE(c.dq, 0)) * (i.unit_price + COALESCE(c.dp, 0)), 2) AS changed_amt,',
    '  ROUND(s.settle_qty, 2) AS settle_qty, ROUND(s.settle_price, 2) AS settle_price,',
    '  ROUND(s.settle_qty * s.settle_price, 2) AS settle_amt,',
    '  ROUND(s.settle_qty * s.settle_price - (i.qty + COALESCE(c.dq, 0)) * (i.unit_price + COALESCE(c.dp, 0)), 2) AS delta,',
    '  ROUND(100 * (s.settle_qty * s.settle_price - (i.qty + COALESCE(c.dq, 0)) * (i.unit_price + COALESCE(c.dp, 0)))',
    '        / NULLIF((i.qty + COALESCE(c.dq, 0)) * (i.unit_price + COALESCE(c.dp, 0)), 0), 2) AS over_rate,',
    '  COALESCE(s.reported_by, "-") AS reported_by, COALESCE(s.reported_on, "-") AS reported_on',
    'FROM t_cost_item i',
    'JOIN t_project p ON p.proj_id = i.proj_id',
    'LEFT JOIN (SELECT proj_id, code, SUM(qty_delta) AS dq, SUM(price_delta) AS dp FROM t_cost_change GROUP BY proj_id, code) c',
    '  ON c.proj_id = i.proj_id AND c.code = i.code',
    'LEFT JOIN t_settlement s ON s.proj_id = i.proj_id AND s.code = i.code',
    'WHERE 1 = 1' + projWhere,
    'ORDER BY ABS(s.settle_qty * s.settle_price - (i.qty + COALESCE(c.dq, 0)) * (i.unit_price + COALESCE(c.dp, 0))) DESC',
  ].join('\n')
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

  async function reconcile(conn: Conn, projId: number, threshold: number) {
    const out = await query(assertReadOnly(reconcileSql(projId, threshold)), conn)
    const cols = out.columns
    const iDelta = cols.indexOf('delta')
    const iName = cols.indexOf('item_name')
    const rows = out.rows.map((r) => {
      const delta = Number(r[iDelta]) || 0
      const over = Number(r[cols.indexOf('over_rate')]) || 0
      const flag = Math.abs(delta) <= threshold ? '一致'
        : (Math.abs(over) >= 10 ? '超支' : (delta > 0 ? '结算偏高' : '结算偏低'))
      return { cells: r, item_name: r[iName], delta, over_rate: over, flag }
    })
    return { columns: cols, rows, ms: out.ms }
  }

  ctx.http.route('GET', '/api/cost-reconcile/health', (route: any) => {
    route.send(200, { ok: true, plugin: name, bin, defaults: DEFAULT_CONN, writes: [...WRITE_TABLES] })
  })

  ctx.http.route('GET', '/api/cost-reconcile/projects', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(assertReadOnly('SELECT proj_id, proj_name, proj_type, year FROM t_project ORDER BY proj_id'), conn)
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 三方对账主接口：真跨三张表 join。 */
  ctx.http.route('GET', '/api/cost-reconcile/reconcile', async (route: any) => {
    try {
      const conn = qsConn(route)
      const projId = Math.max(0, Math.round(num(qs(route, 'proj_id'), 0)))
      const threshold = num(qs(route, 'threshold'), 1)
      const out = await reconcile(conn, projId, threshold)
      const diffs = out.rows.filter((r) => r.flag !== '一致')
      const summary = await query(
        assertReadOnly(
          'SELECT COUNT(*), ROUND(SUM(i.qty * i.unit_price), 2) FROM t_cost_item i' + (projId > 0 ? ' WHERE i.proj_id = ' + projId : ''),
        ),
        conn,
      )
      route.send(200, {
        ok: true,
        columns: out.columns,
        rows: out.rows.map((r) => r.cells),
        flags: out.rows.map((r) => r.flag),
        diffs: diffs.map((r) => ({ item_name: r.item_name, delta: r.delta, over_rate: r.over_rate, flag: r.flag })),
        diffCount: diffs.length,
        diffAmount: Math.round(diffs.reduce((sum, r) => sum + r.delta, 0) * 100) / 100,
        absAmount: Math.round(diffs.reduce((sum, r) => sum + Math.abs(r.delta), 0) * 100) / 100,
        itemCount: Number(summary.rows[0] ? summary.rows[0][0] : 0),
        contractTotal: Number(summary.rows[0] ? summary.rows[0][1] : 0),
        ms: out.ms,
        sql: reconcileSql(projId, threshold),
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 签证变更列表 —— 这是「记录」那一侧，看得见每次改了什么。 */
  ctx.http.route('GET', '/api/cost-reconcile/changes', async (route: any) => {
    try {
      const conn = qsConn(route)
      const projId = Math.max(0, Math.round(num(qs(route, 'proj_id'), 0)))
      const where = projId > 0 ? ' WHERE c.proj_id = ' + projId : ''
      const out = await query(
        assertReadOnly(
          'SELECT c.change_id, p.proj_name, c.code, i.item_name, c.change_type, ROUND(c.qty_delta,2), ROUND(c.price_delta,2), c.reason, c.filed_on, c.approved ' +
          'FROM t_cost_change c JOIN t_project p ON p.proj_id = c.proj_id ' +
          'LEFT JOIN (SELECT DISTINCT proj_id, code, item_name FROM t_cost_item) i ON i.proj_id = c.proj_id AND i.code = c.code' +
          where + ' ORDER BY c.change_id DESC LIMIT 30',
        ),
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /**
   * 新增一条签证变更 —— 真写库，然后立刻重算差异。
   * 返回 before/after 的差额对比：这就是「签证一变，差异立刻重算」。
   */
  ctx.http.route('POST', '/api/cost-reconcile/change', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const projId = Math.round(num(body.proj_id, 0))
      const code = str(body.code)
      const type = str(body.change_type, '量增')
      const dq = num(body.qty_delta, 0)
      const dp = num(body.price_delta, 0)
      const reason = str(body.reason, '现场签证')
      const approved = body.approved === false ? 0 : 1
      if (!projId || !code) { route.send(200, { ok: false, error: 'proj_id / code 必填' }); return }
      if (!['量增', '量减', '价调'].includes(type)) { route.send(200, { ok: false, error: 'change_type 只接受 量增/量减/价调' }); return }
      if (!dq && !dp) { route.send(200, { ok: false, error: 'qty_delta 与 price_delta 至少给一个' }); return }

      const before = await reconcile(conn, projId, 1)
      const today = new Date().toISOString().slice(0, 10)
      const insert = assertWrite(
        'INSERT INTO t_cost_change (proj_id, code, change_type, qty_delta, price_delta, reason, filed_on, approved) VALUES (' +
        lit(projId) + ', ' + lit(code) + ', ' + lit(type) + ', ' + dq + ', ' + dp + ', ' + lit(reason) + ', ' + lit(today) + ', ' + approved + ')',
      )
      await query(insert, conn)
      const after = await reconcile(conn, projId, 1)

      // code -> 定位到那一行，取它的差额变化（列名不要靠位置猜）
      const pick = (set: typeof before) => {
        const iCode = set.columns.indexOf('code')
        const hit = set.rows.find((r) => iCode >= 0 && r.cells[iCode] === code)
        return hit ? { item_name: hit.item_name, delta: hit.delta, over_rate: hit.over_rate, flag: hit.flag } : null
      }
      const back = await query(
        assertReadOnly('SELECT change_id FROM t_cost_change WHERE proj_id = ' + projId + ' ORDER BY change_id DESC LIMIT 1'),
        conn,
      )
      route.send(200, {
        ok: true,
        change_id: Number(back.rows[0] ? back.rows[0][0] : 0),
        before: { diffCount: before.rows.filter((r) => r.flag !== '一致').length, absAmount: Math.round(before.rows.reduce((s, r) => s + Math.abs(r.delta), 0) * 100) / 100, item: pick(before) },
        after: { diffCount: after.rows.filter((r) => r.flag !== '一致').length, absAmount: Math.round(after.rows.reduce((s, r) => s + Math.abs(r.delta), 0) * 100) / 100, item: pick(after) },
        wrote: insert,
      })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 把一条差异写成结论 —— 真写 t_cost_diff。 */
  ctx.http.route('POST', '/api/cost-reconcile/write-diff', async (route: any) => {
    try {
      const body = (await route.json().catch(() => ({}))) ?? {}
      const conn = normalizeConn(body.conn)
      const items = Array.isArray(body.items) ? body.items.slice(0, 20) : []
      const confirmedBy = str(body.confirmed_by, '造价组')
      if (!items.length) { route.send(200, { ok: false, error: 'items 为空' }); return }
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const values = items.map((item: Record<string, unknown>) =>
        '(' + [
          lit(Math.round(num(item.proj_id, 0))), lit(item.proj_name), lit(item.code), lit(item.item_name),
          num(item.contract_amt, 0), num(item.changed_amt, 0), num(item.settle_amt, 0),
          num(item.delta, 0), num(item.over_rate, 0),
          lit(item.reason).slice(0, 200), lit(confirmedBy), lit(stamp),
        ].join(', ') + ')',
      )
      const insert = assertWrite(
        'INSERT INTO t_cost_diff (proj_id, proj_name, code, item_name, contract_amt, changed_amt, settle_amt, delta, over_rate, reason, confirmed_by, created_at) VALUES ' +
        values.join(', '),
      )
      await query(insert, conn)
      const back = await query(
        assertReadOnly(
          'SELECT diff_id, proj_name, item_name, ROUND(delta,2), ROUND(over_rate,2), reason, confirmed_by, DATE_FORMAT(created_at, "%m-%d %H:%i") ' +
          'FROM t_cost_diff ORDER BY diff_id DESC LIMIT ' + items.length,
        ),
        conn,
      )
      route.send(200, { ok: true, written: items.length, diffs: back.rows, wrote: insert })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  ctx.http.route('GET', '/api/cost-reconcile/diffs', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT diff_id, proj_name, code, item_name, ROUND(contract_amt,2), ROUND(changed_amt,2), ROUND(settle_amt,2), ROUND(delta,2), ROUND(over_rate,2), reason, confirmed_by, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") ' +
          'FROM t_cost_diff ORDER BY diff_id DESC LIMIT 20',
        ),
        conn,
      )
      const agg = await query(assertReadOnly('SELECT COUNT(*), ROUND(SUM(delta),2) FROM t_cost_diff'), conn)
      route.send(200, { ok: true, ...out, summary: agg.rows[0] ?? null })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })

  /** 材料信息价对照 —— 「跨表 join 是执行」的第二个证据。 */
  ctx.http.route('GET', '/api/cost-reconcile/material', async (route: any) => {
    try {
      const conn = qsConn(route)
      const out = await query(
        assertReadOnly(
          'SELECT material, MAX(CASE WHEN region = "本市" AND period = "2026-03" THEN price END) AS 本市3月, ' +
          '       MAX(CASE WHEN region = "邻市" AND period = "2026-03" THEN price END) AS 邻市3月, ' +
          '       ROUND(100 * (MAX(CASE WHEN region = "本市" AND period = "2026-03" THEN price END) ' +
          '                 - MAX(CASE WHEN region = "邻市" AND period = "2026-03" THEN price END)) ' +
          '           / NULLIF(MAX(CASE WHEN region = "邻市" AND period = "2026-03" THEN price END), 0), 2) AS 价差百分比 ' +
          'FROM t_material_price GROUP BY material ORDER BY 价差百分比 DESC',
        ),
        conn,
      )
      route.send(200, { ok: true, ...out })
    } catch (error) {
      route.send(200, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  })
}
