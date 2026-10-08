import { Service, type Context } from 'cordis'
import type {
  UiActionDescriptor,
  UiActionRequest,
  UiActionResult,
  UiInspectQuery,
  UiInspectResult,
  UiSurface,
  UiTargetDescriptor,
  UiWaitRequest,
  UiWaitResult,
} from '../protocol.ts'
import { DomUiAdapter } from './dom-adapter.ts'

export type UiActionHandler = UiActionDescriptor & {
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

export type UiTargetRegistration = {
  plugin: string
  instanceId: string
  kind: string
  label: string
  surface?: UiSurface
  visible?: () => boolean
  disabled?: () => boolean
  state?: () => Record<string, unknown>
  actions: Record<string, Omit<UiActionHandler, 'id'>>
}

type RegisteredTarget = {
  spec: UiTargetRegistration
  ref: string
}

function safeString(value: unknown, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : value
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth >= 4) return '[truncated]'
  if (typeof value === 'string') return safeString(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeValue(item, depth + 1))
  if (typeof value !== 'object') return String(value)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (/password|secret|api.?key|token|authorization/i.test(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = safeValue(item, depth + 1)
    }
  }
  return out
}

function validateArgs(schema: Record<string, unknown> | undefined, args: Record<string, unknown>) {
  if (!schema) return
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (typeof key === 'string' && !(key in args)) throw new Error(`缺少 UI Action 参数：${key}`)
  }
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, { type?: string; enum?: unknown[] }>
      : {}
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key]
    if (!rule) continue
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`UI Action 参数 ${key} 不在允许值中`)
    if (rule.type === 'string' && typeof value !== 'string') throw new Error(`UI Action 参数 ${key} 必须是字符串`)
    if (rule.type === 'number' && typeof value !== 'number') throw new Error(`UI Action 参数 ${key} 必须是数字`)
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`UI Action 参数 ${key} 必须是布尔值`)
    if (rule.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`UI Action 参数 ${key} 必须是对象`)
    }
  }
}

export class UiActionsService extends Service {
  version = 0
  private readonly targets = new Map<string, RegisteredTarget>()
  private readonly listeners = new Set<() => void>()
  private readonly dom = new DomUiAdapter()
  private targetSeq = 0

  constructor(ctx: Context) {
    super(ctx, 'uiActions')
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  register(spec: UiTargetRegistration) {
    const plugin = spec.plugin.trim()
    const instanceId = spec.instanceId.trim()
    if (!plugin || !instanceId) throw new Error('uiActions.register requires plugin and instanceId')
    const base = `ui:${encodeURIComponent(plugin)}:${encodeURIComponent(instanceId)}`
    let ref = base
    while (this.targets.has(ref)) ref = `${base}:${++this.targetSeq}`
    const target = { spec, ref }
    this.targets.set(ref, target)
    this.changed()
    return () => {
      if (this.targets.get(ref) !== target) return
      this.targets.delete(ref)
      this.changed()
    }
  }

  private registeredDescriptor(target: RegisteredTarget, includeState = true): UiTargetDescriptor {
    const { spec, ref } = target
    const actions = Object.entries(spec.actions).map(([id, action]) => ({
      id,
      description: action.description,
      risk: action.risk,
      ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
      ...(action.disabled ? { disabled: true } : {}),
      ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
    }))
    return {
      ref,
      plugin: spec.plugin,
      instanceId: spec.instanceId,
      kind: spec.kind,
      label: spec.label,
      surface: spec.surface ?? 'unknown',
      visible: spec.visible?.() ?? true,
      disabled: spec.disabled?.() ?? false,
      ...(includeState && spec.state ? { state: safeValue(spec.state()) as Record<string, unknown> } : {}),
      actions,
    }
  }

  inspect(query: UiInspectQuery, clientId: string): UiInspectResult {
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 30)))
    const registered: UiTargetDescriptor[] = []
    for (const target of this.targets.values()) {
      const descriptor = this.registeredDescriptor(target, query.includeState !== false)
      if (query.ref && descriptor.ref !== query.ref) continue
      if (query.plugin && descriptor.plugin !== query.plugin) continue
      if (query.scope && query.scope !== 'current' && descriptor.surface !== query.scope) continue
      if (query.action && !descriptor.actions.some((action) => action.id === query.action)) continue
      if (!descriptor.visible && !query.ref) continue
      registered.push(descriptor)
      if (registered.length >= limit) break
    }
    const remaining = Math.max(0, limit - registered.length)
    const dom = query.includeDom === false || remaining === 0
      ? []
      : this.dom.inspect({ ...query, limit: remaining })
    const targets = [...registered, ...dom]
    return {
      clientId,
      route: window.location.pathname,
      registryVersion: this.version,
      targets,
      ...(targets.length >= limit ? { truncated: true } : {}),
    }
  }

  descriptor(ref: string) {
    const registered = this.targets.get(ref)
    return registered ? this.registeredDescriptor(registered) : this.dom.descriptor(ref)
  }

  async execute(request: UiActionRequest): Promise<UiActionResult> {
    const registered = this.targets.get(request.ref)
    if (!registered) return this.dom.execute(request, this.version)
    const action = registered.spec.actions[request.action]
    if (!action) throw new Error(`UI 对象不支持动作：${request.action}`)
    if (action.disabled) throw new Error(action.disabledReason || 'UI 动作当前不可用')
    const args = request.args ?? {}
    validateArgs(action.inputSchema, args)
    const result = await action.run(args)
    return {
      ref: request.ref,
      action: request.action,
      risk: action.risk,
      ok: true,
      result: safeValue(result),
      ...(registered.spec.state
        ? { state: safeValue(registered.spec.state()) as Record<string, unknown> }
        : {}),
      registryVersion: this.version,
    }
  }

  async wait(request: UiWaitRequest, signal?: AbortSignal): Promise<UiWaitResult> {
    const started = Date.now()
    const timeout = Math.min(60_000, Math.max(0, request.timeoutMs ?? 10_000))
    while (true) {
      if (signal?.aborted) throw new Error('cancelled')
      const target = this.descriptor(request.ref)
      const text = String(target?.state?.text ?? '')
      const matched =
        request.condition === 'exists' ? Boolean(target) :
        request.condition === 'visible' ? Boolean(target?.visible) :
        request.condition === 'hidden' ? !target || !target.visible :
        request.condition === 'enabled' ? Boolean(target && !target.disabled) :
        request.condition === 'disabled' ? Boolean(target?.disabled) :
        request.condition === 'text-includes' ? Boolean(target && text.includes(request.value ?? '')) :
        false
      if (matched || Date.now() - started >= timeout) {
        return {
          ref: request.ref,
          condition: request.condition,
          matched,
          elapsedMs: Date.now() - started,
          ...(target ? { target } : {}),
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
}

declare module 'cordis' {
  interface Context {
    uiActions: UiActionsService
  }
}
