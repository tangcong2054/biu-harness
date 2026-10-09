import { Service, type Context } from 'cordis'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { currentSessionId } from '@biu/host-sessions/scope'
import { UiActionsObservability, type UiActionLogEntry } from './observability.ts'
import {
  UI_ACTIONS_DEFAULT_TIMEOUT_MS,
  UI_ACTIONS_MAX_TIMEOUT_MS,
  UI_ACTIONS_MAX_MESSAGE_BYTES,
  UI_ACTIONS_WS_PATH,
  UI_ACTIONS_PROTOCOL_VERSION,
  type UiActionBatchRequest,
  type UiActionRequest,
  type UiClientMessage,
  type UiCommand,
  type UiCommandResult,
  type UiInspectQuery,
  type UiWaitRequest,
} from '../protocol.ts'

type Client = {
  id: string
  socket: WebSocket
  route: string
  title?: string
  sessionId?: string
  focused: boolean
  registryVersion: number
  targetCount: number
  seenAt: number
}

type Pending = {
  clientId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
  cacheKey?: string
  invalidateOnSuccess?: boolean
  observed: UiActionLogEntry
  startedAt: number
}

function allowedOrigin(request: IncomingMessage) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (parsed.host === request.headers.host) return true
    const devUi = process.env.SHARE_PROXY_UI?.replace(/\/$/, '')
    return Boolean(devUi && origin.replace(/\/$/, '') === devUi)
  } catch {
    return false
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function pluginFromRef(ref?: string) {
  if (!ref?.startsWith('ui:')) return undefined
  try {
    return decodeURIComponent(ref.split(':')[1] ?? '') || undefined
  } catch {
    return undefined
  }
}

export class UiActionsHostService extends Service {
  readonly observability = new UiActionsObservability()
  private readonly clients = new Map<string, Client>()
  private readonly bySocket = new Map<WebSocket, string>()
  private readonly pending = new Map<string, Pending>()
  private readonly inspectCache = new Map<string, unknown>()
  private readonly connectionToken = crypto.randomUUID()

  constructor(ctx: Context) {
    super(ctx, 'uiActionsHost')
  }

  start() {
    return this.ctx.http.ws(UI_ACTIONS_WS_PATH, (socket, request) => {
      const token = new URL(request.url ?? UI_ACTIONS_WS_PATH, 'http://localhost').searchParams.get('token')
      if (!allowedOrigin(request) || token !== this.connectionToken) {
        socket.close(1008, 'unauthorized')
        return
      }
      socket.on('message', (raw) => this.onMessage(socket, String(raw)))
      socket.on('close', () => this.onClose(socket))
      socket.on('error', () => this.onClose(socket))
    })
  }

  bootstrap(request: IncomingMessage) {
    if (!allowedOrigin(request)) return undefined
    return { token: this.connectionToken, protocolVersion: UI_ACTIONS_PROTOCOL_VERSION }
  }

  private onMessage(socket: WebSocket, raw: string) {
    if (Buffer.byteLength(raw, 'utf8') > UI_ACTIONS_MAX_MESSAGE_BYTES) {
      socket.close(1009, 'message too large')
      return
    }
    let message: UiClientMessage
    try {
      message = JSON.parse(raw) as UiClientMessage
    } catch {
      return
    }
    if (message.type === 'hello' || message.type === 'client-state') {
      if (message.protocolVersion !== UI_ACTIONS_PROTOCOL_VERSION) {
        socket.close(1008, 'protocol mismatch')
        return
      }
      const previous = this.bySocket.get(socket)
      if (previous && previous !== message.clientId) this.clients.delete(previous)
      const old = this.clients.get(message.clientId)
      const invalidate =
        !old ||
        old.route !== message.route ||
        old.sessionId !== message.sessionId ||
        old.registryVersion !== message.registryVersion
      this.bySocket.set(socket, message.clientId)
      this.clients.set(message.clientId, {
        id: message.clientId,
        socket,
        route: message.route,
        title: message.title,
        sessionId: message.sessionId,
        focused: message.focused,
        registryVersion: message.registryVersion,
        targetCount: message.targetCount,
        seenAt: Date.now(),
      })
      if (invalidate) this.clearClientCache(message.clientId)
      return
    }
    if (message.type === 'registry-changed') {
      const client = this.clients.get(message.clientId)
      if (client?.socket === socket) {
        client.registryVersion = message.registryVersion
        client.targetCount = message.targetCount
        client.seenAt = Date.now()
        this.clearClientCache(message.clientId)
        this.observability.record({
          event: 'registry_changed',
          clientId: message.clientId,
          route: client.route,
          sessionId: client.sessionId,
          registryVersion: message.registryVersion,
          targetCount: message.targetCount,
        })
      }
      return
    }
    if (message.type === 'result') this.finish(socket, message)
  }

  private clearClientCache(clientId: string) {
    for (const key of this.inspectCache.keys()) {
      if (key.startsWith(`${clientId}\0`)) this.inspectCache.delete(key)
    }
  }

  private cacheInspect(key: string, value: unknown) {
    this.inspectCache.delete(key)
    this.inspectCache.set(key, value)
    while (this.inspectCache.size > 100) {
      const oldest = this.inspectCache.keys().next().value
      if (typeof oldest !== 'string') break
      this.inspectCache.delete(oldest)
    }
  }

  private observation(
    client: Client,
    command: UiCommand['command'],
    args: UiCommand['args'],
    sessionId?: string,
  ): UiActionLogEntry {
    const record = args as unknown as Record<string, unknown>
    const ref = typeof record.ref === 'string' ? record.ref : undefined
    const actions =
      Array.isArray(record.steps)
        ? record.steps.map((step) => String(object(step).action ?? '')).filter(Boolean)
        : typeof record.action === 'string'
          ? [record.action]
          : undefined
    return {
      event: 'started',
      command,
      sessionId,
      clientId: client.id,
      route: client.route,
      plugin: pluginFromRef(ref),
      ref,
      actions,
      registryVersion: client.registryVersion,
      targetCount: client.targetCount,
    }
  }

  private finish(socket: WebSocket, message: UiCommandResult) {
    const item = this.pending.get(message.requestId)
    if (!item || this.bySocket.get(socket) !== item.clientId) return
    this.pending.delete(message.requestId)
    clearTimeout(item.timer)
    item.cleanupAbort?.()
    if (message.ok) {
      if (item.cacheKey) this.cacheInspect(item.cacheKey, message.result)
      if (item.invalidateOnSuccess) this.clearClientCache(item.clientId)
      this.observability.record({
        ...item.observed,
        event: 'succeeded',
        durationMs: Date.now() - item.startedAt,
        resultBytes: Buffer.byteLength(JSON.stringify(message.result ?? null)),
      })
      item.resolve(message.result)
    } else {
      this.observability.record({
        ...item.observed,
        event: 'failed',
        durationMs: Date.now() - item.startedAt,
        outcome: 'browser_error',
      })
      item.reject(new Error(message.error || 'UI command failed'))
    }
  }

  private onClose(socket: WebSocket) {
    const clientId = this.bySocket.get(socket)
    if (!clientId) return
    this.bySocket.delete(socket)
    if (this.clients.get(clientId)?.socket === socket) this.clients.delete(clientId)
    this.clearClientCache(clientId)
    for (const [requestId, item] of this.pending) {
      if (item.clientId !== clientId) continue
      this.pending.delete(requestId)
      clearTimeout(item.timer)
      item.cleanupAbort?.()
      this.observability.record({
        ...item.observed,
        event: 'failed',
        durationMs: Date.now() - item.startedAt,
        outcome: 'client_disconnected',
      })
      item.reject(new Error('UI 客户端已断开'))
    }
  }

  private select(clientId?: string, sessionId?: string) {
    if (clientId) {
      const exact = this.clients.get(clientId)
      if (!exact) throw new Error(`UI 客户端不可用：${clientId}`)
      if (sessionId && exact.sessionId !== sessionId) {
        throw new Error(`UI 客户端不属于当前 Session：${sessionId}`)
      }
      return exact
    }
    const clients = [...this.clients.values()]
    if (!clients.length) throw new Error('没有已连接的 Biu UI 客户端；请先打开本机工作台')
    const candidates = sessionId
      ? clients.filter((client) => client.sessionId === sessionId)
      : clients
    if (!candidates.length) {
      throw new Error(`当前 Session 没有绑定的 UI 客户端：${sessionId}`)
    }
    return candidates.sort((a, b) =>
      Number(b.focused) - Number(a.focused) || b.seenAt - a.seenAt,
    )[0]!
  }

  call(
    command: UiCommand['command'],
    args: UiCommand['args'],
    options: {
      clientId?: string
      sessionId?: string
      timeoutMs?: number
      signal?: AbortSignal
      observation?: Partial<UiActionLogEntry>
    } = {},
  ) {
    const client = this.select(options.clientId, options.sessionId)
    if (options.signal?.aborted) return Promise.reject(new Error('cancelled'))
    const activeForClient = [...this.pending.values()].filter((item) => item.clientId === client.id).length
    if (activeForClient >= 16) return Promise.reject(new Error('UI 客户端并发命令过多'))
    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    const observed = {
      ...this.observation(client, command, args, options.sessionId),
      ...options.observation,
      event: 'started' as const,
    }
    this.observability.record(observed)
    const timeoutMs = Math.min(
      UI_ACTIONS_MAX_TIMEOUT_MS,
      Math.max(1000, options.timeoutMs ?? UI_ACTIONS_DEFAULT_TIMEOUT_MS),
    )
    const cacheKey =
      command === 'inspect' && (args as UiInspectQuery).includeState !== true
        ? `${client.id}\0${client.registryVersion}\0${JSON.stringify(args)}`
        : undefined
    if (cacheKey && this.inspectCache.has(cacheKey)) {
      const cached = this.inspectCache.get(cacheKey)
      this.observability.record({ ...observed, event: 'cache_hit', cacheHit: true })
      this.observability.record({
        ...observed,
        event: 'succeeded',
        durationMs: Date.now() - startedAt,
        resultBytes: Buffer.byteLength(JSON.stringify(cached ?? null)),
      })
      return Promise.resolve(cached)
    }
    if (command === 'inspect') {
      this.observability.record({ ...observed, event: 'cache_miss', cacheHit: false })
    }
    const payload = { type: 'command', requestId, command, args } as UiCommand
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        if (client.socket.readyState === client.socket.OPEN) {
          client.socket.send(JSON.stringify({ type: 'cancel', requestId }))
        }
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        cleanupAbort?.()
        cancel()
        this.observability.record({
          ...observed,
          event: 'timeout',
          durationMs: Date.now() - startedAt,
          outcome: 'timeout',
        })
        reject(new Error(`UI command timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = () => {
        this.pending.delete(requestId)
        clearTimeout(timer)
        cancel()
        this.observability.record({
          ...observed,
          event: 'cancelled',
          durationMs: Date.now() - startedAt,
          outcome: 'cancelled',
        })
        reject(new Error('cancelled'))
      }
      const cleanupAbort = options.signal
        ? () => options.signal?.removeEventListener('abort', onAbort)
        : undefined
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        clientId: client.id,
        resolve,
        reject,
        timer,
        cleanupAbort,
        cacheKey,
        invalidateOnSuccess: command === 'action',
        observed,
        startedAt,
      })
      try {
        client.socket.send(JSON.stringify(payload))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        cleanupAbort?.()
        this.observability.record({
          ...observed,
          event: 'failed',
          durationMs: Date.now() - startedAt,
          outcome: 'send_failed',
        })
        reject(error)
      }
    })
  }

  listClients() {
    return [...this.clients.values()].map(({ socket: _socket, ...client }) => client)
  }
}

export const name = 'ui-actions'
export const inject = ['http', 'tools', 'systemPrompt', 'approvals']

export function apply(ctx: Context) {
  const service = new UiActionsHostService(ctx)
  service.start()
  ctx.effect(() => () => service.observability.dispose(), 'ui-actions.observability')
  ctx.http.route('GET', '/api/ui-actions/bootstrap', (route) => {
    const result = service.bootstrap(route.req)
    if (!result) {
      route.send(403, { error: 'forbidden origin' })
      return
    }
    route.send(200, result)
  })
  ctx.http.route('GET', '/api/ui-actions/clients', (route) => {
    route.send(200, { clients: service.listClients() })
  })
  ctx.http.route('GET', '/api/ui-actions/metrics', (route) => {
    route.send(200, service.observability.snapshot())
  })

  ctx.systemPrompt.register(
    'ui-actions',
    '需要操作当前 Biu 页面时，先调用 ui_inspect 发现当前对象和动作，再用 ui_action 执行；不要猜 ref、动作名或 DOM。操作后可用 ui_wait/ui_inspect 验证状态。没有 UI 客户端时改用已有 Host/DB 工具。',
  )

  ctx.tools.register({
    name: 'ui_inspect',
    description:
      '按需检查当前 Biu 浏览器中可操作的 UI 对象、状态和 Action。具体插件动作不会预注入；需要页面操作时先调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: '可选；指定浏览器客户端。默认选择当前聚焦客户端。' },
        scope: { type: 'string', enum: ['current', 'main', 'sidebar', 'inspector', 'overlay', 'unknown'] },
        plugin: { type: 'string', description: '可选插件 id，例如 websql。' },
        ref: { type: 'string', description: '可选；只检查此前返回的稳定 UI ref。' },
        action: { type: 'string', description: '可选；只返回支持该动作的对象。' },
        includeState: { type: 'boolean', description: '是否返回脱敏后的当前状态，默认 false。' },
        includeDom: { type: 'boolean', description: '是否包含零配置 DOM 控件；找到显式 Action 时默认 false。' },
        limit: { type: 'number', description: '最多返回对象数，默认 15，最大 100。' },
      },
      additionalProperties: false,
    },
    execution: 'parallel',
    execute: (raw, signal) => {
      const { clientId, ...query } = raw
      return service.call('inspect', query as UiInspectQuery, {
        clientId: typeof clientId === 'string' ? clientId : undefined,
        sessionId: currentSessionId(),
        signal,
      })
    },
  })

  ctx.tools.register({
    name: 'ui_action',
    description:
      '在当前 Biu 浏览器执行 ui_inspect 返回的语义 Action。只使用 inspect 返回的 ref/action/参数 Schema；不要自行构造。',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: '可选浏览器客户端 id。' },
        ref: { type: 'string', description: 'ui_inspect 返回的 UI ref。' },
        action: { type: 'string', description: 'ui_inspect 返回的 Action id。' },
        args: { type: 'object', description: '符合该 Action inputSchema 的参数。' },
        steps: {
          type: 'array',
          maxItems: 10,
          description: '可选；同一 ref 上顺序执行的非 destructive Action，减少模型往返。',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              args: { type: 'object' },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
      },
      required: ['ref'],
      anyOf: [{ required: ['action'] }, { required: ['steps'] }],
      additionalProperties: false,
    },
    execute: async (raw, signal) => {
      const clientId = typeof raw.clientId === 'string' ? raw.clientId : undefined
      const sessionId = currentSessionId()
      const ref = String(raw.ref ?? '')
      const steps = Array.isArray(raw.steps)
        ? raw.steps.slice(0, 10).map((step) => {
            const item = object(step)
            return { action: String(item.action ?? ''), args: object(item.args) }
          })
        : undefined
      const actions = steps?.map((step) => step.action) ?? [String(raw.action ?? '')]
      const inspected = await service.call('inspect', {
        ref,
        includeDom: true,
        includeState: false,
        limit: 1,
      } satisfies UiInspectQuery, { clientId, sessionId, signal }) as {
        targets?: Array<{ plugin?: string; actions?: Array<{ id?: string; risk?: string }> }>
      }
      const target = inspected.targets?.[0]
      const descriptors = actions.map((action) =>
        target?.actions?.find((item) => item.id === action),
      )
      if (descriptors.some((item) => !item)) throw new Error('UI Action 已失效，请重新调用 ui_inspect')
      const risks = descriptors.map((item) => String(item!.risk ?? 'write'))
      if (steps && risks.includes('destructive')) {
        throw new Error('批量 UI Action 不允许 destructive 动作')
      }
      const forceApproval = risks.includes('destructive')
      const holdApproval =
        ctx.approvals.mode === 'hold' &&
        risks.some((risk) => risk === 'write' || risk === 'submit' || risk === 'destructive')
      if (forceApproval || holdApproval) {
        service.observability.record({
          event: 'approval_requested',
          command: 'action',
          sessionId,
          clientId,
          plugin: target?.plugin ?? pluginFromRef(ref),
          ref,
          actions,
          risks,
        })
        const allow = await ctx.approvals.request({
          name: 'ui_action',
          args: { ref, actions, risks },
        }, forceApproval)
        if (!allow) {
          service.observability.record({
            event: 'approval_denied',
            command: 'action',
            sessionId,
            clientId,
            plugin: target?.plugin ?? pluginFromRef(ref),
            ref,
            actions,
            risks,
          })
          throw new Error('denied: ui_action')
        }
      }
      const request: UiActionRequest | UiActionBatchRequest = steps
        ? { ref, steps }
        : { ref, action: actions[0]!, args: object(raw.args) }
      return service.call('action', request, {
        clientId,
        sessionId,
        signal,
        observation: {
          plugin: target?.plugin ?? pluginFromRef(ref),
          actions,
          risks,
        },
      })
    },
  })

  ctx.tools.register({
    name: 'ui_wait',
    description:
      '等待此前 inspect 返回的 UI 对象达到可见、隐藏、启用、禁用或包含文本等状态，用于异步查询后验证页面。',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        ref: { type: 'string' },
        condition: {
          type: 'string',
          enum: ['exists', 'visible', 'hidden', 'enabled', 'disabled', 'text-includes'],
        },
        path: { type: 'string', description: '可选状态路径，例如 state.busy。' },
        operator: {
          type: 'string',
          enum: ['eq', 'ne', 'includes', 'exists', 'gt', 'gte', 'lt', 'lte'],
        },
        value: { description: 'text-includes 或结构化比较的目标值。' },
        timeoutMs: { type: 'number', description: '等待毫秒数，默认 10000，最大 60000。' },
      },
      required: ['ref'],
      anyOf: [{ required: ['condition'] }, { required: ['path', 'operator'] }],
      additionalProperties: false,
    },
    execution: 'parallel',
    execute: (raw, signal) => {
      const clientId = typeof raw.clientId === 'string' ? raw.clientId : undefined
      const request: UiWaitRequest = {
        ref: String(raw.ref ?? ''),
        condition: typeof raw.condition === 'string' ? raw.condition as UiWaitRequest['condition'] : undefined,
        path: typeof raw.path === 'string' ? raw.path : undefined,
        operator: typeof raw.operator === 'string' ? raw.operator as UiWaitRequest['operator'] : undefined,
        value: raw.value,
        timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
      }
      return service.call('wait', request, {
        clientId,
        sessionId: currentSessionId(),
        signal,
        timeoutMs: Math.min(60_000, Math.max(1000, (request.timeoutMs ?? 10_000) + 2000)),
      })
    },
  })
}

declare module 'cordis' {
  interface Context {
    uiActionsHost: UiActionsHostService
  }
}
