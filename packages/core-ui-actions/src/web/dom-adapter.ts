import type {
  UiActionDescriptor,
  UiActionRequest,
  UiActionResult,
  UiInspectQuery,
  UiSurface,
  UiTargetDescriptor,
} from '../protocol.ts'

const DOM_SELECTOR = [
  '[data-biu-kind][data-biu-id]',
  'button',
  'input:not([type="hidden"]):not([type="password"])',
  'textarea',
  'select',
  'a[href]',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',')

const SENSITIVE_SELECTOR = '[data-biu-sensitive], [aria-label*="password" i], [aria-label*="secret" i]'

function text(el: Element, name: string) {
  const value = el.getAttribute(name)
  return value?.trim() || ''
}

function visible(el: HTMLElement) {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const box = el.getBoundingClientRect()
  return box.width > 0 && box.height > 0
}

function surfaceOf(el: Element): UiSurface {
  if (el.closest('[data-testid="chat-overlay-panel"], [role="dialog"]')) return 'overlay'
  if (el.closest('[data-testid="session-inspector"], .session-inspector')) return 'inspector'
  if (el.closest('.app-side-bar, [data-testid="app-sidebar"]')) return 'sidebar'
  if (el.closest('main, .app-stage, [data-testid="page-editor"]')) return 'main'
  return 'unknown'
}

function labelOf(el: HTMLElement) {
  return (
    text(el, 'data-biu-label') ||
    text(el, 'aria-label') ||
    text(el, 'title') ||
    (el instanceof HTMLInputElement ? el.placeholder : '') ||
    (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) ||
    el.tagName.toLowerCase()
  )
}

function riskOf(el: HTMLElement, fallback: UiActionDescriptor['risk']) {
  const risk = text(el, 'data-biu-risk')
  return risk === 'read' || risk === 'navigate' || risk === 'write' ||
    risk === 'submit' || risk === 'destructive'
    ? risk
    : fallback
}

function disabled(el: HTMLElement) {
  return Boolean(
    (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled ||
    el.getAttribute('aria-disabled') === 'true',
  )
}

function actionsOf(el: HTMLElement): UiActionDescriptor[] {
  const out: UiActionDescriptor[] = [{
    id: 'reveal',
    description: '滚动并高亮此 UI 对象',
    risk: 'navigate',
  }]
  const isDisabled = disabled(el)
  const semantic = text(el, 'data-biu-action')
  if (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLAnchorElement ||
    el.getAttribute('role') === 'button' ||
    semantic
  ) {
    const submit = el instanceof HTMLButtonElement && el.type === 'submit'
    out.push({
      id: semantic || 'click',
      description: `点击${labelOf(el)}`,
      risk: riskOf(el, submit ? 'submit' : el instanceof HTMLAnchorElement ? 'navigate' : 'write'),
      ...(isDisabled ? { disabled: true, disabledReason: '控件已禁用' } : {}),
    })
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      out.push({
        id: 'toggle',
        description: '切换选择状态',
        risk: riskOf(el, 'write'),
        ...(isDisabled ? { disabled: true, disabledReason: '控件已禁用' } : {}),
      })
    } else {
      out.push({
        id: 'fill',
        description: '填写输入内容',
        risk: riskOf(el, 'write'),
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        ...(isDisabled ? { disabled: true, disabledReason: '控件已禁用' } : {}),
      })
    }
  } else if (el instanceof HTMLTextAreaElement || el.isContentEditable) {
    out.push({
      id: 'fill',
      description: '填写输入内容',
      risk: riskOf(el, 'write'),
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      ...(isDisabled ? { disabled: true, disabledReason: '控件已禁用' } : {}),
    })
  } else if (el instanceof HTMLSelectElement) {
    out.push({
      id: 'select',
      description: '选择下拉项',
      risk: riskOf(el, 'write'),
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      ...(isDisabled ? { disabled: true, disabledReason: '控件已禁用' } : {}),
    })
  }
  out.push({
    id: 'focus',
    description: '聚焦此 UI 对象',
    risk: 'navigate',
  })
  return out
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export class DomUiAdapter {
  private seq = 0
  private readonly refs = new WeakMap<HTMLElement, string>()
  private readonly elements = new Map<string, HTMLElement>()

  private ref(el: HTMLElement) {
    const existing = this.refs.get(el)
    if (existing) return existing
    const serial = ++this.seq
    const kind = text(el, 'data-biu-kind') || el.getAttribute('role') || el.tagName.toLowerCase()
    const id = text(el, 'data-biu-id') || `${serial}`
    const ref = `dom:${encodeURIComponent(kind)}:${encodeURIComponent(id)}:${serial}`
    this.refs.set(el, ref)
    this.elements.set(ref, el)
    return ref
  }

  private target(el: HTMLElement, includeState = true): UiTargetDescriptor {
    const state: Record<string, unknown> = {}
    if (includeState) {
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox' || el.type === 'radio') state.checked = el.checked
        else state.value = el.value.slice(0, 2000)
      } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        state.value = el.value.slice(0, 2000)
      }
      state.text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
    }
    return {
      ref: this.ref(el),
      plugin: text(el, 'data-biu-plugin') || text(el.closest('[data-biu-plugin]') ?? el, 'data-biu-plugin') || undefined,
      instanceId: text(el, 'data-biu-id') || undefined,
      kind: text(el, 'data-biu-kind') || el.getAttribute('role') || el.tagName.toLowerCase(),
      label: labelOf(el),
      surface: surfaceOf(el),
      visible: visible(el),
      disabled: disabled(el),
      ...(includeState ? { state } : {}),
      actions: actionsOf(el),
    }
  }

  inspect(query: UiInspectQuery): UiTargetDescriptor[] {
    for (const [ref, el] of this.elements) {
      if (!el.isConnected) this.elements.delete(ref)
    }
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 15)))
    const nodes = query.ref
      ? [this.elements.get(query.ref)].filter((el): el is HTMLElement => Boolean(el))
      : Array.from(document.querySelectorAll<HTMLElement>(DOM_SELECTOR))
    const out: UiTargetDescriptor[] = []
    for (const el of nodes) {
      if (el.closest(SENSITIVE_SELECTOR) || el.closest('[data-biu-ignore]')) continue
      const target = this.target(el, query.includeState === true)
      if (query.plugin && target.plugin !== query.plugin) continue
      if (query.scope && query.scope !== 'current' && target.surface !== query.scope) continue
      if (query.action && !target.actions.some((action) => action.id === query.action)) continue
      if (!target.visible && !query.ref) continue
      out.push(target)
      if (out.length >= limit) break
    }
    return out
  }

  descriptor(ref: string) {
    const el = this.elements.get(ref)
    return el?.isConnected ? this.target(el) : undefined
  }

  async execute(request: UiActionRequest, registryVersion: number): Promise<UiActionResult> {
    const el = this.elements.get(request.ref)
    if (!el?.isConnected) throw new Error('UI 对象已失效，请重新调用 ui_inspect')
    const descriptor = this.target(el)
    const action = descriptor.actions.find((item) => item.id === request.action)
    if (!action) throw new Error(`UI 对象不支持动作：${request.action}`)
    if (action.disabled) throw new Error(action.disabledReason || 'UI 动作当前不可用')
    const value = typeof request.args?.value === 'string' ? request.args.value : ''
    if (request.action === 'reveal') {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      el.animate?.(
        [{ outline: '2px solid #7c3aed' }, { outline: '2px solid transparent' }],
        { duration: 900 },
      )
    } else if (request.action === 'focus') {
      el.focus()
    } else if (request.action === 'fill') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, value)
      else if (el.isContentEditable) {
        el.textContent = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      } else throw new Error('目标不是可填写控件')
    } else if (request.action === 'select') {
      if (!(el instanceof HTMLSelectElement)) throw new Error('目标不是下拉控件')
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (request.action === 'toggle') {
      if (!(el instanceof HTMLInputElement)) throw new Error('目标不是可切换控件')
      el.click()
    } else {
      el.click()
    }
    return {
      ref: request.ref,
      action: request.action,
      risk: action.risk,
      ok: true,
      state: this.target(el).state,
      registryVersion,
    }
  }
}
