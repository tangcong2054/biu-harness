import type { Context } from 'cordis'
import {
  UI_ACTIONS_WS_PATH,
  UI_ACTIONS_PROTOCOL_VERSION,
  UI_ACTIONS_MAX_MESSAGE_BYTES,
  type UiActionBatchRequest,
  type UiClientMessage,
  type UiCommand,
  type UiCommandResult,
  type UiHostMessage,
} from '../protocol.ts'
import { UiActionsService } from './registry.ts'

export {
  UiActionsService,
  type UiActionHandler,
  type UiTargetRegistration,
} from './registry.ts'
export type {
  UiActionDescriptor,
  UiActionRequest,
  UiActionResult,
  UiActionRisk,
  UiInspectQuery,
  UiInspectResult,
  UiTargetDescriptor,
  UiWaitRequest,
  UiWaitResult,
} from '../protocol.ts'

const CLIENT_KEY = 'biu.ui-actions.client-id'

function browserRandomId() {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID()
    } catch {
      /* http:// 局域网地址上这个 API 不可用 */
    }
  }
  const bytes = new Uint8Array(16)
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function clientId() {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY)
    if (existing) return existing
    const id = browserRandomId()
    sessionStorage.setItem(CLIENT_KEY, id)
    return id
  } catch {
    return browserRandomId()
  }
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${UI_ACTIONS_WS_PATH}`
}

function workspaceId() {
  try {
    return sessionStorage.getItem('biu.workspaceId') || localStorage.getItem('biu.workspaceId') || ''
  } catch {
    return ''
  }
}

class UiActionsWebClient {
  private socket: WebSocket | null = null
  private stopped = false
  private retryMs = 250
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private token = ''
  private socketWorkspace = ''
  private readonly commands = new Map<string, AbortController>()
  private readonly id = clientId()
  private unsubscribeRegistry: (() => void) | undefined

  constructor(
    private readonly service: UiActionsService,
  ) {}

  start() {
    this.unsubscribeRegistry = this.service.subscribe(() => this.registryChanged())
    window.addEventListener('focus', this.stateChanged)
    window.addEventListener('blur', this.stateChanged)
    window.addEventListener('popstate', this.stateChanged)
    document.addEventListener('visibilitychange', this.stateChanged)
    this.heartbeatTimer = setInterval(this.stateChanged, 5000)
    void this.bootstrap()
    return () => this.stop()
  }

  private sessionId() {
    const match = location.pathname.match(/^\/s\/([^/]+)/)
    return match ? decodeURIComponent(match[1]!) : undefined
  }

  private focused() {
    return document.visibilityState !== 'hidden' && document.hasFocus()
  }

  private stateMessage(): UiClientMessage {
    return {
      type: 'client-state',
      clientId: this.id,
      route: location.pathname,
      title: document.title,
      sessionId: this.sessionId(),
      focused: this.focused(),
      registryVersion: this.service.version,
      protocolVersion: UI_ACTIONS_PROTOCOL_VERSION,
      targetCount: this.service.targetCount,
    }
  }

  private stateChanged = () => {
    if (this.socket && this.socketWorkspace !== workspaceId()) {
      this.socket.close()
      return
    }
    this.send(this.stateMessage())
  }

  private registryChanged() {
    this.send({
      type: 'registry-changed',
      clientId: this.id,
      registryVersion: this.service.version,
      targetCount: this.service.targetCount,
    })
  }

  private async bootstrap() {
    try {
      const response = await fetch('/api/ui-actions/bootstrap', { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`bootstrap ${response.status}`)
      const body = await response.json() as { token?: string; protocolVersion?: number }
      if (!body.token || body.protocolVersion !== UI_ACTIONS_PROTOCOL_VERSION) {
        throw new Error('UI Actions protocol mismatch')
      }
      this.token = body.token
      this.connect()
    } catch {
      this.scheduleReconnect()
    }
  }

  private connect() {
    if (this.stopped) return
    try {
      const workspace = workspaceId()
      const params = new URLSearchParams({ uiToken: this.token })
      if (workspace) params.set('workspaceId', workspace)
      const socket = new WebSocket(`${wsUrl()}?${params}`)
      this.socketWorkspace = workspace
      this.socket = socket
      socket.onopen = () => {
        this.retryMs = 250
        this.send({
          type: 'hello',
          clientId: this.id,
          route: location.pathname,
          title: document.title,
          sessionId: this.sessionId(),
          focused: this.focused(),
          registryVersion: this.service.version,
          protocolVersion: UI_ACTIONS_PROTOCOL_VERSION,
          targetCount: this.service.targetCount,
        })
      }
      socket.onmessage = (event) => {
        void this.onMessage(event.data)
      }
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null
          this.socketWorkspace = ''
        }
        this.scheduleReconnect()
      }
      socket.onerror = () => socket.close()
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.bootstrap()
    }, this.retryMs)
    this.retryMs = Math.min(5000, this.retryMs * 2)
  }

  private send(message: UiClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private async onMessage(raw: unknown) {
    if (new TextEncoder().encode(String(raw)).length > UI_ACTIONS_MAX_MESSAGE_BYTES) return
    let command: UiHostMessage
    try {
      command = JSON.parse(String(raw)) as UiHostMessage
    } catch {
      return
    }
    if (command.type === 'cancel') {
      this.commands.get(command.requestId)?.abort()
      return
    }
    if (command.type !== 'command') return
    const controller = new AbortController()
    this.commands.set(command.requestId, controller)
    let response: UiCommandResult
    try {
      const result = await this.execute(command, controller.signal)
      response = { type: 'result', requestId: command.requestId, ok: true, result }
    } catch (error) {
      response = { type: 'result', requestId: command.requestId, ok: false, error: String(error) }
    }
    this.commands.delete(command.requestId)
    this.send(response)
    this.stateChanged()
  }

  private execute(command: UiCommand, signal: AbortSignal) {
    if (command.command === 'inspect') return this.service.inspect(command.args, this.id)
    if (command.command === 'action') {
      return 'steps' in command.args
        ? this.service.executeBatch(command.args as UiActionBatchRequest, signal)
        : this.service.execute(command.args, signal)
    }
    return this.service.wait(command.args, signal)
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.retryTimer = null
    this.heartbeatTimer = null
    for (const controller of this.commands.values()) controller.abort()
    this.commands.clear()
    this.unsubscribeRegistry?.()
    this.unsubscribeRegistry = undefined
    window.removeEventListener('focus', this.stateChanged)
    window.removeEventListener('blur', this.stateChanged)
    window.removeEventListener('popstate', this.stateChanged)
    document.removeEventListener('visibilitychange', this.stateChanged)
    this.socket?.close()
    this.socket = null
  }
}

export const name = 'ui-actions-web'
export const inject = [] as const

export function apply(ctx: Context) {
  const service = new UiActionsService(ctx)
  const client = new UiActionsWebClient(service)
  ctx.effect(() => client.start(), 'ui-actions.websocket')
}
