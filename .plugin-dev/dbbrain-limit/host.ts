import { createHash, createHmac } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const name = 'dbbrain-limit'
export const inject = ['http']

/** DBbrain OpenAPI。 */
const API_HOST = 'dbbrain.tencentcloudapi.com'
const SERVICE = 'dbbrain'
const API_VERSION = '2021-05-27'

/** 凭证文件（宿主侧，600 权限，不进页面正文）。 */
const SECRET_CANDIDATES = [
  '.biu/cdb-limit-secret.json',
  '/Users/tangcong/Documents/UGit/biu-harness/.biu/cdb-limit-secret.json',
]

/** 实例列表缓存（用于实例 ID → Region 解析）。 */
const INSTANCE_TTL_MS = 10 * 60 * 1000

/** SessionToken 有效期 5 分钟，缓存留 30 秒余量。 */
const TOKEN_TTL_MS = 4.5 * 60 * 1000

/** 单次 OpenAPI 调用超时。 */
const CALL_TIMEOUT_MS = 30_000

type RouteCtx = {
  json<T = unknown>(): Promise<T>
  send(status: number, body: unknown): void
}

type Ctx = {
  http: {
    route(
      method: 'GET' | 'POST',
      pattern: string,
      handler: (route: RouteCtx) => void | Promise<void>,
    ): void
  }
}

type Cred = { secretId: string; secretKey: string; region: string; source: string }

type InstRow = {
  InstanceId: string
  InstanceName: string
  Region: string
  Vip: string
  Vport: number
  EngineVersion: string
  Product: string
  InstanceType: number
}

let instanceCache: { at: number; rows: InstRow[] } | null = null
const tokenCache = new Map<string, { token: string; at: number }>()

function text(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

function squash(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  return s.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function loadCred(): { ok: true; cred: Cred } | { ok: false; error: string } {
  const envId = process.env.TENCENTCLOUD_SECRET_ID
  const envKey = process.env.TENCENTCLOUD_SECRET_KEY
  if (envId && envKey) {
    return {
      ok: true,
      cred: {
        secretId: envId,
        secretKey: envKey,
        region: process.env.TENCENTCLOUD_REGION || 'ap-guangzhou',
        source: 'env',
      },
    }
  }
  for (const rel of SECRET_CANDIDATES) {
    const abs = rel.startsWith('/') ? rel : join(process.cwd(), rel)
    if (!existsSync(abs)) continue
    try {
      const raw = JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>
      const id = text(raw.secretId)
      const key = text(raw.secretKey)
      if (id && key) {
        return {
          ok: true,
          cred: { secretId: id, secretKey: key, region: text(raw.region) || 'ap-guangzhou', source: abs },
        }
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return {
    ok: false,
    error: '没找到 CAM 凭证：请设置环境变量 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY，或写 .biu/cdb-limit-secret.json',
  }
}

export function maskId(id: string): string {
  return id.length <= 10 ? id.slice(0, 4) + '…' : id.slice(0, 8) + '…' + id.slice(-4)
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg, 'utf-8').digest()
}

function sha256hex(msg: string): string {
  return createHash('sha256').update(msg, 'utf-8').digest('hex')
}

/** TC3-HMAC-SHA256 签名。 */
function buildHeaders(action: string, body: string, region: string, cred: Cred): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)

  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' + `host:${API_HOST}\n` + `x-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256hex(body),
  ].join('\n')

  const scope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), scope, sha256hex(canonicalRequest)].join('\n')

  const secretDate = hmac('TC3' + cred.secretKey, date)
  const secretService = hmac(secretDate, SERVICE)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf-8').digest('hex')

  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${cred.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': 'application/json; charset=utf-8',
    Host: API_HOST,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(ts),
    'X-TC-Version': API_VERSION,
    'X-TC-Region': region,
  }
}

async function callApi(
  action: string,
  payload: Record<string, unknown>,
  region: string,
): Promise<{ ok: boolean; data: Record<string, unknown>; error?: string }> {
  const got = loadCred()
  if (!got.ok) return { ok: false, data: {}, error: got.error }

  const body = JSON.stringify(payload)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      fetch(`https://${API_HOST}`, {
        method: 'POST',
        headers: buildHeaders(action, body, region, got.cred),
        body,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`调用超时（${CALL_TIMEOUT_MS / 1000}s）：${action}`)), CALL_TIMEOUT_MS)
      }),
    ])
    const json = (await res.json()) as { Response?: Record<string, unknown> }
    const resp = json.Response ?? {}
    const err = resp.Error as { Code?: string; Message?: string } | undefined
    if (err) {
      return { ok: false, data: resp, error: `${text(err.Code, 'Error')} - ${text(err.Message)}` }
    }
    return { ok: true, data: resp }
  } catch (e) {
    return { ok: false, data: {}, error: squash(e instanceof Error ? e.message : e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 拉取 DBbrain 托管实例列表（用于 ID → Region 解析与下拉选择）。 */
async function getInstances(force = false): Promise<{ ok: boolean; rows: InstRow[]; error?: string }> {
  if (!force && instanceCache && Date.now() - instanceCache.at < INSTANCE_TTL_MS) {
    return { ok: true, rows: instanceCache.rows }
  }
  const got = loadCred()
  const region = got.ok ? got.cred.region : 'ap-guangzhou'
  const rows: InstRow[] = []
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await callApi(
      'DescribeDiagDBInstances',
      { Product: 'mysql', IsSupported: true, Offset: offset, Limit: 100 },
      region,
    )
    if (!r.ok) return { ok: false, rows, error: r.error }
    const items = (r.data.Items ?? []) as InstRow[]
    rows.push(...items)
    const total = Number(r.data.TotalCount ?? 0)
    if (items.length < 100 || rows.length >= total) break
  }
  instanceCache = { at: Date.now(), rows }
  return { ok: true, rows }
}

async function resolveRegion(instanceId: string, given?: string): Promise<string> {
  if (given && given.trim()) return given.trim()
  const list = await getInstances()
  if (list.ok) {
    const hit = list.rows.find((r) => r.InstanceId === instanceId)
    if (hit?.Region) return hit.Region
  }
  const got = loadCred()
  return got.ok ? got.cred.region : 'ap-guangzhou'
}

/** VerifyUserAccount → SessionToken（5 分钟），宿主内存缓存，不落盘。 */
async function getSessionToken(
  instanceId: string,
  region: string,
  user: string,
  password: string,
  force = false,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const key = `${instanceId}|${user}`
  const hit = tokenCache.get(key)
  if (!force && hit && Date.now() - hit.at < TOKEN_TTL_MS) {
    return { ok: true, token: hit.token }
  }
  if (!user || !password) {
    return { ok: false, error: '设置限流需要数据库账号密码（用于换取会话 token），请先填写并验证' }
  }
  const r = await callApi(
    'VerifyUserAccount',
    { InstanceId: instanceId, Product: 'mysql', User: user, Password: password },
    region,
  )
  if (!r.ok) return { ok: false, error: `账号验证失败：${r.error}` }
  const token = text(r.data.SessionToken)
  if (!token) return { ok: false, error: '账号验证未返回 SessionToken' }
  tokenCache.set(key, { token, at: Date.now() })
  return { ok: true, token }
}

function dropToken(instanceId: string, user: string): void {
  tokenCache.delete(`${instanceId}|${user}`)
}

export function apply(ctx: Ctx) {
  /** 自检 + 凭证状态（只回脱敏信息）。 */
  ctx.http.route('GET', '/api/dbbrain-limit/status', async (route) => {
    const got = loadCred()
    const inst = got.ok ? await getInstances() : { ok: false, rows: [], error: undefined }
    route.send(200, {
      ok: true,
      api: { host: API_HOST, version: API_VERSION },
      hasCredential: got.ok,
      credential: got.ok
        ? { secretId: maskId(got.cred.secretId), region: got.cred.region, source: got.cred.source }
        : null,
      error: got.ok ? '' : got.error,
      instanceCount: inst.ok ? inst.rows.length : 0,
    })
  })

  /** 实例下拉（含 Region/VIP/版本）。 */
  ctx.http.route('POST', '/api/dbbrain-limit/instances', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const q = text(body.q).toLowerCase()
    const r = await getInstances(body.force === true)
    if (!r.ok) {
      route.send(200, { ok: false, error: r.error ?? '拉取实例列表失败' })
      return
    }
    let rows = r.rows
    if (q) {
      rows = rows.filter(
        (i) =>
          i.InstanceId.toLowerCase().includes(q) ||
          text(i.InstanceName).toLowerCase().includes(q) ||
          text(i.Vip).includes(q),
      )
    }
    route.send(200, {
      ok: true,
      total: r.rows.length,
      matched: rows.length,
      rows: rows.slice(0, 200),
    })
  })

  /** 活跃会话：DescribeMySqlProcessList。 */
  ctx.http.route('POST', '/api/dbbrain-limit/sessions', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    if (!instanceId) {
      route.send(200, { ok: false, error: '请填实例 ID' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const payload: Record<string, unknown> = {
      InstanceId: instanceId,
      Product: 'mysql',
      Limit: Math.min(200, Math.max(1, Number(body.limit) || 50)),
    }
    for (const k of ['ID', 'User', 'Host', 'DB', 'State', 'Command', 'Info'] as const) {
      const v = body[k]
      if (typeof v === 'string' && v.trim()) payload[k] = k === 'ID' ? Number(v) : v.trim()
    }
    if (body.time != null && String(body.time).trim() !== '') payload.Time = Number(body.time)

    const r = await callApi('DescribeMySqlProcessList', payload, region)
    if (!r.ok) {
      route.send(200, { ok: false, error: r.error, region })
      return
    }
    const rows = ((r.data.ProcessList ?? []) as Record<string, unknown>[]).map((p) => ({
      id: text(p.ID),
      user: text(p.User),
      host: text(p.Host),
      db: text(p.DB),
      command: text(p.Command),
      time: text(p.Time),
      state: text(p.State),
      info: text(p.Info),
    }))
    route.send(200, { ok: true, region, at: new Date().toISOString(), count: rows.length, rows })
  })

  /** 验证数据库账号（换 SessionToken）。 */
  ctx.http.route('POST', '/api/dbbrain-limit/verify', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    const user = text(body.user)
    const password = text(body.password)
    if (!instanceId || !user) {
      route.send(200, { ok: false, error: '需要实例 ID 与数据库账号' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    dropToken(instanceId, user)
    const r = await getSessionToken(instanceId, region, user, password, true)
    route.send(200, r.ok ? { ok: true, region, tokenReady: true } : { ok: false, error: r.error, region })
  })

  /** 限流任务列表：DescribeSqlFilters。 */
  ctx.http.route('POST', '/api/dbbrain-limit/filters/list', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    if (!instanceId) {
      route.send(200, { ok: false, error: '请填实例 ID' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const payload: Record<string, unknown> = {
      InstanceId: instanceId,
      Product: 'mysql',
      Offset: Number(body.offset) || 0,
      Limit: Math.min(100, Math.max(1, Number(body.limit) || 20)),
    }
    if (Array.isArray(body.statuses) && body.statuses.length) payload.Statuses = body.statuses
    if (Array.isArray(body.filterIds) && body.filterIds.length) payload.FilterIds = body.filterIds

    const r = await callApi('DescribeSqlFilters', payload, region)
    if (!r.ok) {
      route.send(200, { ok: false, error: r.error, region })
      return
    }
    const items = ((r.data.Items ?? []) as Record<string, unknown>[]).map((it) => ({
      id: text(it.Id),
      status: text(it.Status),
      sqlType: text(it.SqlType),
      maxConcurrency: text(it.MaxConcurrency),
      currentConcurrency: text(it.CurrentConcurrency),
      rejectedSqlCount: text(it.RejectedSqlCount),
      originKeys: text(it.OriginKeys),
      originRule: text(it.OriginRule),
      createTime: text(it.CreateTime),
      expireTime: text(it.ExpireTime),
      currentTime: text(it.CurrentTime),
    }))
    route.send(200, {
      ok: true,
      region,
      total: Number(r.data.TotalCount ?? items.length),
      rows: items,
    })
  })

  /** 创建限流任务：CreateSqlFilter。 */
  ctx.http.route('POST', '/api/dbbrain-limit/filters/create', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    const user = text(body.user)
    const sqlType = text(body.sqlType)
    const filterKey = text(body.filterKey)
    if (!instanceId || !sqlType || !filterKey) {
      route.send(200, { ok: false, error: '需要实例 ID、SQL 类型、关键词' })
      return
    }
    const maxConcurrency = Math.max(0, Number(body.maxConcurrency) || 0)
    const duration = Number(body.duration)
    if (!Number.isFinite(duration)) {
      route.send(200, { ok: false, error: '需要限流时长（秒），-1 表示永不过期' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const tok = await getSessionToken(instanceId, region, user, text(body.password))
    if (!tok.ok) {
      route.send(200, { ok: false, error: tok.error, region, needToken: true })
      return
    }
    const r = await callApi(
      'CreateSqlFilter',
      {
        InstanceId: instanceId,
        Product: 'mysql',
        SqlType: sqlType,
        FilterKey: filterKey,
        MaxConcurrency: maxConcurrency,
        Duration: duration,
        SessionToken: tok.token,
      },
      region,
    )
    if (!r.ok) {
      if (/session|token/i.test(r.error ?? '')) dropToken(instanceId, user)
      route.send(200, { ok: false, error: r.error, region, needToken: /session|token/i.test(r.error ?? '') })
      return
    }
    route.send(200, { ok: true, region, filterId: text(r.data.FilterId) })
  })

  /** 终止限流：ModifySqlFilters（Status 仅支持 TERMINATED）。 */
  ctx.http.route('POST', '/api/dbbrain-limit/filters/modify', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    const user = text(body.user)
    const ids = (Array.isArray(body.filterIds) ? body.filterIds : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
    if (!instanceId || !ids.length) {
      route.send(200, { ok: false, error: '需要实例 ID 与任务 ID' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const tok = await getSessionToken(instanceId, region, user, text(body.password))
    if (!tok.ok) {
      route.send(200, { ok: false, error: tok.error, region, needToken: true })
      return
    }
    const r = await callApi(
      'ModifySqlFilters',
      {
        InstanceId: instanceId,
        Product: 'mysql',
        FilterIds: ids,
        Status: 'TERMINATED',
        SessionToken: tok.token,
      },
      region,
    )
    if (!r.ok) {
      if (/session|token/i.test(r.error ?? '')) dropToken(instanceId, user)
      route.send(200, { ok: false, error: r.error, region, needToken: /session|token/i.test(r.error ?? '') })
      return
    }
    route.send(200, { ok: true, region, terminated: ids })
  })

  /** 删除限流任务：DeleteSqlFilters。 */
  ctx.http.route('POST', '/api/dbbrain-limit/filters/delete', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    const user = text(body.user)
    const ids = (Array.isArray(body.filterIds) ? body.filterIds : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
    if (!instanceId || !ids.length) {
      route.send(200, { ok: false, error: '需要实例 ID 与任务 ID' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const tok = await getSessionToken(instanceId, region, user, text(body.password))
    if (!tok.ok) {
      route.send(200, { ok: false, error: tok.error, region, needToken: true })
      return
    }
    const r = await callApi(
      'DeleteSqlFilters',
      { InstanceId: instanceId, Product: 'mysql', FilterIds: ids, SessionToken: tok.token },
      region,
    )
    if (!r.ok) {
      if (/session|token/i.test(r.error ?? '')) dropToken(instanceId, user)
      route.send(200, { ok: false, error: r.error, region, needToken: /session|token/i.test(r.error ?? '') })
      return
    }
    route.send(200, { ok: true, region, deleted: ids })
  })

  /**
   * Kill 会话：KillMySqlThreads。
   * 两阶段（Prepare / Commit）在**同一次请求内**连做——文档要求两阶段间隔 <10 秒，
   * 拆成两次前端调用容易超时导致 Commit 空转。
   */
  ctx.http.route('POST', '/api/dbbrain-limit/kill', async (route) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await route.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    const instanceId = text(body.instanceId)
    const threads = (Array.isArray(body.threads) ? body.threads : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
    if (!instanceId || !threads.length) {
      route.send(200, { ok: false, error: '需要实例 ID 与会话 ID' })
      return
    }
    const region = await resolveRegion(instanceId, text(body.region))
    const base: Record<string, unknown> = {
      InstanceId: instanceId,
      Product: 'mysql',
      Threads: threads,
      RecordHistory: body.recordHistory === false ? false : true,
    }

    const prep = await callApi('KillMySqlThreads', { ...base, Stage: 'Prepare' }, region)
    if (!prep.ok) {
      route.send(200, { ok: false, phase: 'Prepare', error: prep.error, region })
      return
    }
    const execId = text(prep.data.SqlExecId)
    if (!execId) {
      route.send(200, { ok: false, phase: 'Prepare', error: 'Prepare 未返回 SqlExecId', region })
      return
    }

    const commit = await callApi(
      'KillMySqlThreads',
      { InstanceId: instanceId, Product: 'mysql', Stage: 'Commit', SqlExecId: execId },
      region,
    )
    if (!commit.ok) {
      route.send(200, { ok: false, phase: 'Commit', error: commit.error, region })
      return
    }
    const done = (Array.isArray(commit.data.Threads) ? commit.data.Threads : []).map((x) => text(x))
    route.send(200, { ok: true, region, killed: done, requested: threads.map((t) => String(t)) })
  })
}
