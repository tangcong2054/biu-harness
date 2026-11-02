import { Service, type Context } from 'cordis'
import { formatLiveUiContext, type LiveUiContext } from '@biu/type-session'

export type SystemPromptSectionOptions = {
  /**
   * 回合开头、`assemble()` 之前在当前请求的账号 / 空间上下文里执行。
   * 片段需要异步数据（按账号查库）时在这里备好，`source` 仍同步读。
   */
  prepare?: () => Promise<void> | void
}

export class SystemPromptService extends Service {
  private sections = new Map<string, () => string>()
  private preparers = new Map<string, () => Promise<void> | void>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  register(id: string, source: string | (() => string), options: SystemPromptSectionOptions = {}) {
    return this.ctx.effect(() => {
      this.sections.set(id, typeof source === 'string' ? () => source : source)
      if (options.prepare) this.preparers.set(id, options.prepare)
      return () => {
        this.sections.delete(id)
        this.preparers.delete(id)
      }
    }, `systemPrompt.register ${id}`)
  }

  /** 并行执行各片段的 prepare。单个失败只记日志，不挡住回合，该片段按已有数据输出。 */
  async prepare() {
    const entries = [...this.preparers.entries()]
    const results = await Promise.allSettled(entries.map(([, run]) => run()))
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.ctx.logger('system-prompt').warn(`prepare ${entries[index]![0]} failed: ${String(result.reason)}`)
      }
    })
  }

  assemble(live?: LiveUiContext) {
    const parts = [...this.sections.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, source]) => source().trim())
      .filter(Boolean)
    const tools = this.ctx.tools?.names() ?? []
    parts.push(`可用工具会随插件装卸变化：${tools.join(', ') || '（无）'}。没有的工具不要调用。`)
    const ui = formatLiveUiContext(live)
    if (ui) parts.push(ui)
    return parts.join('\n')
  }
}

export const name = 'system-prompt'
export const inject = ['tools']

export function apply(ctx: Context) {
  const prompt = new SystemPromptService(ctx)
  prompt.register(
    'base',
    '你是控制台里的助手。优先调用已注册 tools 完成操作。回答简洁，不要堆废话。' +
      '判断一件事确实做不到时，直接说做不到并讲清原因，不要含糊其辞、反复硬试，也不要用长篇过程掩盖结论。',
  )
}
