import { Service, type Context } from 'cordis'
import type { WebSocket } from 'ws'
import {
  UI_ACTIONS_DEFAULT_TIMEOUT_MS,
  UI_ACTIONS_MAX_TIMEOUT_MS,
  UI_ACTIONS_WS_PATH,
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
  focused: boolean
  registryVersion: number
  seenAt: number
}

type Pending = {
  clientId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export class UiActionsHostService extends Service {
  private readonly clients = new Map<string, Client>()
  private readonly bySocket = new Map<WebSocket, string>()
  private readonly pending = new Map<string, Pending>()

  constructor(ctx: Context) {
    super(ctx, 'uiActionsHost')
  }

  start() {
    return this.ctx.http.ws(UI_ACTIONS_WS_PATH, (socket) => {
      socket.on('message', (raw) => this.onMessage(socket, String(raw)))
      socket.on('close', () => this.onClose(socket))
      socket.on('error', () => this.onClose(socket))
    })
  }

  private onMessage(socket: WebSocket, raw: string) {
    let message: UiClientMessage
    try {
      message = JSON.parse(raw) as UiClientMessage
    } catch {
      return
    }
    if (message.type === 'hello' || message.type === 'client-state') {
      const previous = this.bySocket.get(socket)
      if (previous && previous !== message.clientId) this.clients.delete(previous)
      this.bySocket.set(socket, message.clientId)
      this.clients.set(message.clientId, {
        id: message.clientId,
        socket,
        route: message.route,
        title: message.title,
        focused: message.focused,
        registryVersion: message.registryVersion,
        seenAt: Date.now(),
      })
      return
    }
    if (message.type === 'registry-changed') {
      const client = this.clients.get(message.clientId)
      if (client?.socket === socket) {
        client.registryVersion = message.registryVersion
        client.seenAt = Date.now()
      }
      return
    }
    if (message.type === 'result') this.finish(socket, message)
  }

  private finish(socket: WebSocket, message: UiCommandResult) {
    const item = this.pending.get(message.requestId)
    if (!item || this.bySocket.get(socket) !== item.clientId) return
    this.pending.delete(message.requestId)
    clearTimeout(item.timer)
    item.cleanupAbort?.()
    if (message.ok) item.resolve(message.result)
    else item.reject(new Error(message.error || 'UI command failed'))
  }

  private onClose(socket: WebSocket) {
    const clientId = this.bySocket.get(socket)
    if (!clientId) return
    this.bySocket.delete(socket)
    if (this.clients.get(clientId)?.socket === socket) this.clients.delete(clientId)
    for (const [requestId, item] of this.pending) {
      if (item.clientId !== clientId) continue
      this.pending.delete(requestId)
      clearTimeout(item.timer)
      item.cleanupAbort?.()
      item.reject(new Error('UI 客户端已断开'))
    }
  }

  private select(clientId?: string) {
    if (clientId) {
      const exact = this.clients.get(clientId)
      if (!exact) throw new Error(`UI 客户端不可用：${clientId}`)
      return exact
    }
    const clients = [...this.clients.values()]
    if (!clients.length) throw new Error('没有已连接的 Biu UI 客户端；请先打开本机工作台')
    return clients.sort((a, b) =>
      Number(b.focused) - Number(a.focused) || b.seenAt - a.seenAt,
    )[0]!
  }

  call(
    command: UiCommand['command'],
    args: UiCommand['args'],
    options: { clientId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const client = this.select(options.clientId)
    if (options.signal?.aborted) return Promise.reject(new Error('cancelled'))
    const requestId = crypto.randomUUID()
    const timeoutMs = Math.min(
      UI_ACTIONS_MAX_TIMEOUT_MS,
      Math.max(1000, options.timeoutMs ?? UI_ACTIONS_DEFAULT_TIMEOUT_MS),
    )
    const payload = { type: 'command', requestId, command, args } as UiCommand
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        cleanupAbort?.()
        reject(new Error(`UI command timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = () => {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new Error('cancelled'))
      }
      const cleanupAbort = options.signal
        ? () => options.signal?.removeEventListener('abort', onAbort)
        : undefined
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { clientId: client.id, resolve, reject, timer, cleanupAbort })
      try {
        client.socket.send(JSON.stringify(payload))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        cleanupAbort?.()
        reject(error)
      }
    })
  }

  listClients() {
    return [...this.clients.values()].map(({ socket: _socket, ...client }) => client)
  }
}

export const name = 'ui-actions'
export const inject = ['http', 'tools', 'systemPrompt']

export function apply(ctx: Context) {
  const service = new UiActionsHostService(ctx)
  service.start()
  ctx.http.route('GET', '/api/ui-actions/clients', (route) => {
    route.send(200, { clients: service.listClients() })
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
        includeState: { type: 'boolean', description: '是否返回脱敏后的当前状态，默认 true。' },
        includeDom: { type: 'boolean', description: '是否包含零配置 DOM 控件，默认 true。' },
        limit: { type: 'number', description: '最多返回对象数，默认 30，最大 100。' },
      },
      additionalProperties: false,
    },
    execution: 'parallel',
    execute: (raw, signal) => {
      const { clientId, ...query } = raw
      return service.call('inspect', query as UiInspectQuery, {
        clientId: typeof clientId === 'string' ? clientId : undefined,
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
        confirm: { type: 'boolean', description: '仅 destructive 动作需要；用户明确确认后设为 true。' },
      },
      required: ['ref', 'action'],
      additionalProperties: false,
    },
    execute: async (raw, signal) => {
      const clientId = typeof raw.clientId === 'string' ? raw.clientId : undefined
      const request: UiActionRequest = {
        ref: String(raw.ref ?? ''),
        action: String(raw.action ?? ''),
        args: object(raw.args),
      }
      const inspected = await service.call('inspect', {
        ref: request.ref,
        includeDom: true,
        includeState: false,
        limit: 1,
      } satisfies UiInspectQuery, { clientId, signal }) as {
        targets?: Array<{ actions?: Array<{ id?: string; risk?: string }> }>
      }
      const descriptor = inspected.targets?.[0]?.actions?.find((item) => item.id === request.action)
      if (!descriptor) throw new Error('UI Action 已失效，请重新调用 ui_inspect')
      if (descriptor.risk === 'destructive' && raw.confirm !== true) {
        throw new Error('该 UI Action 属于 destructive；请先取得用户明确确认，再设置 confirm=true')
      }
      return service.call('action', request, { clientId, signal })
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
        value: { type: 'string', description: 'text-includes 条件需要的文本。' },
        timeoutMs: { type: 'number', description: '等待毫秒数，默认 10000，最大 60000。' },
      },
      required: ['ref', 'condition'],
      additionalProperties: false,
    },
    execution: 'parallel',
    execute: (raw, signal) => {
      const clientId = typeof raw.clientId === 'string' ? raw.clientId : undefined
      const request: UiWaitRequest = {
        ref: String(raw.ref ?? ''),
        condition: raw.condition as UiWaitRequest['condition'],
        value: typeof raw.value === 'string' ? raw.value : undefined,
        timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
      }
      return service.call('wait', request, {
        clientId,
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
