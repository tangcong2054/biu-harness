import type { LlmConfig, LlmUsage } from './index.ts'

export const DEFAULT_TENCENT_TOKEN_PLAN_TPM = 3_000_000
export const DEFAULT_TPM_HEADROOM = 0.9
export const TPM_WINDOW_MS = 60_000

type TokenEvent = {
  id: number
  at: number
  tokens: number
}

export type TpmReservation = {
  finish(usage?: LlmUsage): void
  cancel(): void
}

type LimiterOptions = {
  limit: number
  headroom?: number
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const finish = (callback: () => void) => {
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const onAbort = () => {
      clearTimeout(timer)
      finish(() => reject(new Error('cancelled')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function usageTokens(usage?: LlmUsage) {
  if (!usage) return undefined
  if (Number.isFinite(usage.totalTokens) && Number(usage.totalTokens) >= 0) {
    return Math.floor(Number(usage.totalTokens))
  }
  return Math.max(0, Math.floor(usage.inputTokens + usage.outputTokens))
}

/** 腾讯云 Token Plan：按模型 TPM 做进程级 FIFO 滚动窗口调度。 */
export class TencentTokenPlanTpmLimiter {
  readonly capacity: number
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private events: TokenEvent[] = []
  private nextId = 1
  private queue: Promise<void> = Promise.resolve()

  constructor(options: LimiterOptions) {
    const headroom =
      Number.isFinite(options.headroom) && Number(options.headroom) > 0 && Number(options.headroom) <= 1
        ? Number(options.headroom)
        : DEFAULT_TPM_HEADROOM
    this.capacity = Math.max(1, Math.floor(options.limit * headroom))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? abortableSleep
  }

  private prune(now: number) {
    this.events = this.events.filter((event) => event.at + TPM_WINDOW_MS > now)
  }

  private async reserve(tokens: number, signal?: AbortSignal): Promise<TpmReservation> {
    if (tokens > this.capacity) {
      throw new Error(
        `腾讯云 Token Plan 单次请求预计 ${tokens} token，超过本地 TPM 安全容量 ${this.capacity}；请先压缩上下文或提高 TENCENT_TOKEN_PLAN_TPM`,
      )
    }
    while (true) {
      if (signal?.aborted) throw new Error('cancelled')
      const now = this.now()
      this.prune(now)
      const used = this.events.reduce((sum, event) => sum + event.tokens, 0)
      if (used + tokens <= this.capacity) {
        const event: TokenEvent = { id: this.nextId++, at: now, tokens }
        this.events.push(event)
        return {
          finish: (usage) => {
            const actual = usageTokens(usage)
            if (actual !== undefined) event.tokens = actual
          },
          cancel: () => {
            this.events = this.events.filter((item) => item.id !== event.id)
          },
        }
      }

      let releasable = used
      let waitUntil = now + TPM_WINDOW_MS
      for (const event of this.events) {
        releasable -= event.tokens
        waitUntil = event.at + TPM_WINDOW_MS
        if (releasable + tokens <= this.capacity) break
      }
      await this.sleep(Math.max(1, waitUntil - now), signal)
    }
  }

  acquire(tokens: number, signal?: AbortSignal): Promise<TpmReservation> {
    const normalized = Math.max(1, Math.floor(tokens))
    const pending = this.queue.then(() => this.reserve(normalized, signal))
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
}

export function isTencentTokenPlan(config: LlmConfig) {
  if (config.endpointId === 'token-plan') return true
  try {
    const url = new URL(config.baseUrl ?? '')
    return (
      url.hostname.toLowerCase() === 'api.lkeap.cloud.tencent.com' &&
      /^\/plan(?:\/|$)/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function resolveTencentTokenPlanTpm(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = Number(env.TENCENT_TOKEN_PLAN_TPM)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TENCENT_TOKEN_PLAN_TPM
}

export function resolveTencentTokenPlanHeadroom(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = Number(env.TENCENT_TOKEN_PLAN_TPM_HEADROOM)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : DEFAULT_TPM_HEADROOM
}
