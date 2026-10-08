import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_LLM_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_LLM_LOG_RETENTION_DAYS = 7

export type TencentTokenPlanLogEntry = {
  event: 'throttled' | 'retry_succeeded' | 'retry_failed'
  model: string
  endpointId?: string
  status?: number
  code?: string | number
  requestId?: string
  retryAfterMs?: number
  attempt: number
  estimatedTokens: number
  maxOutputTokens?: number
  localWindowTokens: number
  localCapacity: number
  blockedUntil?: number
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function llmLogDirectory(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
) {
  return env.BIU_LLM_LOG_DIR?.trim() ||
    join(env.BIU_HOME?.trim() || cwd, '.biu', 'logs')
}

function day(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

function cleanupOldLogs(dir: string, now: number, retentionDays: number) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(dir)) {
    if (!/^host-llm-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name)) continue
    const fileDay = Date.parse(`${name.slice(9, 19)}T00:00:00.000Z`)
    if (Number.isFinite(fileDay) && fileDay < cutoff) rmSync(join(dir, name), { force: true })
  }
}

/** 脱敏、尽力写入；日志故障绝不能影响模型请求。 */
export function appendTencentTokenPlanLog(
  entry: TencentTokenPlanLogEntry,
  options: {
    env?: Record<string, string | undefined>
    cwd?: string
    now?: number
  } = {},
) {
  try {
    const env = options.env ?? process.env
    const now = options.now ?? Date.now()
    const dir = llmLogDirectory(env, options.cwd)
    mkdirSync(dir, { recursive: true })
    const retentionDays = positiveInt(
      env.BIU_LLM_LOG_RETENTION_DAYS,
      DEFAULT_LLM_LOG_RETENTION_DAYS,
    )
    cleanupOldLogs(dir, now, retentionDays)

    const base = `host-llm-${day(now)}`
    let file = join(dir, `${base}.jsonl`)
    const maxBytes = positiveInt(env.BIU_LLM_LOG_MAX_BYTES, DEFAULT_LLM_LOG_MAX_BYTES)
    if (existsSync(file) && statSync(file).size >= maxBytes) {
      let suffix = 1
      while (existsSync(join(dir, `${base}-${suffix}.jsonl`))) suffix += 1
      renameSync(file, join(dir, `${base}-${suffix}.jsonl`))
    }

    const record = {
      ts: new Date(now).toISOString(),
      provider: 'tencent-token-plan',
      ...entry,
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return file
  } catch {
    return undefined
  }
}
