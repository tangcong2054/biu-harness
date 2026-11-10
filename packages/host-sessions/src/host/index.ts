import { Service, type Context } from 'cordis'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { platform } from 'node:os'
import { assistantContentForApi, type LlmMessage, type NativeReplay } from '@biu/host-llm'
import type { AgentSendOptions, AgentHandle, AgentTurn } from '@biu/host-agents'
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionEventBody,
  type SessionMascot,
  type SessionProject,
  type SessionRecord,
  type SessionConfig,
  type MessageSender,
  nameFromSessionMascot,
  mergeSessionConfig,
  normalizeSessionConfig,
  isSessionCompactPoint,
  sessionCompactSummaryText,
  mergeContentEditFiles,
} from '@biu/type-session'
import {
  ensureSessionMascot,
  isSessionMascot,
  mascotFromSessionId,
  pickSessionMascot,
  type SessionMascot as AssignedMascot,
} from './session-mascot.ts'
import { rebuildHealedEvents } from './session-heal.ts'
import { sessionsCollection } from './sessions-collection.ts'
import type { AuthorizationService } from '@biu/host-account/authorization'
import { mysqlRecordVisible, type ScopePolicy, type ScopeSource } from '@biu/host-account/record-scope'
import { currentAccountId, currentRequestWorkspaceId, currentWorkspace, dataHome, isOnlineRuntime } from '@biu/host-plugin-loader/data-dir'
import { currentSessionId } from './session-scope.ts'

const REPLAY_MAX_BYTES = 2 * 1024 * 1024
const REPLAY_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPLAY_UNAVAILABLE = '原生回放数据缺失或不属于当前账号、工作区或会话，请新建会话后重试。'

function validateReplay(value: unknown): asserts value is NativeReplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原生回放数据格式无效，请新建会话。')
  const replay = value as Record<string, unknown>
  if (replay.version !== 1 || replay.complete !== true) throw new Error('原生回放版本不支持或数据不完整，请新建会话。')
  if (typeof replay.routeKey !== 'string' || !replay.routeKey || replay.routeKey.length > 4096
    || (replay.protocol !== 'openai-compat' && replay.protocol !== 'anthropic')
    || (replay.reasoningContent !== undefined && typeof replay.reasoningContent !== 'string')
    || (replay.blocks !== undefined && !Array.isArray(replay.blocks))) {
    throw new Error('原生回放数据格式无效，请新建会话。')
  }
}

function serializeReplay(replay: NativeReplay): string {
  validateReplay(replay)
  let encoded: string
  try {
    encoded = JSON.stringify(replay)
  } catch {
    throw new Error('原生回放数据无法序列化，请新建会话。')
  }
  if (Buffer.byteLength(encoded, 'utf8') > REPLAY_MAX_BYTES) throw new Error('原生回放数据超过 2 MiB 限制，请新建会话。')
  validateReplay(JSON.parse(encoded))
  return encoded
}

function privateReplayHome() {
  return resolve(process.env.BIU_HOME || (isOnlineRuntime() ? process.cwd() : dataHome()))
}

function privateReplayPath(ctx: Context) {
  const home = privateReplayHome()
  const canonical = (path: string): string => existsSync(path)
    ? realpathSync(path)
    : join(canonical(resolve(path, '..')), basename(path))
  const path = join(canonical(home), '.biu', 'private-replay', 'replays.sqlite')
  let publicDir: string | undefined
  try {
    publicDir = (ctx.get('http') as { config?: { publicDir?: string } } | undefined)?.config?.publicDir
  } catch {}
  for (const root of [publicDir, process.env.BIU_PUBLIC_DIR, join(process.cwd(), 'dist'), join(process.cwd(), 'public')]) {
    if (!root) continue
    const rel = relative(canonical(resolve(root)), path)
    if (!rel || (!/^\.\.(?:[/\\]|$)/.test(rel) && !isAbsolute(rel))) {
      throw new Error('原生回放目录不能位于静态文件服务范围内，请调整 BIU_HOME 后新建会话。')
    }
  }
  return path
}

function openReplayDatabase(ctx: Context, create: boolean): DatabaseSync | undefined {
  const path = privateReplayPath(ctx)
  if (!create && !existsSync(path)) return undefined
  const parent = resolve(path, '..')
  const data = resolve(parent, '..')
  if (create) mkdirSync(data, { recursive: true, mode: 0o700 })
  if (!lstatSync(data).isDirectory() || lstatSync(data).isSymbolicLink()) throw new Error('原生回放目录不安全，请新建会话。')
  if (create) mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('原生回放目录不安全，请新建会话。')
  chmodSync(parent, 0o700)
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600)
  closeSync(fd)
  if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1) throw new Error('原生回放文件不安全，请新建会话。')
  chmodSync(path, 0o600)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;')
    if (create) db.exec('CREATE TABLE IF NOT EXISTS replays (scope TEXT NOT NULL, account_id TEXT NOT NULL, session_id TEXT NOT NULL, ref TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (scope, account_id, session_id, ref))')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export type { SessionEvent, SessionEventBody, SessionProject, SessionRecord, SessionMascot, SessionConfig }
export { SESSION_FORMAT_VERSION, normalizeSessionConfig, mergeSessionConfig }
export {
  findOpenTurnStep,
  healInterruptedTurnBodies,
  rebuildHealedEvents,
} from './session-heal.ts'

export function deriveMessages(events: SessionEvent[]): LlmMessage[] {
  let system = ''
  const messages: LlmMessage[] = []
  /** 当前 assistant.tool_calls 的声明顺序（接口要求 role:tool 必须按此顺序紧跟） */
  let pendingOrder: string[] = []
  const pendingNames = new Map<string, string>()
  const readyDetail = new Map<string, string>()
  /** 只有 partial、没有最终 result 时，用最后一片 detail 配平 */
  const partialToolDetail = new Map<string, string>()

  const emitReadyTools = () => {
    while (pendingOrder.length && readyDetail.has(pendingOrder[0]!)) {
      const id = pendingOrder.shift()!
      messages.push({ role: 'tool', tool_call_id: id, content: readyDetail.get(id)! })
      readyDetail.delete(id)
      pendingNames.delete(id)
      partialToolDetail.delete(id)
    }
  }

  const flushOrphanTools = () => {
    if (!pendingOrder.length) return
    for (const id of pendingOrder) {
      const name = pendingNames.get(id) || id
      const content =
        readyDetail.get(id) ||
        partialToolDetail.get(id) ||
        `interrupted: missing tool result for ${name}`
      messages.push({ role: 'tool', tool_call_id: id, content })
    }
    pendingOrder = []
    pendingNames.clear()
    readyDetail.clear()
    partialToolDetail.clear()
  }

  for (const event of events) {
    // 压缩点：sessions 的 compact/clear（含旧独立工具名）。从此处重起，摘要取调用参数。
    if (isSessionCompactPoint(event)) {
      messages.length = 0
      pendingOrder = []
      pendingNames.clear()
      readyDetail.clear()
      partialToolDetail.clear()
      const text = sessionCompactSummaryText(event)
      if (text) {
        messages.push({ role: 'system', content: `[已压缩的历史摘要] ${text}` })
      }
    } else if (event.type === 'system/prompt') {
      system = event.text
    } else if (event.type === 'user/message') {
      flushOrphanTools()
      const images = event.images?.filter((item) => item?.url && item.url.startsWith('data:image/')) ?? []
      if (images.length) {
        messages.push({
          role: 'user',
          content: [
            ...(event.text.trim() ? [{ type: 'text' as const, text: event.text }] : []),
            ...images.map((item) => ({ type: 'image_url' as const, image_url: { url: item.url } })),
          ],
        })
      } else {
        messages.push({ role: 'user', content: event.text })
      }
    } else if (event.type === 'assistant/message') {
      flushOrphanTools()
      const hasToolCalls = Boolean(event.tool_calls?.length)
      messages.push({
        role: 'assistant',
        content: assistantContentForApi(event.text, hasToolCalls),
        ...(event.replayRef ? { replayRef: event.replayRef } : {}),
        ...(hasToolCalls
          ? {
              tool_calls: event.tool_calls!.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      })
      if (hasToolCalls) {
        pendingOrder = event.tool_calls!.map((call) => call.id)
        for (const call of event.tool_calls!) pendingNames.set(call.id, call.name)
      }
    } else if (event.type === 'tool/result') {
      // 错位/重复的 tool/result 不能进 LLM（否则报 tool 必须跟在 tool_calls 后）
      if (!pendingNames.has(event.id)) continue
      if (event.partial) {
        partialToolDetail.set(event.id, event.detail)
        continue
      }
      readyDetail.set(event.id, event.detail)
      emitReadyTools()
    }
  }
  flushOrphanTools()
  return system ? [{ role: 'system', content: system }, ...messages] : messages
}

export interface InputComposition {
  totalChars: number
  histChars: number
  curChars: number
  histPct: number
}

/**
 * 统计发给 LLM 的输入中「历史 turn」与「本次 turn」的字数占比。
 * 独立纯函数，不改 deriveMessages 投影逻辑。
 * - 划分：turn/start..turn/end 为一个 turn。「本次(cur)」= 最近一次 turn
 *   （进行中优先；若无进行中即 session idle 则取最后一个已完成的 turn），
 *   system prompt 计入本次。「历史(hist)」= 本次之前更早的所有 turn。
 * - 角色归类：user/message、assistant/message(含 tool_calls 的 arguments)、
 *   assistant/chunk、tool/call、tool/result 按所在 turn 计入；system/prompt、system/compact 计入当前 turn。
 * - 压缩点语义与 deriveMessages 对齐：仅统计最后一个压缩点之后的事件。
 * - 字数用字符长度。total 为 0 时各 pct 返回 0。
 */
export function statInputComposition(events: SessionEvent[]): InputComposition {
  const len = (s: string | null | undefined) => (s ? s.length : 0)
  const isCompact = (e: SessionEvent) => isSessionCompactPoint(e)

  // —— 第一遍：定位「本次(最近一次) turn」。
  //     与 deriveMessages 一致：仅统计最后一个压缩点之后的事件（无压缩点则全量）。
  //     语义：优先取「当前进行中 turn」(有 turn/start 无 turn/end)；
  //     若无进行中 turn（session idle），则取最后一个已开始的 turn 作为本次，
  //     而非把历史全部计为历史（否则 idle 时 histPct≈99%，失真）。
  //     本次之前更早的 turn = 历史(hist)。system prompt 始终计入本次(cur)。 ——
  const lastCompactIdx = events.reduce((acc, e, i) => (isCompact(e) ? i : acc), -1)
  const started: number[] = []
  const ended = new Set<number>()
  for (let i = lastCompactIdx >= 0 ? lastCompactIdx + 1 : 0; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'turn/start') started.push(e.turn)
    else if (e.type === 'turn/end') ended.add(e.turn)
  }
  // 本次 turn = 进行中的最新 turn；若无进行中，取最后一个开始的 turn。
  let curTurn: number | null = null
  for (const t of started) {
    if (!ended.has(t) && (curTurn == null || t > curTurn)) curTurn = t
  }
  if (curTurn == null && started.length > 0) {
    curTurn = started[started.length - 1]
  }

  // —— 第二遍：按归属 turn 累计输入字数 ——
  let openTurn: number | null = null
  let systemChars = 0
  const byTurn = new Map<number, number>()

  const add = (owner: number | null, n: number) => {
    const key = owner ?? -1 // -1 表示 turn 边界外的孤立内容（归历史）
    byTurn.set(key, (byTurn.get(key) ?? 0) + n)
  }

  for (const event of events) {
    if (isCompact(event)) {
      // 压缩点：从点之后重算，丢弃点前历史（与 deriveMessages 一致）
      openTurn = null
      systemChars = 0
      byTurn.clear()
      continue
    }
    if (event.type === 'turn/start') {
      openTurn = event.turn
      continue
    }
    if (event.type === 'turn/end') {
      openTurn = null
      continue
    }
    switch (event.type) {
      case 'system/prompt':
      case 'system/compact':
        systemChars += len(event.text)
        break
      case 'user/message':
        add(openTurn, len(event.text))
        break
      case 'assistant/message':
        add(openTurn, len(event.text))
        for (const call of event.tool_calls ?? []) add(openTurn, len(call.arguments))
        break
      case 'assistant/chunk':
        add(openTurn, len(event.text))
        break
      case 'tool/call':
        add(openTurn, len(event.arguments))
        break
      case 'tool/result':
        if (!event.partial) add(openTurn, len(event.detail))
        break
    }
  }

  // 历史 = 本次 turn 之前更早的 turn 内容（含 turn 边界外孤立内容的 -1 键）；
  // 本次 = 最近一次 turn（进行中或最后一个已结束）的内容 + system prompt。
  let histChars = 0
  for (const [turn, chars] of byTurn) {
    if (turn !== curTurn) histChars += chars
  }
  let curChars = systemChars
  if (curTurn != null) curChars += byTurn.get(curTurn) ?? 0

  const totalChars = histChars + curChars
  if (totalChars === 0) {
    return { totalChars: 0, histChars: 0, curChars: 0, histPct: 0 }
  }
  const histPct = histChars / totalChars
  return { totalChars, histChars, curChars, histPct }
}


/** 粗略估算一段文本的 token 数（英文 ~1/4 字符，中日韩 ~1/1.5 字符）。 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let cjk = 0
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    if ((c >= 0x2e80 && c <= 0x9fff) || c >= 0x20000) cjk++
    else ascii++
  }
  return Math.ceil(ascii / 4 + cjk / 1.5)
}

export function estimateMessageTokens(m: LlmMessage): number {
  const tools = (m.tool_calls ?? []).reduce((sum, call) => sum + 6
    + estimateTokens(call.function.name) + estimateTokens(call.function.arguments), 0)
  // 原生签名、加密块按 UTF-8 字节保守计费；不能为预算截断或改写 opaque 数据。
  const replay = m.replay ? Buffer.byteLength(JSON.stringify(m.replay), 'utf8') : 0
  if (Array.isArray(m.content)) {
    let n = 0
    for (const part of m.content) {
      if (part.type === 'text') n += estimateTokens(part.text)
      else n += 1200
    }
    return n + tools + replay + 4
  }
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  return estimateTokens(content) + tools + replay + 4
}

export function estimateToolSchemaTokens(tools: unknown[]): number {
  if (!tools.length) return 0
  try {
    return estimateTokens(JSON.stringify(tools))
  } catch {
    return 0
  }
}

export function estimateRequestTokens(messages: LlmMessage[], tools: unknown[] = []): number {
  return (
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
    estimateToolSchemaTokens(tools)
  )
}

type MessageGroup = { messages: LlmMessage[]; tokens: number }

/** 保留回复所在回合的事件；找不到有效边界时拒绝分叉，绝不意外复制完整会话。 */
function truncateForkEvents(events: SessionEvent[], options?: { untilSeq?: number; untilTurn?: number }): SessionEvent[] {
  if (!options) return events
  let end = -1
  if (options.untilSeq !== undefined) {
    if (!Number.isSafeInteger(options.untilSeq) || options.untilSeq < 0) throw new Error('invalid fork reply seq')
    const start = events.findIndex((event) => event.seq === options.untilSeq)
    if (start < 0 || ['session/open', 'turn/start', 'turn/end', 'user/message'].includes(events[start]!.type)) {
      throw new Error('fork reply not found')
    }
    // 优先用回合结束标记；旧日志没有 turn 标记时，以下一条用户消息为边界。
    for (let index = start + 1; index < events.length; index++) {
      if (events[index]!.type === 'turn/end') { end = index; break }
      if (events[index]!.type === 'turn/start') { end = index - 1; break }
    }
    if (end < 0) {
      const nextUser = events.findIndex((event, index) => index > start && event.type === 'user/message')
      end = nextUser < 0 ? events.length - 1 : nextUser - 1
    }
  } else if (options.untilTurn !== undefined) {
    if (!Number.isSafeInteger(options.untilTurn) || options.untilTurn <= 0) throw new Error('invalid fork turn')
    end = events.findIndex((event) => event.type === 'turn/end' && event.turn === options.untilTurn)
    if (end < 0) throw new Error('fork turn end not found')
  } else {
    throw new Error('fork cutoff required')
  }
  if (end < 0) throw new Error('fork boundary not found')
  return events.slice(0, end + 1)
}

/**
 * 每个 user 开启一个对话原子组，后续 assistant/tool 都归入该组直到下一个 user。
 * 这样既不会拆 assistant.tool_calls/tool results，也不会留下失去用户问题的孤立回答。
 */
function contextGroups(messages: LlmMessage[]): { prefix: LlmMessage[]; groups: MessageGroup[] } {
  let cursor = 0
  const prefix: LlmMessage[] = []
  while (messages[cursor]?.role === 'system') {
    prefix.push(messages[cursor]!)
    cursor += 1
  }
  const groups: MessageGroup[] = []
  let current: LlmMessage[] = []
  const flush = () => {
    if (!current.length) return
    groups.push({
      messages: current,
      tokens: current.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    })
    current = []
  }
  while (cursor < messages.length) {
    const message = messages[cursor]!
    cursor += 1
    if (
      message.role === 'user' &&
      current.length &&
      current.some((item) => item.role !== 'user')
    ) {
      flush()
    }
    current.push(message)
  }
  flush()
  return { prefix, groups }
}

export type ContextFit = {
  messages: LlmMessage[]
  estimatedTokens: number
  droppedMessages: number
  overBudget: boolean
}

/**
 * 严格上下文窗口：保留全部 system 前缀和尽可能多的连续最新消息。
 * 若 system + 最新原子组本身已超预算，返回 overBudget，由调用方在本地报错，绝不发给上游。
 */
export function fitMessagesToTokenBudget(messages: LlmMessage[], budgetTokens: number): ContextFit {
  const budget = Math.max(0, Math.floor(budgetTokens))
  const { prefix, groups } = contextGroups(messages)
  const prefixTokens = prefix.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (prefixTokens > budget) {
    return {
      messages: prefix,
      estimatedTokens: prefixTokens,
      droppedMessages: messages.length - prefix.length,
      overBudget: true,
    }
  }

  let used = prefixTokens
  const kept: MessageGroup[] = []
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!
    if (used + group.tokens > budget) break
    kept.unshift(group)
    used += group.tokens
  }
  const output = [...prefix, ...kept.flatMap((group) => group.messages)]
  const latest = groups.at(-1)
  const latestWasKept = !latest || kept.includes(latest)
  return {
    messages: output,
    estimatedTokens: used,
    droppedMessages: messages.length - output.length,
    overBudget: !latestWasKept,
  }
}

/**
 * 滑动窗口 + 预算：消息总量超过预算时，保留"开头稳定锚点 + 最近 N 条"，丢弃中间旧消息。
 * 开头保留使 system/前缀相对稳定（利于缓存命中）；最近保留当前上下文。不影响短会话（不超预算原样返回）。
 */
export function applyContextBudget(messages: LlmMessage[], budgetTokens: number, keepRecent = 14): LlmMessage[] {
  if (budgetTokens <= 0 || messages.length === 0) return messages
  const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0)
  if (total <= budgetTokens) return messages
  const head = Math.max(1, messages[0]?.role === 'system' ? 1 : 0)
  const start = messages.slice(0, head)
  const rest = messages.slice(head)
  let from = Math.max(0, rest.length - keepRecent)
  while (from > 0 && rest[from]?.role === 'tool') from -= 1
  let tail = rest.slice(from)
  while (tail.length && tail[0]?.role === 'tool') {
    if (from === 0) break
    from -= 1
    tail = rest.slice(from)
  }
  while (tail.length) {
    const last = tail[tail.length - 1]
    if (last?.role === 'assistant' && last.tool_calls?.length) {
      const need = last.tool_calls.length
      const have = rest.length - (from + tail.length)
      if (have >= need && rest.slice(from + tail.length, from + tail.length + need).every((item) => item.role === 'tool')) {
        tail = rest.slice(from, from + tail.length + need)
        break
      }
      tail = tail.slice(0, -1)
      continue
    }
    break
  }
  return [...start, ...tail]
}

export class SessionsService extends Service {
  private cache = new Map<string, SessionRecord>()
  private defaultSessionPromise: Promise<string> | null = null
  /** 视图授权能不能看见这条会话。由数据库在启动时接上。 */
  viewAccess: ((id: string, record?: { id?: unknown }) => boolean) & { mayAllow?: () => boolean } =
    Object.assign(() => false, { mayAllow: () => false })
  /**
   * MySQL 控制面下的授权判断（记录授权 + 视图授权），由数据库在启动时接上。
   * 接上后不再用 viewAccess：那个读的是本地 SQLite 副本里的视图授权，线上是过期数据。
   */
  mysqlGrants: {
    readable(items: Array<{ id: string } & Record<string, unknown>>): Promise<Set<string>>
    mayGrant(): Promise<boolean>
  } | null = null

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    ctx.inject(['database'], (inner) => {
      inner.database.register(
        sessionsCollection({
          listSummaries: () => this.listSummaries(),
          rename: (id, title) => this.rename(id, title),
          patchConfig: (id, patch) => this.patchConfig(id, patch),
          delete: (id) => this.delete(id),
          create: (opts) => this.create(undefined, opts),
          require: (id) => this.require(id),
          setProject: (id, project) => this.setProject(id, project),
          isBusy: (id) => {
            try {
              return Boolean(this.ctx.agents?.isBusy(id))
            } catch {
              return false
            }
          },
          inboxPending: (id) => {
            try {
              return Number(this.ctx.agents?.inboxPending(id) ?? 0)
            } catch {
              return 0
            }
          },
        }),
      )
    })
  }

  async create(
    id: string = crypto.randomUUID(),
    opts: { title?: string; config?: SessionConfig } = {},
  ) {
    const used = await this.collectUsedMascots()
    const mascot = pickSessionMascot(id, used)
    const title = opts.title?.trim() || nameFromSessionMascot(mascot)
    const now = Date.now()
    const seeded = normalizeSessionConfig({
      ...(opts.config ?? {}),
      title,
      createdAt: Number(opts.config?.createdAt) > 0 ? opts.config.createdAt : now,
    })
    const record: SessionRecord = {
      id,
      version: SESSION_FORMAT_VERSION,
      events: [{ type: 'session/open', version: SESSION_FORMAT_VERSION, seq: 0, ts: now }],
      mascot,
      ...(seeded ? { config: seeded } : {}),
    }
    await this.persist(record)
    await this.attachNewSession(record.id)
    const database = this.ctx.get('database') as { touchActor?: (collection: string, recordId: string) => Promise<void> } | undefined
    await database?.touchActor?.('/sessions', record.id)
    return record
  }

  /** 会话列表为空时补一条；并发刷新共用同一次创建，避免首屏产生多个默认会话。 */
  async ensureDefaultSession() {
    if (!this.defaultSessionPromise) {
      this.defaultSessionPromise = (async () => {
        const existing = await this.ctx.sessionStore.list()
        if (existing[0]) return existing[0]
        return (await this.create()).id
      })()
    }
    const pending = this.defaultSessionPromise
    try {
      return await pending
    } finally {
      if (this.defaultSessionPromise === pending) this.defaultSessionPromise = null
    }
  }

  /** 同步读缓存（Agent 工具解析会话项目根时用）。 */
  peek(id: string) {
    return this.cache.get(id)
  }

  async get(id: string) {
    const hit = this.cache.get(id)
    if (hit) {
      this.attachSession(id)
      return hit
    }
    const loaded = await this.ctx.sessionStore.load(id)
    if (!loaded) return loaded
    const healed = await this.healOpenTurnsOnLoad(loaded)
    this.cache.set(id, healed)
    this.attachSession(id)
    return healed
  }

  /** 用来自受信任同步端的完整记录替换本地缓存与持久化副本。 */
  async replace(record: SessionRecord) {
    this.clearPersistTimer(record.id)
    await this.persist(record)
    this.attachSession(record.id)
    return record
  }

  /** 启动时把磁盘上崩溃残留的 partial / 未闭合 turn 一次修完并写回。 */
  async healPersistedLogs() {
    let ids: string[] = []
    try {
      ids = await this.list()
    } catch {
      return
    }
    for (const id of ids) {
      try {
        await this.get(id)
      } catch {
        /* 单条坏日志不挡启动 */
      }
    }
  }

  /**
   * 从磁盘拉起时：强行闭合未结束的 step/turn。
   * 重启后进程内 agent 已空，但日志若仍开着 turn，UI/Live 会一直显示 running，再发消息也会叠 turn。
   */
  private async healOpenTurnsOnLoad(record: SessionRecord): Promise<SessionRecord> {
    const rebuilt = rebuildHealedEvents(record.events)
    if (!rebuilt) return record
    record.events = rebuilt
    await this.persist(record)
    this.ctx.logger('sessions').info(
      `healed interrupted session log session=${record.id} events=${rebuilt.length}`,
    )
    return record
  }

  async require(id: string) {
    const record = await this.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    return record
  }

  private async replayScope(sessionId: string, checkSession = true) {
    const scopedSession = checkSession ? currentSessionId() : undefined
    const accountId = currentAccountId()
    const workspace = currentWorkspace()
    const workspaceId = currentRequestWorkspaceId() || this.collabStore()?.activeWorkspaceId() || workspace?.id || ''
    if (!sessionId || (scopedSession && scopedSession !== sessionId)
      || (isOnlineRuntime() && (!accountId || !workspaceId))
      || !(await this.inWorkspaceAsync(sessionId))
      || !(await this.ctx.sessionStore.load(sessionId))) {
      throw new Error(REPLAY_UNAVAILABLE)
    }
    const scopeParts = isOnlineRuntime()
      ? ['online', privateReplayHome(), workspaceId]
      : ['offline', resolve(dataHome()), workspace?.id || '', workspaceId]
    const scope = createHash('sha256').update(JSON.stringify(scopeParts)).digest('hex')
    return { scope, accountId }
  }

  async saveReplay(sessionId: string, replay: NativeReplay): Promise<string> {
    const { scope, accountId } = await this.replayScope(sessionId)
    const encoded = serializeReplay(replay)
    const ref = randomUUID()
    const db = openReplayDatabase(this.ctx, true)!
    try {
      db.prepare('INSERT INTO replays (scope, account_id, session_id, ref, payload) VALUES (?, ?, ?, ?, ?)')
        .run(scope, accountId, sessionId, ref, encoded)
      return ref
    } finally {
      db.close()
    }
  }

  async loadReplay(sessionId: string, ref: string): Promise<NativeReplay> {
    if (typeof ref !== 'string' || !REPLAY_REF.test(ref)) throw new Error(REPLAY_UNAVAILABLE)
    const { scope, accountId } = await this.replayScope(sessionId)
    const db = openReplayDatabase(this.ctx, false)
    if (!db) throw new Error(REPLAY_UNAVAILABLE)
    try {
      const row = db.prepare('SELECT payload FROM replays WHERE scope = ? AND account_id = ? AND session_id = ? AND ref = ?')
        .get(scope, accountId, sessionId, ref) as { payload: string } | undefined
      if (!row) throw new Error(REPLAY_UNAVAILABLE)
      if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > REPLAY_MAX_BYTES) {
        throw new Error('原生回放数据超过 2 MiB 限制或已损坏，请新建会话。')
      }
      let replay: unknown
      try {
        replay = JSON.parse(row.payload)
      } catch {
        throw new Error('原生回放数据已损坏，请新建会话。')
      }
      validateReplay(replay)
      return replay
    } finally {
      db.close()
    }
  }

  /**
   * 对外派工：向指定 session 的 agent 发送一条消息并启动回合。
   * 遵循封装原则——外部只依赖 Session，不直接操控 Agent。
   */
  async sendMessage(id: string, text: string, opts?: { wait?: boolean; sender?: MessageSender }): Promise<AgentTurn> {
    const handle = await this.agentHandle(id)
    return handle.send(text, opts as AgentSendOptions | undefined)
  }

  /** 对外注入：向指定 session 的 agent 注入一条待处理消息（不立即 start；忙时进 inbox）。 */
  async injectMessage(id: string, text: string, opts?: { sender?: MessageSender }): Promise<void> {
    const handle = await this.agentHandle(id)
    handle.inject(text, opts as AgentSendOptions | undefined)
  }

  /** 内部：拿到某 session 的 AgentHandle（封装在 session 层面，外部不可见 Agent 细节）。 */
  private async agentHandle(id: string): Promise<AgentHandle> {
    if (this.agentFactory) return this.agentFactory(id)
    throw new Error('agent factory not installed: agents 插件未就绪')
  }

  /**
   * 由 agents 插件在启动时安装"按 session 取 AgentHandle"的工厂。
   * 通过回调解耦，避免 sessions ↔ agents 的循环依赖：agents 依赖 sessions（单向），
   * 反向能力由 agents 通过此方法注入。
   */
  installAgentFactory(factory: (id: string) => Promise<AgentHandle> | AgentHandle): void {
    this.agentFactory = factory
  }

  private agentFactory: ((id: string) => Promise<AgentHandle> | AgentHandle) | null = null

  /** 合并写入会话配置；传 null/空字符串可清除 title / systemPrompt。 */
  async patchConfig(
    id: string,
    patch: Parameters<typeof mergeSessionConfig>[1],
  ) {
    const record = await this.require(id)
    const next = mergeSessionConfig(record.config, patch)
    if (next) record.config = next
    else delete record.config
    await this.persist(record)
    return record
  }

  async rename(id: string, title: string) {
    return this.patchConfig(id, { title })
  }

  async append(id: string, body: SessionEventBody) {
    const record = await this.require(id)
    const event: SessionEvent = { ...body, seq: record.events.length, ts: Date.now() }
    record.events.push(event)
    this.cache.set(id, record)
    // chunk / 进行中的 tool/call：先内存追加并广播，落盘合并到下一帧，避免把事件循环卡死
    if (body.type === 'assistant/chunk') {
      this.schedulePersist(id)
    } else if (body.type === 'content/edits') {
      const existing = record.events.slice(0, -1).findLast((item) => item.type === 'content/edits' && item.turn === body.turn)
      if (existing && existing.type === 'content/edits') {
        existing.files = mergeContentEditFiles(existing.files, body.files)
        existing.ts = event.ts
        record.events.pop()
        this.schedulePersist(id)
        this.ctx.emit('session/event', { sessionId: id, event: existing })
        return existing
      }
      this.schedulePersist(id)
    } else if (body.type === 'tool/call') {
      const existing = record.events.slice(0, -1).findLast((item) => item.type === 'tool/call' && item.id === body.id)
      if (existing && existing.type === 'tool/call') {
        existing.name = body.name || existing.name
        existing.arguments = body.arguments
        existing.ts = event.ts
        record.events.pop()
        this.schedulePersist(id)
        this.ctx.emit('session/event', { sessionId: id, event: existing })
        return existing
      }
      this.schedulePersist(id)
    } else if (body.type === 'tool/result') {
      const existing = record.events.slice(0, -1).findLast((item) => item.type === 'tool/result' && item.id === body.id)
      if (existing && existing.type === 'tool/result') {
        existing.name = body.name || existing.name
        existing.ok = body.ok
        existing.detail = body.detail
        existing.ts = event.ts
        if (body.partial) existing.partial = true
        else delete existing.partial
        record.events.pop()
        if (body.partial) this.schedulePersist(id)
        else {
          this.clearPersistTimer(id)
          await this.persist(record)
        }
        this.ctx.emit('session/event', { sessionId: id, event: existing })
        return existing
      }
      if (body.partial) this.schedulePersist(id)
      else {
        this.clearPersistTimer(id)
        await this.persist(record)
      }
      this.ctx.emit('session/event', { sessionId: id, event })
      return event
    } else {
      this.ctx.emit('session/event', { sessionId: id, event })
      this.clearPersistTimer(id)
      await this.persist(record)
      return event
    }
    this.ctx.emit('session/event', { sessionId: id, event })
    return event
  }

  deriveMessages(id: string) {
    const record = this.cache.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    return deriveMessages(record.events)
  }

  /** 统计当前事件日志的输入构成（历史/本次 turn 占比），与 deriveMessages 一致从压缩点后算。 */
  statInputComposition(id: string) {
    const record = this.cache.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    return statInputComposition(record.events)
  }

  /**
   * 分叉会话。
   * 传 options.untilTurn 时只复制到该回合结束为止（含该回合的 turn/end），后面的回合不带过去；
   * 不传则是原来的整段复制（子任务继承父会话依赖这个行为）。
   */

  /**
   * 只校验截点能否在源会话里定位，不写入。桌面端 fork 云端会话时先在本机确认，
   * 避免云端已经建好子会话、本机却截不出来，留下只在云端存在的孤儿会话。
   */
  async checkForkCutoff(sourceId: string, options?: { untilSeq?: number; untilTurn?: number }) {
    const source = await this.require(sourceId)
    truncateForkEvents(source.events, options)
  }

  async fork(sourceId: string, childId: string = crypto.randomUUID(), options?: { untilSeq?: number; untilTurn?: number }) {
    const source = await this.require(sourceId)
    const forkEvents = truncateForkEvents(source.events, options)
    const used = await this.collectUsedMascots()
    const mascot = pickSessionMascot(childId, used)
    const sourceConfig = { ...(source.config ?? {}) }
    delete sourceConfig.inspector
    delete sourceConfig.pinned
    delete sourceConfig.tags
    const record: SessionRecord = {
      id: childId,
      version: source.version,
      events: forkEvents.map((event) => {
        if (event.type !== 'assistant/message' || !event.replayRef) return { ...event }
        const { replayRef: _ref, ...body } = event
        return body
      }),
      ...(source.project ? { project: { ...source.project } } : {}),
      mascot,
      config: normalizeSessionConfig({
        ...sourceConfig,
        title: nameFromSessionMascot(mascot),
        createdAt: Date.now(),
      }),
    }
    await this.persist(record)
    await this.attachNewSession(record.id)
    return record
  }

  async setProject(id: string, project: { path: string } | null) {
    const record = await this.require(id)
    if (isOnlineRuntime()) {
      // Online 的 cwd 由 workspaceId/sessionId 派生，不能绑定任意服务器绝对路径。
      throw new Error('Online 会话使用云端受控工作区，不能绑定服务器目录')
    }
    if (!project) {
      delete record.project
      await this.persist(record)
      return undefined
    }
    record.project = await resolveHostProject(project.path)
    await this.persist(record)
    return record.project
  }

  list() {
    return this.ctx.sessionStore.list()
  }

  /** 没有协同账号时全部可见；有当前工作区时只留下本区会话，未认领的旧会话只在「本机」出现。 */
  inWorkspace(id: string, record?: { id?: unknown }) {
    // MySQL 控制面下成员关系与归属都不在本机 SQLite，同步判定只会读到空表。
    // 宁可不给：调用方必须改用 inWorkspaceAsync / listSummaries。
    if (this.mysqlAccount()) return false
    const authorization = this.authorization()
    const actor = authorization?.currentActor()
    if (authorization && actor) {
      const allowed = authorization.authorize(actor, 'resource:read', {
        type: 'record',
        workspaceId: actor.workspaceId,
        collection: '/sessions',
        recordId: id,
      }).allowed
      if (allowed) return true
      return this.viewAccess(id, record)
    }
    const store = this.collabStore()
    if (!store?.activeWorkspaceId()) return true
    if (this.viewAccess(id, record)) return true
    const membership = store.membership()
    const key = `/sessions\t${id}`
    if (membership.mine.has(key)) return this.recordReadable(id)
    if (membership.any.has(key)) return false
    if (membership.strict) return false
    if (membership.active !== membership.home) return false
    return this.recordReadable(id)
  }

  /** 与 inWorkspace 同义；MySQL 控制面下按云端成员关系与归属判定。 */
  async inWorkspaceAsync(id: string, record?: { id?: unknown }) {
    if (!this.mysqlAccount()) return this.inWorkspace(id, record)
    const visible = await this.mysqlVisibleSessions([id])
    if (visible.has(id)) return true
    if (this.mysqlGrants) return (await this.mysqlGrants.readable([{ ...record, id }])).has(id)
    return this.viewAccess(id, record)
  }

  /**
   * 当前账号在当前工作区能看见哪些会话。
   * 记录必须在这个工作区有归属（策略或 owner），且对当前账号不是别人的私有记录。
   * 缺账号、缺工作区、不是成员时一律返回空集合（fail-closed）。
   */
  private async mysqlVisibleSessions(ids?: string[]) {
    const out = new Set<string>()
    const mysql = this.mysqlAccount()
    const accountId = currentAccountId()
    const workspaceId = currentRequestWorkspaceId()
    if (!mysql || !accountId || !workspaceId || ids?.length === 0) return out
    const member = await mysql.membership(accountId, workspaceId)
    if (!member) return out
    const sources = new Map<string, ScopeSource>()
    const load = async (collection: string) => {
      if (sources.has(collection)) return
      const loaded = await mysql.collectionScopeSources(workspaceId, collection)
      sources.set(collection, { policies: loaded.policies, owners: new Set(loaded.owners) })
    }
    await load('/sessions')
    const own = sources.get('/sessions')!
    for (const id of ids ?? new Set([...own.owners, ...Object.keys(own.policies)])) {
      const policy = own.policies[id]
      if (!policy && !own.owners.has(id)) continue
      // 继承到别的集合时把父集合也读进来，否则会把继承记录当成无策略。
      let current: ScopePolicy | undefined = policy
      let guard = 0
      while (current?.accessMode === 'inherit' && current.parentRecordId && guard < 16) {
        const parent: string = current.parentCollection || '/sessions'
        await load(parent)
        current = sources.get(parent)?.policies[current.parentRecordId]
        guard += 1
      }
      if (mysqlRecordVisible('/sessions', id, sources, accountId, member.memberKind ?? 'member')) out.add(id)
    }
    return out
  }

  private usesMysqlAccounts() {
    try {
      return (this.ctx.get('account') as { usesMysqlAccounts?: () => boolean } | undefined)?.usesMysqlAccounts?.() === true
    } catch {
      return false
    }
  }

  private mysqlAccount() {
    let account: {
      usesMysqlAccounts?: () => boolean
      mysql?: {
        membership?: (accountId: string, workspaceId: string) => Promise<{ memberKind?: string } | null>
        collectionScopeSources?: (
          workspaceId: string,
          collection: string,
        ) => Promise<{ policies: Record<string, ScopePolicy>; owners: string[] }>
      } | null
    } | undefined
    try {
      account = this.ctx.get('account') as typeof account
    } catch {
      return null
    }
    const mysql = account?.usesMysqlAccounts?.() ? account.mysql : null
    if (!mysql?.membership || !mysql.collectionScopeSources) return null
    return mysql as {
      membership: (accountId: string, workspaceId: string) => Promise<{ memberKind?: string } | null>
      collectionScopeSources: (
        workspaceId: string,
        collection: string,
      ) => Promise<{ policies: Record<string, ScopePolicy>; owners: string[] }>
    }
  }

  private recordReadable(id: string) {
    const store = this.collabStore()
    if (!store || typeof store.canReadRecord !== 'function') return true
    return store.canReadRecord('/sessions', id)
  }

  async listSummaries() {
    const mysqlGrants = this.mysqlAccount() ? this.mysqlGrants : null
    // 有授权可能命中时不能只按归属下推，否则别人分享过来的会话会被漏掉。
    const mayGrant = mysqlGrants ? await mysqlGrants.mayGrant() : this.viewAccess.mayAllow?.() !== false
    const narrowed = process.env.BIU_SESSION_SCOPE_PUSHDOWN === '1'
      && Boolean(this.mysqlAccount()) && !mayGrant
    const candidateIds = narrowed ? [...await this.mysqlVisibleSessions()] : undefined
    let all = await this.ctx.sessionStore.listSummaries(
      candidateIds === undefined ? undefined : { sessionIds: candidateIds },
    )
    if (narrowed && !mysqlGrants && this.viewAccess.mayAllow?.() !== false) {
      all = await this.ctx.sessionStore.listSummaries()
    }
    const mysqlVisible = this.mysqlAccount() ? await this.mysqlVisibleSessions(all.map((item) => item.id)) : null
    const granted = mysqlVisible && mysqlGrants && mayGrant
      ? await mysqlGrants.readable(all.filter((item) => !mysqlVisible.has(item.id)) as unknown as Array<{ id: string } & Record<string, unknown>>)
      : null
    const items = all.filter((item) =>
      mysqlVisible
        ? mysqlVisible.has(item.id) || (granted ? granted.has(item.id) : !mysqlGrants && this.viewAccess(item.id, item))
        : this.inWorkspace(item.id, item),
    )
    const out = []
    for (const item of items) {
      let next = item
      if (!item.mascot || !isSessionMascot(item.mascot)) {
        // Legacy sessions: pin a stable mascot once and persist.
        const record = await this.require(item.id)
        if (!record.mascot || !isSessionMascot(record.mascot)) {
          record.mascot = mascotFromSessionId(record.id)
          await this.persist(record)
        } else {
          const ensured = ensureSessionMascot(record.id, record.mascot)
          if (ensured.eye !== record.mascot.eye) {
            record.mascot = ensured
            await this.persist(record)
          }
        }
        next = { ...next, mascot: record.mascot }
      } else {
        const ensured = ensureSessionMascot(item.id, item.mascot)
        if (ensured.eye !== item.mascot.eye) {
          const record = await this.require(item.id)
          record.mascot = ensured
          await this.persist(record)
          next = { ...next, mascot: ensured }
        }
      }
      if (next.mascot && next.title === item.id.slice(0, 8)) {
        next = { ...next, title: nameFromSessionMascot(next.mascot) }
      }
      out.push(next)
    }
    return out
  }

  private async collectUsedMascots(): Promise<AssignedMascot[]> {
    const items = await this.ctx.sessionStore.listSummaries()
    const used: AssignedMascot[] = []
    for (const item of items) {
      if (item.mascot && isSessionMascot(item.mascot)) used.push(item.mascot)
    }
    return used
  }

  async delete(id: string) {
    if (existsSync(privateReplayPath(this.ctx)) && await this.ctx.sessionStore.load(id)) {
      const { scope } = await this.replayScope(id, false)
      const db = openReplayDatabase(this.ctx, false)
      try {
        db?.prepare('DELETE FROM replays WHERE scope = ? AND session_id = ?').run(scope, id)
      } finally {
        db?.close()
      }
    }
    this.clearPersistTimer(id)
    this.cache.delete(id)
    return this.ctx.sessionStore.delete(id)
  }

  private collabStore() {
    try {
      return (
        this.ctx.get('account') as
          | {
              store?: {
                activeWorkspaceId(): string | null
                membership(): { active: string | null; home: string | null; mine: Set<string>; any: Set<string>; strict?: boolean }
                attach(workspaceId: string, collection: string, recordId: string): void
                canReadRecord?(collection: string, recordId: string): boolean
              }
            }
          | undefined
      )?.store
    } catch {
      return undefined
    }
  }

  private authorization() {
    try {
      return (this.ctx.get('account') as { authorization?: AuthorizationService } | undefined)?.authorization
    } catch {
      return undefined
    }
  }

  private attachSession(id: string) {
    // MySQL 控制面下归属只写 MySQL（新建时 attachMysqlSession）。以前每次读会话都往本地副本写一次归属，
    // 副本里空间不存在或归属冲突时直接抛错，会话打不开；写进去的归属也可能挂错空间。
    if (this.usesMysqlAccounts()) return
    const store = this.collabStore()
    const workspaceId = store?.activeWorkspaceId()
    if (!store || !workspaceId) return
    store.attach(workspaceId, '/sessions', id)
  }

  /** 新建和分叉要把私人归属写进 MySQL。只挂本机 SQLite 时，重新登录后会话不在当前空间的分组里。 */
  private async attachNewSession(id: string) {
    const mysqlAttached = await this.attachMysqlSession(id)
    if (this.usesMysqlAccounts()) return
    try {
      this.attachSession(id)
    } catch (error) {
      if (!mysqlAttached) throw error
    }
  }

  private async attachMysqlSession(id: string) {
    let account: {
      usesMysqlAccounts?: () => boolean
      mysql?: {
        attachPolicy?: (input: {
          actorId: string
          workspaceId: string
          collection: string
          recordId: string
          ownership: 'personal'
          accessMode: 'private'
          now: number
        }) => Promise<void>
      } | null
    } | undefined
    try {
      account = this.ctx.get('account')
    } catch {
      return false
    }
    if (!account?.usesMysqlAccounts?.() || !account.mysql?.attachPolicy) return false
    const actorId = currentAccountId()
    const workspaceId = currentRequestWorkspaceId()
    if (!actorId || !workspaceId) return false
    await account.mysql.attachPolicy({
      actorId,
      workspaceId,
      collection: '/sessions',
      recordId: id,
      ownership: 'personal',
      accessMode: 'private',
      now: Date.now(),
    })
    return true
  }

  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private schedulePersist(id: string) {
    if (this.persistTimers.has(id)) return
    this.persistTimers.set(
      id,
      setTimeout(() => {
        this.persistTimers.delete(id)
        const record = this.cache.get(id)
        if (record) void this.persist(record)
      }, 80),
    )
  }

  private clearPersistTimer(id: string) {
    const timer = this.persistTimers.get(id)
    if (timer == null) return
    clearTimeout(timer)
    this.persistTimers.delete(id)
  }

  private async persist(record: SessionRecord) {
    this.cache.set(record.id, record)
    await this.ctx.sessionStore.save(record)
  }
}

/**
 * 规范化磁盘路径字符串，使其能解析到实际存在的目录。
 *
 * macOS 的 APFS/HFS+ 以 NFD（Unicode 分解）形式存储文件名，而用户输入的
 * 中文等多字节路径往往是 NFC（预组合）形式。两者字节不同，`realpath`/`stat`
 * 对 NFC 字符串去解析 NFD 存储的目录会抛 ENOENT（即使目录确实存在），导致
 * “中文等目录无法绑定”。这里在 darwin 上把输入统一转成 NFD 再解析（NFD 与
 * NFC 对无分解字符的路径无差别，因此安全）。非 macOS 直接透传。
 */
function normalizePathForFs(input: string): string {
  return platform() === 'darwin' ? input.normalize('NFD') : input
}

async function resolveHostProject(input: string): Promise<SessionProject> {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('project path is required')
  const abs = resolve(normalizePathForFs(raw))
  if (!isAbsolute(abs)) throw new Error('project path must be absolute')
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    throw new Error(`project path does not exist: ${abs}`)
  }
  const info = await stat(real)
  if (!info.isDirectory()) throw new Error(`project path is not a directory: ${real}`)
  return { name: basename(real) || real, path: real, boundAt: Date.now() }
}

export { sessionsCollection } from './sessions-collection.ts'
export { eventsCollection } from './events-collection.ts'
export { lastUsageBeforeCompact, retrieveHistory } from './session-compact.ts'
export { liftToolImages, MAX_TOOL_IMAGES } from './tool-images.ts'

export const name = 'sessions'
export const inject = ['sessionStore']

export function apply(ctx: Context) {
  const sessions = new SessionsService(ctx)
  void sessions.healPersistedLogs()
}
