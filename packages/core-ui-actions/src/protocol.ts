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

export type UiActionResult = {
  ref: string
  action: string
  risk: UiActionRisk
  ok: boolean
  detail?: string
  result?: unknown
  state?: Record<string, unknown>
  registryVersion: number
}

export type UiWaitRequest = {
  ref: string
  condition: 'exists' | 'visible' | 'hidden' | 'enabled' | 'disabled' | 'text-includes'
  value?: string
  timeoutMs?: number
}

export type UiWaitResult = {
  ref: string
  condition: UiWaitRequest['condition']
  matched: boolean
  elapsedMs: number
  target?: UiTargetDescriptor
}

export type UiClientHello = {
  type: 'hello'
  clientId: string
  route: string
  title?: string
  focused: boolean
  registryVersion: number
}

export type UiClientState = {
  type: 'client-state'
  clientId: string
  route: string
  title?: string
  focused: boolean
  registryVersion: number
}

export type UiRegistryChanged = {
  type: 'registry-changed'
  clientId: string
  registryVersion: number
}

export type UiCommand =
  | { type: 'command'; requestId: string; command: 'inspect'; args: UiInspectQuery }
  | { type: 'command'; requestId: string; command: 'action'; args: UiActionRequest }
  | { type: 'command'; requestId: string; command: 'wait'; args: UiWaitRequest }

export type UiCommandResult = {
  type: 'result'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export type UiClientMessage = UiClientHello | UiClientState | UiRegistryChanged | UiCommandResult
export type UiHostMessage = UiCommand

export const UI_ACTIONS_WS_PATH = '/ws/ui-actions'
export const UI_ACTIONS_DEFAULT_TIMEOUT_MS = 15_000
export const UI_ACTIONS_MAX_TIMEOUT_MS = 60_000
