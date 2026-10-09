export type UiActionRisk = 'read' | 'navigate' | 'write' | 'submit' | 'destructive'
export type UiSurface = 'main' | 'sidebar' | 'inspector' | 'overlay' | 'unknown'

export type UiActionDescriptor = {
  id: string
  description: string
  risk: UiActionRisk
  inputSchema?: Record<string, unknown>
  disabled?: boolean
  disabledReason?: string
}

export type UiTargetDescriptor = {
  ref: string
  plugin?: string
  instanceId?: string
  kind: string
  label: string
  surface: UiSurface
  visible: boolean
  disabled?: boolean
  state?: Record<string, unknown>
  actions: UiActionDescriptor[]
}

export type UiInspectQuery = {
  scope?: 'current' | UiSurface
  plugin?: string
  ref?: string
  action?: string
  includeState?: boolean
  includeDom?: boolean
  limit?: number
}

export type UiInspectResult = {
  clientId: string
  route: string
  registryVersion: number
  targets: UiTargetDescriptor[]
  truncated?: boolean
}

export type UiActionRequest = {
  ref: string
  action: string
  args?: Record<string, unknown>
}

export type UiActionBatchRequest = {
  ref: string
  steps: Array<{ action: string; args?: Record<string, unknown> }>
}

export type UiActionResult = {
  ref: string
  action: string
  risk: UiActionRisk
  ok: boolean
  detail?: string
  result?: unknown
  state?: Record<string, unknown>
  registryVersion: number
  truncated?: boolean
}

export type UiActionBatchResult = {
  ref: string
  ok: boolean
  results: UiActionResult[]
  registryVersion: number
  truncated?: boolean
}

export type UiWaitOperator = 'eq' | 'ne' | 'includes' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'

export type UiWaitRequest = {
  ref: string
  condition?: 'exists' | 'visible' | 'hidden' | 'enabled' | 'disabled' | 'text-includes'
  path?: string
  operator?: UiWaitOperator
  value?: unknown
  timeoutMs?: number
}

export type UiWaitResult = {
  ref: string
  condition?: UiWaitRequest['condition']
  path?: string
  operator?: UiWaitOperator
  matched: boolean
  elapsedMs: number
  target?: UiTargetDescriptor
  truncated?: boolean
}

export type UiClientHello = {
  type: 'hello'
  clientId: string
  route: string
  title?: string
  sessionId?: string
  focused: boolean
  registryVersion: number
  protocolVersion: number
  targetCount: number
}

export type UiClientState = {
  type: 'client-state'
  clientId: string
  route: string
  title?: string
  sessionId?: string
  focused: boolean
  registryVersion: number
  protocolVersion: number
  targetCount: number
}

export type UiRegistryChanged = {
  type: 'registry-changed'
  clientId: string
  registryVersion: number
  targetCount: number
}

export type UiCommand =
  | { type: 'command'; requestId: string; command: 'inspect'; args: UiInspectQuery }
  | { type: 'command'; requestId: string; command: 'action'; args: UiActionRequest | UiActionBatchRequest }
  | { type: 'command'; requestId: string; command: 'wait'; args: UiWaitRequest }

export type UiCancelCommand = {
  type: 'cancel'
  requestId: string
}

export type UiCommandResult = {
  type: 'result'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export type UiClientMessage = UiClientHello | UiClientState | UiRegistryChanged | UiCommandResult
export type UiHostMessage = UiCommand | UiCancelCommand

export const UI_ACTIONS_WS_PATH = '/ws/ui-actions'
export const UI_ACTIONS_PROTOCOL_VERSION = 1
export const UI_ACTIONS_DEFAULT_TIMEOUT_MS = 15_000
export const UI_ACTIONS_MAX_TIMEOUT_MS = 60_000
export const UI_ACTIONS_MAX_RESULT_BYTES = 32 * 1024
export const UI_ACTIONS_MAX_MESSAGE_BYTES = 512 * 1024
