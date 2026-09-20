import { createHash, createHmac } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const name = 'cdb-limit-onclick'
export const inject = ['http']

/** DBbrain OpenAPI。 */
const API_HOST = 'dbbrain.tencentcloudapi.com'
const SERVICE = 'dbbrain'
const API_VERSION = '2021-05-27'

/** 凭证文件（宿主侧，不进页面正文）。 */
const SECRET_CANDIDATES = [
  '.biu/cdb-limit-secret.json',
  '/Users/tangcong/Documents/UGit/biu-harness/.biu/cdb-limit-secret.json',
]

/** SessionToken 有效期 5 分钟，缓存留 30 秒余量。 */
const TOKEN_TTL_MS = 4.5 * 60 * 1000

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

function maskId(id: string): string {
  return id.length <= 10 ? id.slice(0, 4) + '…' : id.slice(0, 8) + '…' + id.slice(-4)
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg, 'utf-8').digest()
}

function sha256hex(msg: string): string {
  return createHash('sha256').update(msg, 'utf-8').digest('hex')
}

/** TC3-HMAC-SHA256 签名（与 dbbrain-limit 一致的算法）。 */
function buildHeaders(action: string, body: string, region: string, cred: Cred): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' + `host:${API_HOST}\n` + `x-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n')
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
      fetch(`https://${API_HOST}`, { method: 'POST', headers: buildHeaders(action, body, region, got.cred), body }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`调用超时（${CALL_TIMEOUT_MS / 1000}s）：${action}`)), CALL_TIMEOUT_MS)
      }),
    ])
    const json = (await res.json()) as { Response?: Record<string, unknown> }
    const resp = json.Response ?? {}
    const err = resp.Error as { Code?: string; Message?: string } | undefined
    if (err) return { ok: false, data: resp, error: `${text(err.Code, 'Error')} - ${text(err.Message)}` }
    return { ok: true, data: resp }
  } catch (e) {
    return { ok: false, data: {}, error: squash(e instanceof Error ? e.message : e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function regionOf(given: unknown, cred: Cred): string {
  const g = text(given).trim()
  return g || cred.region || 'ap-guangzhou'
}

/** VerifyUserAccount → SessionToken（内存缓存，不落盘）。 */
async function getToken(
  instanceId: string,
  region: string,
  user: string,
  password: string,
  force = false,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (!user || !password) {
    return { ok: false, error: '下发限流需要数据库账号密码（用于换 SessionToken），请先填写' }
  }
  const key = `${instanceId}|${user}`
  const hit = tokenCache.get(key)
  if (!force && hit && Date.now() - hit.at < TOKEN_TTL_MS) return { ok: true, token: hit.token }
  const r = await callApi('VerifyUserAccount', { InstanceId: instanceId, Product: 'mysql', User: user, Password: password }, region)
  if (!r.ok) return { ok: false, error: `账号验证失败：${r.error}` }
  const token = text(r.data.SessionToken)
  if (!token) return { ok: false, error: '账号验证未返回 SessionToken' }
  tokenCache.set(key, { token, at: Date.now() })
  return { ok: true, token }
}

function normalizeFilter(row: Record<string, unknown>) {
  return {
    id: text(row.Id),
    status: text(row.Status),
    sqlType: text(row.SqlType),
    maxConcurrency: text(row.MaxConcurrency),
    currentConcurrency: text(row.CurrentConcurrency),
    rejectedSqlCount: text(row.RejectedSqlCount),
    originKeys: text(row.OriginKeys),
    originRule: text(row.OriginRule),
    createTime: text(row.CreateTime),
    expireTime: text(row.ExpireTime),
  }
}

export function apply(ctx: Ctx) {
  /** 自检：凭证是否就绪（SecretId 脱敏，不回传密钥）。 */
  ctx.http.route('GET', '/api/cdb-limit-onclick/status', async (r) => {
    const got = loadCred()
    r.send(200, {
      ok: true,
      api: { host: API_HOST, version: API_VERSION },
      hasCredential: got.ok,
      credential: got.ok
        ? { secretId: maskId(got.cred.secretId), region: got.cred.region, source: got.cred.source }
        : null,
      error: got.ok ? '' : got.error,
    })
  })

  /** 查限流任务（默认全状态）。 */
  ctx.http.route('POST', '/api/cdb-limit-onclick/list', async (r) => {
    let body: Record<string, unknown> = {}
    try {
      body = (await r.json()) ?? {}
    } catch {
      body = {}
    }
    const got = loadCred()
    if (!got.ok) {
      r.send(200, { ok: false, error: got.error })
      return
    }
    const instanceId = text(body.instanceId).trim()
    if (!instanceId) {
      r.send(200, { ok: false, error: '请填实例 ID' })
      return
    }
    const region = regionOf(body.region, got.cred)
    const payload: Record<string, unknown> = { InstanceId: instanceId, Product: 'mysql', Offset: 0, Limit: 100 }
    if (Array.isArray(body.statuses) && body.statuses.length) payload.Statuses = body.statuses
    const res = await callApi('DescribeSqlFilters', payload, region)
    if (!res.ok) {
      r.send(200, { ok: false, error: res.error, region })
      return
    }
    const rows = ((res.data.Items ?? []) as Record<string, unknown>[]).map(normalizeFilter)
    r.send(200, { ok: true, region, total: Number(res.data.TotalCount ?? rows.length), rows })
  })

  /** 下发限流：VerifyUserAccount → CreateSqlFilter。 */
  ctx.http.route('POST', '/api/cdb-limit-onclick/create', async (r) => {
    let body: Record<string, unknown> = {}
    try {
      body = (await r.json()) ?? {}
    } catch {
      body = {}
    }
    const got = loadCred()
    if (!got.ok) {
      r.send(200, { ok: false, error: got.error })
      return
    }
    const instanceId = text(body.instanceId).trim()
    const sqlType = text(body.sqlType).trim().toUpperCase()
    const filterKey = text(body.filterKey).trim()
    if (!instanceId || !sqlType || !filterKey) {
      r.send(200, { ok: false, error: '需要实例 ID、SQL 类型、关键词' })
      return
    }
    const maxConcurrency = Math.max(0, Number(body.maxConcurrency) || 0)
    const duration = Number(body.duration)
    if (!Number.isFinite(duration)) {
      r.send(200, { ok: false, error: '需要限流时长（秒），-1 表示永不过期' })
      return
    }
    const region = regionOf(body.region, got.cred)
    const tok = await getToken(instanceId, region, text(body.user).trim(), text(body.password))
    if (!tok.ok) {
      r.send(200, { ok: false, error: tok.error, needToken: true })
      return
    }
    const res = await callApi(
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
    if (!res.ok) {
      tokenCache.delete(`${instanceId}|${text(body.user).trim()}`)
      r.send(200, { ok: false, error: res.error, needToken: true })
      return
    }
    r.send(200, {
      ok: true,
      region,
      filterId: text(res.data.FilterId),
      rule: `${sqlType},${duration},${maxConcurrency},${filterKey}`,
    })
  })

  /** 终止限流任务（ModifySqlFilters 只支持 Status=TERMINATED）。 */
  ctx.http.route('POST', '/api/cdb-limit-onclick/terminate', async (r) => {
    let body: Record<string, unknown> = {}
    try {
      body = (await r.json()) ?? {}
    } catch {
      body = {}
    }
    const got = loadCred()
    if (!got.ok) {
      r.send(200, { ok: false, error: got.error })
      return
    }
    const instanceId = text(body.instanceId).trim()
    const ids = (Array.isArray(body.filterIds) ? body.filterIds : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
    if (!instanceId || !ids.length) {
      r.send(200, { ok: false, error: '需要实例 ID 与任务 ID' })
      return
    }
    const region = regionOf(body.region, got.cred)
    const user = text(body.user).trim()
    const tok = await getToken(instanceId, region, user, text(body.password))
    if (!tok.ok) {
      r.send(200, { ok: false, error: tok.error, needToken: true })
      return
    }
    const res = await callApi(
      'ModifySqlFilters',
      { InstanceId: instanceId, Product: 'mysql', FilterIds: ids, Status: 'TERMINATED', SessionToken: tok.token },
      region,
    )
    if (!res.ok) {
      tokenCache.delete(`${instanceId}|${user}`)
      r.send(200, { ok: false, error: res.error, needToken: true })
      return
    }
    r.send(200, { ok: true, region, terminated: ids })
  })
}
