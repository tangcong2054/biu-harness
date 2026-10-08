import type { Context } from 'cordis'
import {
  UI_ACTIONS_WS_PATH,
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

function clientId() {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(CLIENT_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${UI_ACTIONS_WS_PATH}`
}

class UiActionsWebClient {
  private socket: WebSocket | null = null
  private stopped = false
  private retryMs = 250
  private retryTimer: ReturnType<typeof setTimeout> | null = null
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
    this.connect()
    return () => this.stop()
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
      focused: this.focused(),
      registryVersion: this.service.version,
    }
  }

  private stateChanged = () => {
    this.send(this.stateMessage())
  }

  private registryChanged() {
    this.send({
      type: 'registry-changed',
      clientId: this.id,
      registryVersion: this.service.version,
    })
  }

  private connect() {
    if (this.stopped) return
    try {
      const socket = new WebSocket(wsUrl())
      this.socket = socket
      socket.onopen = () => {
        this.retryMs = 250
        this.send({
          type: 'hello',
          clientId: this.id,
          route: location.pathname,
          title: document.title,
          focused: this.focused(),
          registryVersion: this.service.version,
        })
      }
      socket.onmessage = (event) => {
        void this.onMessage(event.data)
      }
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null
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
      this.connect()
    }, this.retryMs)
    this.retryMs = Math.min(5000, this.retryMs * 2)
  }

  private send(message: UiClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private async onMessage(raw: unknown) {
    let command: UiHostMessage
    try {
      command = JSON.parse(String(raw)) as UiHostMessage
    } catch {
      return
    }
    if (command.type !== 'command') return
    let response: UiCommandResult
    try {
      const result = await this.execute(command)
      response = { type: 'result', requestId: command.requestId, ok: true, result }
    } catch (error) {
      response = { type: 'result', requestId: command.requestId, ok: false, error: String(error) }
    }
    this.send(response)
    this.stateChanged()
  }

  private execute(command: UiCommand) {
    if (command.command === 'inspect') return this.service.inspect(command.args, this.id)
    if (command.command === 'action') return this.service.execute(command.args)
    return this.service.wait(command.args)
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
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
