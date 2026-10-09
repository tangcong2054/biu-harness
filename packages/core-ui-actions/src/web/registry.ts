import { Service, type Context } from 'cordis'
import { UI_ACTIONS_MAX_RESULT_BYTES } from '../protocol.ts'
import type {
  UiActionDescriptor,
  UiActionBatchRequest,
  UiActionBatchResult,
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
  run: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => unknown | Promise<unknown>
  settleMs?: number
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

function boundedValue(value: unknown) {
  const safe = safeValue(value)
  const json = JSON.stringify(safe)
  if (new TextEncoder().encode(json).length <= UI_ACTIONS_MAX_RESULT_BYTES) {
    return { value: safe, truncated: false }
  }
  return {
    value: {
      truncated: true,
      preview: json.slice(0, UI_ACTIONS_MAX_RESULT_BYTES / 2),
    },
    truncated: true,
  }
}

function valueAt(target: UiTargetDescriptor | undefined, path: string) {
  let value: unknown = target
  for (const segment of path.split('.').filter(Boolean)) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function compare(value: unknown, operator: NonNullable<UiWaitRequest['operator']>, expected: unknown) {
  if (operator === 'exists') return value !== undefined && value !== null
  if (operator === 'eq') return value === expected
  if (operator === 'ne') return value !== expected
  if (operator === 'includes') {
    return typeof value === 'string'
      ? value.includes(String(expected ?? ''))
      : Array.isArray(value) && value.includes(expected)
  }
  const left = Number(value)
  const right = Number(expected)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  if (operator === 'gt') return left > right
  if (operator === 'gte') return left >= right
  if (operator === 'lt') return left < right
  return left <= right
}

function safeBool(fn: (() => boolean) | undefined, fallback: boolean) {
  try {
    return fn?.() ?? fallback
  } catch {
    return fallback
  }
}

function validateArgs(schema: Record<string, unknown> | undefined, args: Record<string, unknown>) {
  if (!schema) return
  validateSchema(schema, args, 'args')
}

function validateSchema(schema: Record<string, unknown>, value: unknown, path: string) {
  const type = schema.type
  const validType =
    type === 'string' ? typeof value === 'string' :
    type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
    type === 'integer' ? typeof value === 'number' && Number.isInteger(value) :
    type === 'boolean' ? typeof value === 'boolean' :
    type === 'array' ? Array.isArray(value) :
    type === 'object' ? Boolean(value && typeof value === 'object' && !Array.isArray(value)) :
    true
  if (!validType) throw new Error(`UI Action 参数 ${path} 类型错误，应为 ${String(type)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`UI Action 参数 ${path} 不在允许值中`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`UI Action 参数 ${path} 小于最小值`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`UI Action 参数 ${path} 超过最大值`)
  }
  if (typeof value === 'string' && typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    throw new Error(`UI Action 参数 ${path} 过长`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`UI Action 参数 ${path} 项数过多`)
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => validateSchema(schema.items as Record<string, unknown>, item, `${path}[${index}]`))
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === 'string' && !(key in record)) throw new Error(`缺少 UI Action 参数：${path}.${key}`)
    }
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? schema.properties as Record<string, Record<string, unknown>>
        : {}
    if (schema.additionalProperties === false) {
      const extra = Object.keys(record).find((key) => !(key in properties))
      if (extra) throw new Error(`UI Action 参数不支持：${path}.${extra}`)
    }
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) validateSchema(properties[key]!, item, `${path}.${key}`)
    }
  }
}

export class UiActionsService extends Service {
  version = 0
  private readonly targets = new Map<string, RegisteredTarget>()
  private readonly listeners = new Set<() => void>()
  private readonly dom = new DomUiAdapter()
  private targetSeq = 0
  private activeWaits = 0

  constructor(ctx: Context) {
    super(ctx, 'uiActions')
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get targetCount() {
    return this.targets.size
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
    let state: Record<string, unknown> | undefined
    if (includeState && spec.state) {
      try {
        state = safeValue(spec.state()) as Record<string, unknown>
      } catch (error) {
        state = { error: `state failed: ${String(error)}` }
      }
    }
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
      visible: safeBool(spec.visible, true),
      disabled: safeBool(spec.disabled, false),
      ...(state ? { state } : {}),
      actions,
    }
  }

  inspect(query: UiInspectQuery, clientId: string): UiInspectResult {
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 15)))
    const registered: UiTargetDescriptor[] = []
    for (const target of this.targets.values()) {
      const descriptor = this.registeredDescriptor(target, query.includeState === true)
      if (query.ref && descriptor.ref !== query.ref) continue
      if (query.plugin && descriptor.plugin !== query.plugin) continue
      if (query.scope && query.scope !== 'current' && descriptor.surface !== query.scope) continue
      if (query.action && !descriptor.actions.some((action) => action.id === query.action)) continue
      if (!descriptor.visible && !query.ref) continue
      registered.push(descriptor)
      if (registered.length >= limit) break
    }
    const remaining = Math.max(0, limit - registered.length)
    const includeDom = query.includeDom === true || (query.includeDom !== false && registered.length === 0)
    const dom = !includeDom || remaining === 0
      ? []
      : this.dom.inspect({ ...query, limit: remaining })
    const candidates = [...registered, ...dom]
    const targets: UiTargetDescriptor[] = []
    let bytes = 0
    let clipped = false
    for (const target of candidates) {
      const nextBytes = new TextEncoder().encode(JSON.stringify(target)).length
      if (bytes + nextBytes > UI_ACTIONS_MAX_RESULT_BYTES) {
        clipped = true
        if (!targets.length) {
          targets.push({
            ...target,
            state: undefined,
            actions: target.actions.slice(0, 20).map(({ inputSchema: _schema, ...action }) => action),
          })
        }
        break
      }
      targets.push(target)
      bytes += nextBytes
    }
    return {
      clientId,
      route: window.location.pathname,
      registryVersion: this.version,
      targets,
      ...(clipped || targets.length < candidates.length || candidates.length >= limit ? { truncated: true } : {}),
    }
  }

  descriptor(ref: string) {
    const registered = this.targets.get(ref)
    return registered ? this.registeredDescriptor(registered) : this.dom.descriptor(ref)
  }

  async execute(request: UiActionRequest, signal?: AbortSignal): Promise<UiActionResult> {
    if (signal?.aborted) throw new Error('cancelled')
    const registered = this.targets.get(request.ref)
    if (!registered) return this.dom.execute(request, this.version)
    const action = registered.spec.actions[request.action]
    if (!action) throw new Error(`UI 对象不支持动作：${request.action}`)
    if (action.disabled) throw new Error(action.disabledReason || 'UI 动作当前不可用')
    const args = request.args ?? {}
    validateArgs(action.inputSchema, args)
    const result = await action.run(args, { signal })
    if (signal?.aborted) throw new Error('cancelled')
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, action.settleMs ?? 0))))
    const boundedResult = boundedValue(result)
    let boundedState: ReturnType<typeof boundedValue> | undefined
    if (registered.spec.state) {
      try {
        boundedState = boundedValue(registered.spec.state())
      } catch (error) {
        boundedState = boundedValue({ error: `state failed: ${String(error)}` })
      }
    }
    return {
      ref: request.ref,
      action: request.action,
      risk: action.risk,
      ok: true,
      result: boundedResult.value,
      ...(boundedState
        ? { state: boundedState.value as Record<string, unknown> }
        : {}),
      registryVersion: this.version,
      ...(boundedResult.truncated || boundedState?.truncated ? { truncated: true } : {}),
    }
  }

  async executeBatch(request: UiActionBatchRequest, signal?: AbortSignal): Promise<UiActionBatchResult> {
    if (!request.steps.length) throw new Error('UI Action batch 不能为空')
    if (request.steps.length > 10) throw new Error('UI Action batch 最多 10 步')
    const results: UiActionResult[] = []
    let bytes = 0
    let truncated = false
    for (const step of request.steps) {
      const descriptor = this.descriptor(request.ref)?.actions.find((item) => item.id === step.action)
      if (!descriptor) throw new Error(`UI 对象不支持动作：${step.action}`)
      if (descriptor.risk === 'destructive') throw new Error('batch 不允许 destructive Action')
      const result = await this.execute({
        ref: request.ref,
        action: step.action,
        args: step.args,
      }, signal)
      const resultBytes = new TextEncoder().encode(JSON.stringify(result)).length
      if (bytes + resultBytes <= UI_ACTIONS_MAX_RESULT_BYTES) {
        results.push(result)
        bytes += resultBytes
      } else {
        truncated = true
      }
    }
    return {
      ref: request.ref,
      ok: true,
      results,
      registryVersion: this.version,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  async wait(request: UiWaitRequest, signal?: AbortSignal): Promise<UiWaitResult> {
    if (this.activeWaits >= 4) throw new Error('同一 UI 客户端最多并行 4 个 ui_wait')
    this.activeWaits += 1
    const started = Date.now()
    const timeout = Math.min(60_000, Math.max(0, request.timeoutMs ?? 10_000))
    try {
      while (true) {
        if (signal?.aborted) throw new Error('cancelled')
        const target = this.descriptor(request.ref)
        const text = String(target?.state?.text ?? '')
        const structured = request.path && request.operator
          ? compare(valueAt(target, request.path), request.operator, request.value)
          : undefined
        const matched =
          structured !== undefined ? structured :
          request.condition === 'exists' ? Boolean(target) :
          request.condition === 'visible' ? Boolean(target?.visible) :
          request.condition === 'hidden' ? !target || !target.visible :
          request.condition === 'enabled' ? Boolean(target && !target.disabled) :
          request.condition === 'disabled' ? Boolean(target?.disabled) :
          request.condition === 'text-includes' ? Boolean(target && text.includes(String(request.value ?? ''))) :
          false
        if (matched || Date.now() - started >= timeout) {
          const targetTooLarge = Boolean(
            target &&
            new TextEncoder().encode(JSON.stringify(target)).length > UI_ACTIONS_MAX_RESULT_BYTES,
          )
          const safeTarget = targetTooLarge && target
            ? {
                ...target,
                state: undefined,
                actions: target.actions.map(({ inputSchema: _schema, ...action }) => action),
              }
            : target
          return {
            ref: request.ref,
            condition: request.condition,
            path: request.path,
            operator: request.operator,
            matched,
            elapsedMs: Date.now() - started,
            ...(safeTarget ? { target: safeTarget } : {}),
            ...(targetTooLarge ? { truncated: true } : {}),
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200))
      }
    } finally {
      this.activeWaits -= 1
    }
  }
}

declare module 'cordis' {
  interface Context {
    uiActions: UiActionsService
  }
}
