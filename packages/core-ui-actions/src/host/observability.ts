import {
  appendFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'

export const UI_ACTION_LOG_BATCH_SIZE = 50
export const UI_ACTION_LOG_QUEUE_MAX = 1000
export const UI_ACTION_LOG_FLUSH_MS = 1000
export const UI_ACTION_LOG_MAX_BYTES = 10 * 1024 * 1024
export const UI_ACTION_LOG_RETENTION_DAYS = 7

export type UiActionObservedEvent =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'approval_requested'
  | 'approval_denied'
  | 'registry_changed'
  | 'cache_hit'
  | 'cache_miss'

export type UiActionLogEntry = {
  event: UiActionObservedEvent
  command?: 'inspect' | 'action' | 'wait'
  sessionId?: string
  clientId?: string
  route?: string
  plugin?: string
  ref?: string
  actions?: string[]
  risks?: string[]
  durationMs?: number
  resultBytes?: number
  cacheHit?: boolean
  registryVersion?: number
  targetCount?: number
  outcome?: string
}

type StoredEntry = UiActionLogEntry & { ts: string }

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function day(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

export function uiActionLogDirectory(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
) {
  return env.BIU_UI_ACTION_LOG_DIR?.trim() ||
    join(env.BIU_HOME?.trim() || cwd, '.biu', 'logs')
}

export class UiActionsObservability {
  private readonly queue: StoredEntry[] = []
  private readonly byEvent = new Map<string, number>()
  private readonly byCommand = new Map<string, number>()
  private readonly byPlugin = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private lastCleanupDay = ''
  private dropped = 0
  private durationCount = 0
  private durationTotalMs = 0
  private durationMaxMs = 0
  private cacheHits = 0
  private cacheMisses = 0

  constructor(
    private readonly options: {
      env?: Record<string, string | undefined>
      cwd?: string
      now?: () => number
      flushMs?: number
      batchSize?: number
      queueMax?: number
    } = {},
  ) {}

  private increment(map: Map<string, number>, key?: string) {
    if (!key) return
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  record(entry: UiActionLogEntry) {
    const now = (this.options.now ?? Date.now)()
    this.increment(this.byEvent, entry.event)
    this.increment(this.byCommand, entry.command)
    this.increment(this.byPlugin, entry.plugin)
    if (typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)) {
      this.durationCount += 1
      this.durationTotalMs += entry.durationMs
      this.durationMaxMs = Math.max(this.durationMaxMs, entry.durationMs)
    }
    if (entry.cacheHit === true) this.cacheHits += 1
    else if (entry.cacheHit === false) this.cacheMisses += 1

    const max = this.options.queueMax ?? UI_ACTION_LOG_QUEUE_MAX
    if (this.queue.length >= max) {
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push({ ts: new Date(now).toISOString(), ...entry })
    if (this.queue.length >= (this.options.batchSize ?? UI_ACTION_LOG_BATCH_SIZE)) {
      void this.flush()
    } else {
      this.schedule()
    }
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.options.flushMs ?? UI_ACTION_LOG_FLUSH_MS)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.queue.length) return this.writing
    const batch = this.queue.splice(0, this.queue.length)
    this.writing = this.writing
      .then(() => this.write(batch))
      .catch(() => undefined)
    return this.writing
  }

  private async write(batch: StoredEntry[]) {
    const env = this.options.env ?? process.env
    const now = (this.options.now ?? Date.now)()
    const dir = uiActionLogDirectory(env, this.options.cwd)
    await mkdir(dir, { recursive: true })
    const today = day(now)
    if (this.lastCleanupDay !== today) {
      this.lastCleanupDay = today
      await this.cleanup(dir, now, positiveInt(env.BIU_UI_ACTION_LOG_RETENTION_DAYS, UI_ACTION_LOG_RETENTION_DAYS))
    }
    const base = `ui-actions-${today}`
    let file = join(dir, `${base}.jsonl`)
    const payload = `${batch.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    const maxBytes = positiveInt(env.BIU_UI_ACTION_LOG_MAX_BYTES, UI_ACTION_LOG_MAX_BYTES)
    try {
      const current = await stat(file)
      if (current.size + Buffer.byteLength(payload) > maxBytes) {
        let suffix = 1
        while (true) {
          const rotated = join(dir, `${base}-${suffix}.jsonl`)
          try {
            await stat(rotated)
            suffix += 1
          } catch {
            await rename(file, rotated)
            break
          }
        }
      }
    } catch {
      /* first write */
    }
    await appendFile(file, payload, { encoding: 'utf8', mode: 0o600 })
  }

  private async cleanup(dir: string, now: number, retentionDays: number) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    for (const name of await readdir(dir)) {
      if (!/^ui-actions-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name)) continue
      const fileDay = Date.parse(`${name.slice(11, 21)}T00:00:00.000Z`)
      if (Number.isFinite(fileDay) && fileDay < cutoff) {
        await rm(join(dir, name), { force: true })
      }
    }
  }

  snapshot() {
    return {
      queueSize: this.queue.length,
      dropped: this.dropped,
      byEvent: Object.fromEntries(this.byEvent),
      byCommand: Object.fromEntries(this.byCommand),
      byPlugin: Object.fromEntries(this.byPlugin),
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: this.cacheHits + this.cacheMisses
          ? this.cacheHits / (this.cacheHits + this.cacheMisses)
          : 0,
      },
      duration: {
        count: this.durationCount,
        averageMs: this.durationCount ? this.durationTotalMs / this.durationCount : 0,
        maxMs: this.durationMaxMs,
      },
    }
  }

  async dispose() {
    await this.flush()
  }
}
