import type { Context } from 'cordis'
import { UiActionsService } from './registry.ts'

export { UiActionsService, type UiActionHandler, type UiTargetRegistration } from './registry.ts'

/**
 * 始终加载的 UI Action 注册表（web 内核表）。
 * 业务插件 inject ['uiActions'] 依赖它注册语义动作；Agent 通道（ui-actions-agent）关掉时它仍在，
 * 插件照常渲染，重新打开通道后已注册的动作可以直接被 inspect 到。
 */
export const name = 'ui-actions-registry'
export const inject = [] as const

export function apply(ctx: Context) {
  new UiActionsService(ctx)
}
