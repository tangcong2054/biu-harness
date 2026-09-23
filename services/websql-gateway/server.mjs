import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { validateReadOnlySql } from './policy.mjs'

const HOST = process.env.WEBSQL_GATEWAY_HOST || '127.0.0.1'
const PORT = Number(process.env.WEBSQL_GATEWAY_PORT || 43120)
const TOKEN = process.env.WEBSQL_GATEWAY_TOKEN || ''
const MAX_BODY_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 30_000
const MAX_CONCURRENT = Math.max(1, Number(process.env.WEBSQL_GATEWAY_CONCURRENCY || 4))
const ALLOWED_ORIGINS = new Set(
  String(process.env.WEBSQL_GATEWAY_ORIGINS || 'http://127.0.0.1:3141,http://localhost:3141,http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
)
let activeQueries = 0

function mysqlBin() {
  const candidates = [
    process.env.WEBSQL_MYSQL_BIN,
    '/opt/homebrew/opt/mysql-client/bin/mysql',
    '/opt/homebrew/opt/mysql@8.0/bin/mysql',
    '/opt/homebrew/bin/mysql',
    '/usr/local/bin/mysql',
    '/usr/bin/mysql',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || 'mysql'
}

function send(res, status, body, origin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'Origin'
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function corsAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin)
}

function authorized(req) {
  if (!TOKEN) return HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost'
  return req.headers.authorization === `Bearer ${TOKEN}`
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeConnection(raw = {}) {
  const port = Number(raw.port)
  return {
    host: stringValue(raw.host, '127.0.0.1'),
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : 3306,
    user: stringValue(raw.user),
    password: typeof raw.password === 'string' ? raw.password : '',
  }
}

function mysqlArgs(conn, sql, database = '') {
  const args = [
    '--protocol=TCP',
    '-h', conn.host,
    '-P', String(conn.port),
    '-u', conn.user,
    '--connect-timeout=8',
    '--batch',
    '--default-character-set=utf8mb4',
    '--skip-auto-rehash',
  ]
  if (database) args.push('-D', database)
  args.push('-e', sql)
  return args
}

function runMysql(conn, sql, timeoutMs = DEFAULT_TIMEOUT_MS, database = '') {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(mysqlBin(), mysqlArgs(conn, sql, database), {
      env: { ...process.env, ...(conn.password ? { MYSQL_PWD: conn.password } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let truncated = false
    let finished = false
    let timer
    const finish = (exitCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({
        ok: exitCode === 0 && !truncated,
        stdout,
        stderr: truncated ? `结果超过 ${MAX_OUTPUT_BYTES} 字节，查询已终止` : stderr,
        exitCode,
        ms: Date.now() - started,
        truncated,
      })
    }
    const append = (target, chunk) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        truncated = true
        child.kill('SIGKILL')
        return
      }
      if (target === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.on('error', (error) => {
      stderr += error.message
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
    timer = setTimeout(() => {
      stderr = `查询超过 ${timeoutMs}ms，已终止`
      child.kill('SIGKILL')
      finish(-2)
    }, timeoutMs)
  })
}

function runMysqlPage(conn, sql, timeoutMs, database, offset, pageSize) {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(mysqlBin(), mysqlArgs(conn, sql, database), {
      env: { ...process.env, ...(conn.password ? { MYSQL_PWD: conn.password } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let pending = ''
    let stderr = ''
    let bytes = 0
    let columns = null
    let seenRows = 0
    let stoppedForPage = false
    let truncated = false
    let finished = false
    const rows = []
    let timer

    const finish = (exitCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const hasMore = rows.length > pageSize
      resolve({
        ok: (exitCode === 0 || stoppedForPage) && !truncated,
        columns: columns || [],
        rows: rows.slice(0, pageSize),
        hasMore,
        stderr: truncated ? `读取当前页时输出超过 ${MAX_OUTPUT_BYTES} 字节，查询已终止` : stderr,
        exitCode,
        ms: Date.now() - started,
        truncated,
      })
    }
    const consumeLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '')
      if (columns === null) {
        if (!line) return
        columns = line.split('\t')
        return
      }
      if (seenRows >= offset && rows.length <= pageSize) rows.push(line.split('\t'))
      seenRows += 1
      if (rows.length > pageSize && !stoppedForPage) {
        stoppedForPage = true
        child.kill('SIGTERM')
        finish(0)
      }
    }
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        truncated = true
        child.kill('SIGKILL')
        return
      }
      pending += chunk.toString()
      let newline = pending.indexOf('\n')
      while (newline >= 0 && !finished) {
        consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      stderr += error.message
      finish(-1)
    })
    child.on('close', (code) => {
      if (pending && !stoppedForPage) consumeLine(pending)
      finish(code ?? -1)
    })
    timer = setTimeout(() => {
      stderr = `查询超过 ${timeoutMs}ms，已终止`
      child.kill('SIGKILL')
      finish(-2)
    }, timeoutMs)
  })
}

function parseTsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((line) => line.length > 0)
  if (!lines.length) return { columns: [], rows: [] }
  return { columns: lines[0].split('\t'), rows: lines.slice(1).map((line) => line.split('\t')) }
}

function mysqlLiteral(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

async function withSlot(fn) {
  if (activeQueries >= MAX_CONCURRENT) return { busy: true }
  activeQueries += 1
  try {
    return { value: await fn() }
  } finally {
    activeQueries -= 1
  }
}

async function handleConnect(body) {
  const conn = normalizeConnection(body.conn)
  if (!conn.user) return { ok: false, status: 400, error: '请输入 MySQL 用户名' }
  const infoRun = await runMysql(conn, 'SELECT VERSION() AS version, CURRENT_USER() AS login_user')
  const databasesRun = await runMysql(conn, 'SHOW DATABASES')
  if (!infoRun.ok || !databasesRun.ok) {
    return { ok: false, status: 401, error: infoRun.stderr.trim() || databasesRun.stderr.trim() || 'MySQL 连接失败' }
  }
  const info = parseTsv(infoRun.stdout)
  return {
    ok: true,
    status: 200,
    info: Object.fromEntries(info.columns.map((column, index) => [column, info.rows[0]?.[index] || ''])),
    databases: parseTsv(databasesRun.stdout).rows.map((row) => row[0]).filter(Boolean),
  }
}

async function handleSchema(body) {
  const conn = normalizeConnection(body.conn)
  const database = stringValue(body.database)
  if (!database) return { ok: false, status: 400, error: '请选择数据库' }
  const table = stringValue(body.table)
  const sql = table
    ? `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ${mysqlLiteral(database)} AND TABLE_NAME = ${mysqlLiteral(table)}
        ORDER BY ORDINAL_POSITION`
    : `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ${mysqlLiteral(database)}
        ORDER BY TABLE_NAME`
  const run = await runMysql(conn, sql)
  if (!run.ok) return { ok: false, status: 422, error: run.stderr.trim() || '读取结构失败' }
  return { ok: true, status: 200, ...parseTsv(run.stdout), ms: run.ms }
}

async function handleQuery(body) {
  const conn = normalizeConnection(body.conn)
  const database = stringValue(body.database)
  const validation = validateReadOnlySql(body.sql)
  if (!validation.ok) return { ok: false, status: 403, error: validation.error }
  if (!conn.user) return { ok: false, status: 400, error: '请输入 MySQL 用户名' }
  const requestedTimeout = Number(body.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.round(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS
  const requestedPage = Number(body.page)
  const requestedPageSize = Number(body.pageSize)
  const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(100_000, requestedPage)) : 1
  const pageSize = Number.isInteger(requestedPageSize) ? Math.max(1, Math.min(500, requestedPageSize)) : 100
  const offset = (page - 1) * pageSize
  const guardedSql = [
    `SET SESSION max_execution_time = ${timeoutMs}`,
    'SET SESSION TRANSACTION READ ONLY',
    'START TRANSACTION READ ONLY',
    validation.sql,
    'ROLLBACK',
  ].join(';\n')
  const run = await runMysqlPage(conn, guardedSql, timeoutMs + 1_000, database, offset, pageSize)
  if (!run.ok) {
    return { ok: false, status: 422, error: run.stderr.trim() || `MySQL 退出码 ${run.exitCode}`, ms: run.ms, truncated: run.truncated }
  }
  return {
    ok: true,
    status: 200,
    columns: run.columns,
    rows: run.rows,
    page,
    pageSize,
    hasMore: run.hasMore,
    ms: run.ms,
    truncated: false,
  }
}

const handlers = {
  '/v1/connect': handleConnect,
  '/v1/schema': handleSchema,
  '/v1/query': handleQuery,
}

const server = createServer(async (req, res) => {
  const origin = String(req.headers.origin || '')
  if (!corsAllowed(origin)) {
    send(res, 403, { ok: false, error: 'Origin 不在允许列表' })
    return
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    })
    res.end()
    return
  }
  if (req.method === 'GET' && req.url === '/v1/health') {
    send(res, 200, {
      ok: true,
      service: 'websql-gateway',
      mysqlBin: mysqlBin(),
      authRequired: Boolean(TOKEN),
      activeQueries,
      maxConcurrent: MAX_CONCURRENT,
    }, origin)
    return
  }
  if (req.method !== 'POST' || !handlers[req.url]) {
    send(res, 404, { ok: false, error: 'Not found' }, origin)
    return
  }
  if (!authorized(req)) {
    send(res, 401, { ok: false, error: 'Gateway token 无效' }, origin)
    return
  }
  try {
    const body = await readJson(req)
    const slot = await withSlot(() => handlers[req.url](body))
    if (slot.busy) {
      send(res, 429, { ok: false, error: '并发查询已达上限' }, origin)
      return
    }
    const result = slot.value
    const { status, ...payload } = result
    send(res, status || 200, payload, origin)
  } catch (error) {
    send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, origin)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[websql-gateway] listening on http://${HOST}:${PORT}`)
  console.log(`[websql-gateway] mysql: ${mysqlBin()}`)
  console.log(`[websql-gateway] auth: ${TOKEN ? 'required' : 'local-only without token'}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
