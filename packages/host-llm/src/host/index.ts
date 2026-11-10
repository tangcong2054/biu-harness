import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Service, type Context } from 'cordis'
import {
  isTencentTokenPlan,
  resolveTencentTokenPlanHeadroom,
  resolveTencentTokenPlanMaxOutput,
  resolveTencentTokenPlanTpm,
  tencentTpmRetryDelay,
  TencentTokenPlanTpmLimiter,
} from './tencent-token-plan-tpm.ts'
import { appendTencentTokenPlanLog } from './tencent-token-plan-log.ts'

export type ChatProvider = 'deepseek' | 'openai' | 'anthropic'

export interface LlmConfig {
  provider: ChatProvider
  /** 入口标识；用于区分同协议下的供应商能力（例如腾讯云 Token Plan）。 */
  endpointId?: string
  apiKey: string
  model: string
  /**
   * 可选自定义 API 根地址（官方 / 中转站 / 本地）。
   * openai-compat：拼 `/chat/completions`；anthropic：拼 `/messages`。
   * 也可直接传入已含后缀的完整 URL。
   */
  baseUrl?: string
  /** DeepSeek V4 / Claude 扩展思考：显式开关，避免上游默认开思考把页面卡死。 */
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
  /** 默认精简回放；原生回放只允许相同供应商、模型和实际入口。 */
  replayMode?: 'lean-replay' | 'native-replay'
  /** Agent 本地上下文管理使用；不会原样发送给上游。 */
  contextWindowTokens?: number
  /** 为正常回答 / thinking 预留的窗口空间。 */
  outputReserveTokens?: number
}

export function attachProviderOptions(
  body: Record<string, unknown>,
  config: LlmConfig,
  protocol: 'openai-compat' | 'anthropic',
) {
  if (protocol === 'anthropic') {
    if (config.thinking === 'enabled') {
      body.thinking = { type: 'enabled', budget_tokens: 10_000 }
    } else if (config.thinking === 'disabled') {
      body.thinking = { type: 'disabled' }
    }
    return
  }
  if (config.thinking === 'disabled') {
    body.thinking = { type: 'disabled' }
    return
  }
  if (config.thinking === 'enabled') {
    body.thinking = { type: 'enabled' }
  }
  if (config.reasoningEffort === 'high' || config.reasoningEffort === 'max') {
    body.reasoning_effort = config.reasoningEffort
  }
}

/** 把用户配置的 baseUrl 解析成 chat.completions 完整地址。 */
export function resolveChatCompletionsUrl(baseUrl: string | undefined, provider: ChatProvider): string {
  if (baseUrl?.trim()) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed
    return `${trimmed}/chat/completions`
  }
  return provider === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions'
}

/** 把用户配置的 baseUrl 解析成 Anthropic messages 完整地址。 */
export function resolveAnthropicMessagesUrl(baseUrl: string | undefined): string {
  if (baseUrl?.trim()) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (/\/messages$/i.test(trimmed)) return trimmed
    return `${trimmed}/messages`
  }
  return 'https://api.anthropic.com/v1/messages'
}

/** OpenAI 兼容：列出模型的 GET 地址（…/models）。 */
export function resolveModelsListUrl(baseUrl: string | undefined, provider: ChatProvider): string {
  if (baseUrl?.trim()) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (/\/models$/i.test(trimmed)) return trimmed
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, '/models')
    return `${trimmed}/models`
  }
  return provider === 'deepseek' ? 'https://api.deepseek.com/models' : 'https://api.openai.com/v1/models'
}

export type LlmProbeResult =
  | { ok: true; latencyMs: number; detail: string; models?: string[] }
  | { ok: false; latencyMs: number; detail: string }

const MAX_LISTED_MODELS = 500

/** 从 OpenAI 兼容的 GET /models 响应里取出模型 id。 */
export function modelIdsFromListBody(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : []
      : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const raw =
      typeof row === 'string'
        ? row
        : row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
          ? (row as { id: string }).id
          : ''
    const id = raw.trim()
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_LISTED_MODELS) break
  }
  return ids
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string | number,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LlmHttpError'
  }
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** 供应商请求 id 常见的响应头；腾讯云 / OpenAI 兼容网关通常是 x-request-id，Anthropic 是 request-id。 */
const REQUEST_ID_HEADERS = ['x-request-id', 'x-tc-requestid', 'request-id'] as const

export function requestIdFromHeaders(headers: Headers | undefined | null): string | undefined {
  if (!headers) return undefined
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim()
    if (value) return value
  }
  return undefined
}

function idString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function responseError(res: Response) {
  let message = `llm http ${res.status}`
  let code: string | number | undefined
  let requestId: string | undefined = requestIdFromHeaders(res.headers)
  try {
    const body = (await res.json()) as Record<string, unknown>
    const raw =
      body.error && typeof body.error === 'object'
        ? body.error as Record<string, unknown>
        : body
    if (typeof raw.message === 'string' && raw.message) message = raw.message
    if (typeof raw.code === 'string' || typeof raw.code === 'number') code = raw.code
    const id = raw.request_id ?? raw.requestId ?? body.request_id ?? body.requestId
    if (typeof id === 'string' && id) requestId = id
  } catch {
    /* ignore */
  }
  const diagnostics = [
    code != null ? `code=${code}` : '',
    requestId ? `request_id=${requestId}` : '',
  ].filter(Boolean).join(' ')
  return new LlmHttpError(
    diagnostics ? `${message} (${diagnostics})` : message,
    res.status,
    code,
    requestId,
    retryAfterMs(res.headers.get('retry-after')),
  )
}

/**
 * 轻量连通性探测：优先 GET /models；失败则发一条极短非流式 chat。
 * Anthropic 走一条 max_tokens=1 的 Messages 请求。
 */
export async function probeLlmConnection(
  config: LlmConfig,
  opts?: { signal?: AbortSignal },
): Promise<LlmProbeResult> {
  const started = Date.now()
  const apiKey = config.apiKey?.trim() || ''
  if (!apiKey) {
    return { ok: false, latencyMs: 0, detail: '未配置 API Key' }
  }

  try {
    if (config.provider === 'anthropic') {
      const url = resolveAnthropicMessagesUrl(config.baseUrl)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: opts?.signal,
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const err = (await res.json()) as { error?: { message?: string } }
          if (err.error?.message) detail = err.error.message
        } catch {
          /* ignore */
        }
        return { ok: false, latencyMs, detail }
      }
      return { ok: true, latencyMs, detail: `Anthropic Messages · ${latencyMs}ms` }
    }

    // OpenAI 兼容：先试 /models
    const modelsUrl = resolveModelsListUrl(config.baseUrl, config.provider)
    const listRes = await fetch(modelsUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: opts?.signal,
    })
    if (listRes.ok) {
      const latencyMs = Date.now() - started
      let models: string[] = []
      try {
        models = modelIdsFromListBody(await listRes.json())
      } catch {
        /* ignore */
      }
      const count = models.length
      return {
        ok: true,
        latencyMs,
        ...(count > 0 ? { models } : {}),
        detail: count > 0 ? `GET /models · ${count} 个模型 · ${latencyMs}ms` : `GET /models · ${latencyMs}ms`,
      }
    }

    // /models 不可用时回退 chat/completions
    const chatUrl = resolveChatCompletionsUrl(config.baseUrl, config.provider)
    const chatRes = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: opts?.signal,
    })
    const latencyMs = Date.now() - started
    if (!chatRes.ok) {
      let detail = `HTTP ${chatRes.status}`
      try {
        const err = (await chatRes.json()) as { error?: { message?: string } }
        if (err.error?.message) detail = err.error.message
      } catch {
        /* ignore */
      }
      // 附带 /models 失败信息，便于排查
      detail = `${detail}（/models → ${listRes.status}）`
      return { ok: false, latencyMs, detail }
    }
    return { ok: true, latencyMs, detail: `chat/completions · ${latencyMs}ms` }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** DeepSeek 视觉模型：检测到图片输入时自动路由到它。 */
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** 多模态内容块：文本 或 图片（data URL / http URL）。 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type LlmMessageContent = string | LlmContentPart[] | null

export type NativeReplayBlock = (
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
) & Record<string, unknown>

/** 仅供宿主私有存储；完整块及签名不可进入公共事件或直接展开为请求字段。 */
export interface NativeReplay {
  version: 1
  complete: true
  routeKey: string
  protocol: 'openai-compat' | 'anthropic'
  reasoningContent?: string
  reasoningField?: 'reasoning_content' | 'reasoning'
  blocks?: NativeReplayBlock[]
}

export interface LlmMessage {
  role: string
  content?: LlmMessageContent
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  replay?: NativeReplay
  /** 私有存储引用，绝不发送给上游。 */
  replayRef?: string
  /** 分叉或私有状态不可用时显式标记；原生回放不得静默降级。 */
  replayMissing?: boolean
}

/** 若消息 content 含图片块则返回 true（用于触发视觉模型路由）。 */
export function hasImageContent(content: LlmMessageContent | undefined): boolean {
  if (typeof content !== 'object' || !Array.isArray(content)) return false
  return content.some((part) => part.type === 'image_url')
}

function textFromContent(content: LlmMessageContent | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function imagePartsFromContent(content: LlmMessageContent | undefined): LlmContentPart[] {
  if (!Array.isArray(content)) return []
  return content.filter((part): part is { type: 'image_url'; image_url: { url: string } } => part.type === 'image_url')
}

/**
 * Chat Completions 的 tool 角色只接受字符串。成熟做法：工具文本留在 tool，
 * 图像跟在该批 tool 消息之后的一条 user 多模态消息里（DeepSeek / GPT-4o 同款）。
 */
export function flattenToolImagesForChatCompletions(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  let pending: LlmContentPart[] = []
  const flush = () => {
    if (!pending.length) return
    out.push({
      role: 'user',
      content: [{ type: 'text', text: '（工具返回的图像）' }, ...pending],
    })
    pending = []
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      const images = imagePartsFromContent(message.content)
      if (images.length) {
        out.push({ ...message, content: textFromContent(message.content) })
        pending.push(...images)
        continue
      }
      // 同一批 tool_calls 的后续 tool 即使没图也不能先 flush 图像 user，否则会拆对。
      out.push(message)
      continue
    }
    flush()
    out.push(message)
  }
  flush()
  return out
}

function anthropicImageBlock(url: string): Record<string, unknown> | null {
  const data = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
  if (data) {
    const media = data[1]!.toLowerCase() === 'image/jpg' ? 'image/jpeg' : data[1]!.toLowerCase()
    return {
      type: 'image',
      source: { type: 'base64', media_type: media, data: data[2]!.replace(/\s+/g, '') },
    }
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return null
}

/** OpenAI image_url → Anthropic image / text 块；tool 角色包成 tool_result。 */
export function toAnthropicContent(
  content: LlmMessageContent | undefined,
  toolCallId?: string,
): unknown {
  let blocks: unknown
  if (typeof content === 'string' || content == null) {
    blocks = content ?? ''
  } else if (Array.isArray(content)) {
    const parts: Record<string, unknown>[] = []
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text) parts.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url') {
        const image = anthropicImageBlock(part.image_url.url)
        if (image) parts.push(image)
      }
    }
    blocks = parts.length ? parts : ''
  } else {
    blocks = ''
  }
  if (!toolCallId) return blocks
  return [{ type: 'tool_result', tool_use_id: toolCallId, content: blocks }]
}

/** OpenAI/DeepSeek：带 tool_calls 时 content 宜为 null，空字符串可能导致后续回合拒答。 */
export function assistantContentForApi(text: string | undefined | null, hasToolCalls: boolean): string | null {
  if (hasToolCalls && !text) return null
  return text ?? null
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** 对标 dsh：挂在 assistant/message 上的 provider usage（瘦字段）。 */
export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
}

export interface AssistantReply {
  content: string | null
  toolCalls: ToolCall[]
  replay?: NativeReplay
  usage?: LlmUsage
  /** 供应商请求 id：响应头或流里的 request_id，排查问题时提供给供应商。 */
  requestId?: string
  /** 供应商回复 id：OpenAI 兼容 chunk.id / Anthropic message.id；拿不到 requestId 时可作兜底。 */
  responseId?: string
}

export interface ChatOptions {
  /** 文本 delta；agent-loop 用来即时 append `assistant/chunk`。 */
  onDelta?: (text: string) => void | Promise<void>
  /** 思考/reasoning delta（DeepSeek V4 `reasoning_content` 等）；不进最终 message。 */
  onReasoningDelta?: (text: string) => void | Promise<void>
  /** 工具调用增量（name 出现后就开始推，长参数不必等整段生成完）。 */
  onToolDelta?: (call: { id: string; name: string; arguments: string }) => void | Promise<void>
  /** 单次调用输出上限；主要供自动 compact 使用，避免摘要失控。 */
  maxOutputTokens?: number
  /** 单次覆盖思考模式；自动 compact 默认关闭思考，减少延迟和 Token。 */
  thinking?: 'enabled' | 'disabled'
  /** 单次覆盖回放策略；摘要等内部请求使用精简回放，不发送原始思考。 */
  replayMode?: 'lean-replay' | 'native-replay'
  /** 调用前估算的输入 + 最大输出 Token，供供应商 TPM adapter 预留额度。 */
  estimatedTotalTokens?: number
}

export interface LlmClient {
  chat(
    messages: LlmMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantReply>
}

export function parseProviderUsage(raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const input = num(u.prompt_tokens ?? u.input_tokens ?? u.inputTokens)
  const output = num(u.completion_tokens ?? u.output_tokens ?? u.outputTokens)
  if (input == null && output == null) return undefined
  const total = num(u.total_tokens ?? u.totalTokens)
  const cacheRead = num(
    u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.cacheReadTokens,
  )
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total != null ? { totalTokens: total } : {}),
    ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function formatUsage(usage: LlmUsage | undefined): string {
  if (!usage) return ''
  const parts = [`${usage.inputTokens}→${usage.outputTokens}`]
  if (usage.cacheReadTokens) parts.push(`cache ${usage.cacheReadTokens}`)
  return parts.join(' · ')
}

export function nativeReplayRouteKey(config: LlmConfig, model = config.model, endpoint?: string): string {
  const protocol = config.provider === 'anthropic' ? 'anthropic' : 'openai-compat'
  const url = endpoint ?? (protocol === 'anthropic'
    ? resolveAnthropicMessagesUrl(config.baseUrl)
    : resolveChatCompletionsUrl(config.baseUrl, config.provider))
  return createHash('sha256')
    .update(JSON.stringify([config.provider, protocol, model, url, config.endpointId ?? '']))
    .digest('hex')
}

function replayError(detail: string): Error {
  return new Error(`原生回放无法继续工具历史：${detail}。请新建会话或清除上下文后重试；不会自动重跑工具。`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validReplayBlock(value: unknown): value is NativeReplayBlock {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'text': return typeof value.text === 'string'
    case 'thinking': return typeof value.thinking === 'string' && typeof value.signature === 'string' && !!value.signature
    case 'redacted_thinking': return typeof value.data === 'string' && !!value.data
    case 'tool_use': return typeof value.id === 'string' && !!value.id && typeof value.name === 'string' && !!value.name && isRecord(value.input)
    default: return false
  }
}

function replayForMessage(
  message: LlmMessage,
  config: LlmConfig,
  routeKey: string,
  protocol: NativeReplay['protocol'],
): NativeReplay | undefined {
  if (message.role !== 'assistant' || config.replayMode !== 'native-replay') return undefined
  if (message.replayMissing) throw replayError('分叉或恢复后原始响应状态不可用')
  const replay = message.replay
  const hasTools = !!message.tool_calls?.length
  const fail = (detail: string) => {
    if (hasTools || replay || message.replayRef) throw replayError(detail)
    return undefined
  }
  if (!replay || replay.version !== 1 || replay.complete !== true) return fail('缺少完整的原始响应状态')
  if (replay.routeKey !== routeKey || replay.protocol !== protocol) return fail('供应商、模型或入口已改变')
  if (protocol === 'openai-compat') {
    if ((replay.reasoningContent !== undefined || replay.reasoningField !== undefined)
      && (typeof replay.reasoningContent !== 'string'
        || !['reasoning_content', 'reasoning'].includes(replay.reasoningField ?? ''))) {
      return fail('原始 reasoning 字段不完整')
    }
  } else {
    if (!Array.isArray(replay.blocks) || !replay.blocks.every(validReplayBlock)) return fail('原始内容块或思考签名不完整')
    const nativeTools = replay.blocks.filter((block) => block.type === 'tool_use')
    const expected = message.tool_calls ?? []
    if (nativeTools.length !== expected.length || nativeTools.some((block, index) => {
      const call = expected[index]!
      return block.id !== call.id || block.name !== call.function.name
        || !isDeepStrictEqual(block.input, parseToolJson(call.function.arguments))
    })) return fail('工具调用与原始内容块不一致')
    if (replay.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
      !== textFromContent(message.content)) return fail('正文与原始内容块不一致')
  }
  return replay
}

function openAiMessages(messages: LlmMessage[], config: LlmConfig, routeKey: string): Record<string, unknown>[] {
  return messages.map((message) => {
    const replay = replayForMessage(message, config, routeKey, 'openai-compat')
    return {
      role: message.role,
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({
        id: call.id, type: call.type,
        function: { name: call.function.name, arguments: call.function.arguments },
      })) } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(replay?.reasoningField ? { [replay.reasoningField]: replay.reasoningContent } : {}),
    }
  })
}

function anthropicMessages(messages: LlmMessage[], config: LlmConfig, routeKey: string): Record<string, unknown>[] {
  return messages.filter((message) => message.role !== 'system').map((message) => {
    const replay = replayForMessage(message, config, routeKey, 'anthropic')
    if (replay?.blocks) return { role: 'assistant', content: replay.blocks }
    if (message.tool_call_id) return { role: 'user', content: toAnthropicContent(message.content, message.tool_call_id) }
    const content = toAnthropicContent(message.content)
    if (!message.tool_calls?.length) return { role: message.role, content }
    return {
      role: message.role,
      content: [
        ...(Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : []),
        ...message.tool_calls.map((call) => ({
          type: 'tool_use', id: call.id, name: call.function.name, input: parseToolJson(call.function.arguments),
        })),
      ],
    }
  })
}

interface StreamToolAcc {
  id: string
  name: string
  arguments: string
}

interface SseOptions {
  onDelta?: (text: string) => void | Promise<void>
  onReasoningDelta?: (text: string) => void | Promise<void>
  onToolDelta?: (call: ToolCall) => void | Promise<void>
  signal?: AbortSignal
  requestId?: string
  routeKey?: string
}

async function* ssePayloads(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw new Error('cancelled')
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new Error('cancelled')
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (done && buffer) buffer += '\n'
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (signal?.aborted) throw new Error('cancelled')
        const payload = sseDataLine(line)
        if (payload) yield payload
      }
      if (done) break
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** 解析 OpenAI/DeepSeek chat.completions SSE；`[DONE]` 结束。不引入 eventsource-parser。 */
export async function consumeChatCompletionSse(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): Promise<AssistantReply> {
  let content = ''
  let reasoningContent = ''
  let reasoningField: NativeReplay['reasoningField']
  let usage: LlmUsage | undefined
  let requestId = options.requestId
  let responseId: string | undefined
  const tools = new Map<number, StreamToolAcc>()
  let sawDone = false
  let captureComplete = true

  for await (const payload of ssePayloads(stream, options.signal)) {
    if (payload.trim() === '[DONE]') {
      sawDone = true
      break
    }
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      usage?: unknown
      error?: { message?: string }
      id?: unknown
      request_id?: unknown
    }
    try {
      chunk = JSON.parse(payload) as typeof chunk
    } catch {
      throw new Error('LLM 流包含无效 JSON，响应不完整，请重试。')
    }
    if (!chunk || typeof chunk !== 'object') throw new Error('LLM 流响应格式无效。')
    requestId ??= idString(chunk.request_id)
    responseId ??= idString(chunk.id)
    if (chunk.error) throw new Error(chunk.error.message || 'LLM 流返回错误。')
    const delta = chunk.choices?.[0]?.delta
    const field = typeof delta?.reasoning_content === 'string' ? 'reasoning_content'
      : typeof delta?.reasoning === 'string' ? 'reasoning' : undefined
    if (field) {
      if (reasoningField && reasoningField !== field) captureComplete = false
      if (typeof delta?.reasoning_content === 'string' && typeof delta.reasoning === 'string') captureComplete = false
      reasoningField = field
      reasoningContent += delta![field]!
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (typeof reasoning === 'string' && reasoning.length) await options.onReasoningDelta?.(reasoning)
    const text = delta?.content
    if (typeof text === 'string' && text.length) {
      content += text
      await options.onDelta?.(text)
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0
      if (!Number.isInteger(index) || index < 0) throw new Error('LLM 工具调用索引无效。')
      const acc = tools.get(index) ?? { id: '', name: '', arguments: '' }
      if (call.id) acc.id = call.id
      if (call.function?.name) acc.name = call.function.name
      if (typeof call.function?.arguments === 'string') acc.arguments += call.function.arguments
      tools.set(index, acc)
      if (acc.id && acc.name) await options.onToolDelta?.({ ...acc })
    }
    const nextUsage = parseProviderUsage(chunk.usage)
    if (nextUsage) usage = nextUsage
  }
  if (options.signal?.aborted) throw new Error('cancelled')
  if (!sawDone) throw new Error('LLM 流提前结束，响应不完整，请重试。')

  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => {
    if (!call.id || !call.name) throw new Error('LLM 工具调用不完整，请重试。')
    const args = call.arguments || '{}'
    try {
      if (!isRecord(JSON.parse(args))) throw new Error('invalid input')
    } catch {
      throw new Error('LLM 工具参数不完整，请重试。')
    }
    return { ...call, arguments: args }
  })
  if (!captureComplete && toolCalls.length) throw replayError('上游混用了不同 reasoning 字段，无法完整捕获')
  return {
    content: content || null,
    toolCalls,
    ...(options.routeKey && captureComplete ? { replay: {
      version: 1 as const, complete: true as const, routeKey: options.routeKey, protocol: 'openai-compat' as const,
      ...(reasoningField ? { reasoningContent, reasoningField } : {}),
    } } : {}),
    ...(usage ? { usage } : {}),
    ...(requestId ? { requestId } : {}),
    ...(responseId ? { responseId } : {}),
  }
}

function sseDataLine(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  return line.slice(5).replace(/^ /, '')
}

export class OpenAiCompatLlm implements LlmClient {
  constructor(private config: LlmConfig) {}

  async chat(
    messages: LlmMessage[],
    tools: unknown[] = [],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantReply> {
    const url = resolveChatCompletionsUrl(this.config.baseUrl, this.config.provider)
    // 仅 deepseek provider 支持自动路由到视觉模型；openai/anthropic 保持配置原状。
    const payload = flattenToolImagesForChatCompletions(messages)
    const hasImage = payload.some((m) => hasImageContent(m.content))
    const model =
      this.config.provider === 'deepseek' && hasImage
        ? DEEPSEEK_VISION_MODEL
        : this.config.model
    const config = {
      ...this.config, model,
      thinking: options?.thinking ?? this.config.thinking,
      replayMode: options?.replayMode ?? this.config.replayMode ?? 'lean-replay',
    }
    const routeKey = nativeReplayRouteKey(config, model, url)
    const body: Record<string, unknown> = {
      model,
      messages: openAiMessages(payload, config, routeKey),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options?.maxOutputTokens && options.maxOutputTokens > 0) {
      body.max_tokens = Math.floor(options.maxOutputTokens)
    }
    if (tools.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    attachProviderOptions(
      body,
      options?.thinking ? { ...this.config, thinking: options.thinking } : this.config,
      'openai-compat',
    )
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      throw await responseError(res)
    }
    if (!res.body) throw new Error('llm stream missing body')
    return consumeChatCompletionSse(res.body, {
      routeKey,
      onDelta: options?.onDelta,
      onReasoningDelta: options?.onReasoningDelta,
      onToolDelta: options?.onToolDelta,
      signal,
      requestId: requestIdFromHeaders(res.headers),
    })
  }
}

/**
 * Anthropic Messages API（/v1/messages，SSE）。请求体与事件格式均不同于 OpenAI 兼容接口：
 *  - 鉴权用 `x-api-key` + `anthropic-version` 头，不带 `authorization: Bearer`；
 *  - 顶层字段 `system`（字符串，放 system 消息）、`max_tokens`；
 *  - 工具参数通过 `content_block_delta` 里的 `input_json_delta.partial_json` 增量累积；
 *  - 结束由 `message_stop` 标志，无 `[DONE]`。
 */
export class AnthropicLlm implements LlmClient {
  constructor(private config: LlmConfig) {}

  async chat(
    messages: LlmMessage[],
    tools: unknown[] = [],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantReply> {
    const endpoint = resolveAnthropicMessagesUrl(this.config.baseUrl)
    const config = {
      ...this.config,
      thinking: options?.thinking ?? this.config.thinking,
      replayMode: options?.replayMode ?? this.config.replayMode ?? 'lean-replay',
    }
    const routeKey = nativeReplayRouteKey(config, config.model, endpoint)
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .filter((c) => c)
      .join('\n\n')
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: Math.floor(options?.maxOutputTokens || 4096),
      ...(system ? { system } : {}),
      messages: anthropicMessages(messages, config, routeKey),
      stream: true,
    }
    if (tools.length) {
      body.tools = tools.map((item) => {
        const fn = (item as { function?: { name: string; description?: string; parameters?: unknown } })
          .function
        return {
          name: fn?.name ?? 'unknown',
          description: fn?.description ?? '',
          input_schema: (fn?.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }
      })
    }
    attachProviderOptions(
      body,
      options?.thinking ? { ...this.config, thinking: options.thinking } : this.config,
      'anthropic',
    )
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      throw await responseError(res)
    }
    if (!res.body) throw new Error('llm stream missing body')
    return consumeMessagesSse(res.body, {
      routeKey,
      onDelta: options?.onDelta,
      onReasoningDelta: options?.onReasoningDelta,
      onToolDelta: options?.onToolDelta,
      signal,
      requestId: requestIdFromHeaders(res.headers),
    })
  }
}

function parseToolJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 返回暂存原串，避免构造请求直接抛出
    return { _raw: text }
  }
}

/** 解析 Anthropic Messages SSE：text（text_delta）+ 工具参数（input_json_delta）累积。 */
export async function consumeMessagesSse(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): Promise<AssistantReply> {
  let content = ''
  let usage: LlmUsage | undefined
  const requestId = options.requestId
  let responseId: string | undefined
  const blocks = new Map<number, { block: Record<string, unknown>; input: string; stopped: boolean }>()
  let sawStart = false
  let sawStop = false
  let captureComplete = true

  for await (const payload of ssePayloads(stream, options.signal)) {
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(payload) as Record<string, unknown>
    } catch {
      throw new Error('Anthropic 流包含无效 JSON，响应不完整，请重试。')
    }
    if (!isRecord(evt)) throw new Error('Anthropic 流响应格式无效。')
    switch (evt.type) {
      case 'error': {
        const error = isRecord(evt.error) ? evt.error : {}
        throw new Error(typeof error.message === 'string' ? error.message : 'Anthropic 流返回错误。')
      }
      case 'message_start': {
        if (sawStart) throw new Error('Anthropic 流包含重复消息。')
        sawStart = true
        const message = isRecord(evt.message) ? evt.message : {}
        if (Array.isArray(message.content) && message.content.length) captureComplete = false
        responseId ??= idString(message.id)
        const nextUsage = parseProviderUsage(message.usage)
        if (nextUsage) usage = nextUsage
        break
      }
      case 'message_delta': {
        const raw = isRecord(evt.usage) ? evt.usage : {}
        const nextUsage = parseProviderUsage({
          ...raw,
          input_tokens: raw.input_tokens ?? usage?.inputTokens,
          output_tokens: raw.output_tokens ?? usage?.outputTokens,
          cache_read_input_tokens: raw.cache_read_input_tokens ?? usage?.cacheReadTokens,
        })
        if (nextUsage) usage = nextUsage
        break
      }
      case 'content_block_start': {
        if (typeof evt.index !== 'number' || !Number.isInteger(evt.index) || evt.index < 0
          || blocks.has(evt.index) || !isRecord(evt.content_block)) throw new Error('Anthropic 内容块索引或起始状态无效。')
        const block = { ...evt.content_block }
        blocks.set(evt.index, { block, input: '', stopped: false })
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          content += block.text
          await options.onDelta?.(block.text)
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          await options.onReasoningDelta?.(block.thinking)
        } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          await options.onToolDelta?.({ id: block.id, name: block.name, arguments: '' })
        }
        break
      }
      case 'content_block_delta': {
        const delta = isRecord(evt.delta) ? evt.delta : {}
        const acc = typeof evt.index === 'number' ? blocks.get(evt.index) : undefined
        if (!acc) captureComplete = false
        if (acc?.stopped) throw new Error('Anthropic 已结束的内容块仍包含增量。')
        const block = acc?.block
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (block && block.type !== 'text') throw new Error('Anthropic 文本增量与内容块不一致。')
          if (block) block.text = String(block.text ?? '') + delta.text
          content += delta.text
          if (delta.text) await options.onDelta?.(delta.text)
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          if (block && block.type !== 'thinking') throw new Error('Anthropic 思考增量与内容块不一致。')
          if (block) block.thinking = String(block.thinking ?? '') + delta.thinking
          if (delta.thinking) await options.onReasoningDelta?.(delta.thinking)
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          if (block?.type !== 'thinking') throw new Error('Anthropic 思考签名缺少对应内容块。')
          block.signature = String(block.signature ?? '') + delta.signature
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (!acc || block?.type !== 'tool_use') throw new Error('Anthropic 工具增量缺少对应内容块。')
          acc.input += delta.partial_json
          if (typeof block.id === 'string' && typeof block.name === 'string') {
            await options.onToolDelta?.({ id: block.id, name: block.name, arguments: acc.input })
          }
        } else if (delta.type === 'citations_delta' && isRecord(delta.citation) && block?.type === 'text') {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation]
        } else {
          captureComplete = false
        }
        break
      }
      case 'content_block_stop': {
        const acc = typeof evt.index === 'number' ? blocks.get(evt.index) : undefined
        if (!acc || acc.stopped) throw new Error('Anthropic 内容块结束状态无效。')
        if (acc.block.type === 'tool_use' && acc.input) {
          try {
            acc.block.input = JSON.parse(acc.input)
          } catch {
            throw new Error('Anthropic 工具参数不完整，请重试。')
          }
        }
        if (!validReplayBlock(acc.block)) throw new Error('Anthropic 内容块或思考签名不完整，请新建会话或清除上下文后重试。')
        acc.stopped = true
        break
      }
      case 'message_stop': sawStop = true; break
      case 'ping': break
      default: captureComplete = false
    }
    if (sawStop) break
  }
  if (options.signal?.aborted) throw new Error('cancelled')
  if (!sawStop || [...blocks.values()].some((acc) => !acc.stopped)) {
    throw new Error('Anthropic 流提前结束，响应不完整，请重试。')
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0])
  captureComplete &&= sawStart && ordered.every(([index], position) => index === position)
  const nativeBlocks = ordered.map(([, acc]) => acc.block as NativeReplayBlock)
  const toolCalls: ToolCall[] = nativeBlocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }))
  if (!captureComplete && toolCalls.length) throw replayError('Anthropic 流缺少完整原始内容块')
  if (captureComplete) content = nativeBlocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  return {
    content: content || null,
    toolCalls,
    ...(options.routeKey && captureComplete ? { replay: {
      version: 1 as const, complete: true as const, routeKey: options.routeKey,
      protocol: 'anthropic' as const, blocks: nativeBlocks,
    } } : {}),
    ...(usage ? { usage } : {}),
    ...(requestId ? { requestId } : {}),
    ...(responseId ? { responseId } : {}),
  }
}

export class LlmService extends Service {
  private readonly tencentTokenPlanLimiters = new Map<string, TencentTokenPlanTpmLimiter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  private tencentTokenPlanLimiter(config: LlmConfig) {
    const limit = resolveTencentTokenPlanTpm()
    const headroom = resolveTencentTokenPlanHeadroom()
    const key = `${config.baseUrl ?? ''}\0${config.apiKey}\0${config.model}\0${limit}\0${headroom}`
    let limiter = this.tencentTokenPlanLimiters.get(key)
    if (!limiter) {
      limiter = new TencentTokenPlanTpmLimiter({ limit, headroom })
      this.tencentTokenPlanLimiters.set(key, limiter)
    }
    return limiter
  }

  forConfig(config: LlmConfig): LlmClient {
    const ctx = this.ctx
    const client =
      config.provider === 'anthropic'
        ? new AnthropicLlm(config)
        : new OpenAiCompatLlm(config)
    return {
      chat: async (messages, tools = [], signal, options) => {
        ctx.emit('llm/request', { model: config.model, provider: config.provider })
        const tokenPlan = isTencentTokenPlan(config)
        const maxOutputTokens = tokenPlan
          ? resolveTencentTokenPlanMaxOutput(config, options?.maxOutputTokens)
          : options?.maxOutputTokens
        const estimatedTotalTokens =
          options?.estimatedTotalTokens ??
          Math.ceil(JSON.stringify({ messages, tools }).length / 4) +
            Math.max(1, Math.floor(maxOutputTokens ?? config.outputReserveTokens ?? 4096))
        const limiter = tokenPlan ? this.tencentTokenPlanLimiter(config) : undefined
        for (let attempt = 0; ; attempt += 1) {
          const reservation = limiter
            ? await limiter.acquire(estimatedTotalTokens, signal)
            : undefined
          try {
            const reply = await client.chat(messages, tools, signal, {
              onDelta: async (text) => {
                ctx.emit('llm/stream', { text })
                await options?.onDelta?.(text)
              },
              onReasoningDelta: options?.onReasoningDelta,
              onToolDelta: options?.onToolDelta,
              maxOutputTokens,
              thinking: options?.thinking,
              replayMode: options?.replayMode,
              estimatedTotalTokens,
            })
            reservation?.finish(reply.usage)
            if (limiter && attempt > 0) {
              const snapshot = limiter.snapshot()
              appendTencentTokenPlanLog({
                event: 'retry_succeeded',
                model: config.model,
                endpointId: config.endpointId,
                attempt: attempt + 1,
                estimatedTokens: estimatedTotalTokens,
                maxOutputTokens,
                localWindowTokens: snapshot.windowTokens,
                localCapacity: snapshot.capacity,
                blockedUntil: snapshot.blockedUntil,
              })
            }
            return reply
          } catch (error) {
            reservation?.cancel()
            const retryDelay = limiter ? tencentTpmRetryDelay(error) : undefined
            const detail = error as Error & { code?: string | number; requestId?: string }
            if (retryDelay === undefined || !limiter || signal?.aborted) throw error
            limiter.defer(retryDelay)
            const snapshot = limiter.snapshot()
            appendTencentTokenPlanLog({
              event: attempt >= 1 ? 'retry_failed' : 'throttled',
              model: config.model,
              endpointId: config.endpointId,
              status: (detail as Error & { status?: number }).status,
              code: detail.code,
              requestId: detail.requestId,
              retryAfterMs: retryDelay,
              attempt: attempt + 1,
              estimatedTokens: estimatedTotalTokens,
              maxOutputTokens,
              localWindowTokens: snapshot.windowTokens,
              localCapacity: snapshot.capacity,
              blockedUntil: snapshot.blockedUntil,
            })
            if (attempt >= 1) throw error
            ctx.logger('host-llm').warn(
              `Tencent Token Plan TPM throttled; retrying after ${retryDelay}ms code=${detail.code ?? 'unknown'} request_id=${detail.requestId ?? 'unknown'}`,
            )
          }
        }
      },
    }
  }
}

export const name = 'llm'
export const inject = [] as const

export function apply(ctx: Context) {
  new LlmService(ctx)
}
