import type { LlmConfig, LlmMessage } from '@biu/host-llm'
import {
  estimateMessageTokens,
  estimateRequestTokens,
  estimateToolSchemaTokens,
  fitMessagesToTokenBudget,
} from '@biu/host-sessions'

export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_OUTPUT_RESERVE = 16_384
export const DEFAULT_AUTO_COMPACT_RATIO = 0.6
export const DEFAULT_HARD_CONTEXT_RATIO = 0.8
export const DEFAULT_COMPACT_OUTPUT = 4_096

export type ContextPolicy = {
  contextWindowTokens: number
  outputReserveTokens: number
  toolSchemaTokens: number
  autoCompactEnabled: boolean
  autoCompactRatio: number
  hardContextRatio: number
  autoCompactMessageTokens: number
  hardMessageTokens: number
  compactMaxOutputTokens: number
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function ratio(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0.2 && parsed <= 0.95 ? parsed : fallback
}

function enabled(value: unknown, fallback = true) {
  if (value == null || value === '') return fallback
  return !/^(0|false|off|disabled)$/i.test(String(value).trim())
}

export function resolveContextPolicy(
  config: LlmConfig,
  tools: unknown[],
  env: Record<string, string | undefined> = process.env,
): ContextPolicy {
  const contextWindowTokens = positiveInt(config.contextWindowTokens, DEFAULT_CONTEXT_WINDOW)
  const outputReserveTokens = Math.min(
    positiveInt(config.outputReserveTokens, DEFAULT_OUTPUT_RESERVE),
    Math.max(1, Math.floor(contextWindowTokens * 0.25)),
  )
  const toolSchemaTokens = estimateToolSchemaTokens(tools)
  const autoCompactRatio = ratio(env.BIU_AUTO_COMPACT_RATIO, DEFAULT_AUTO_COMPACT_RATIO)
  let hardContextRatio = ratio(env.BIU_CONTEXT_HARD_RATIO, DEFAULT_HARD_CONTEXT_RATIO)
  if (hardContextRatio <= autoCompactRatio) {
    hardContextRatio = Math.min(0.95, autoCompactRatio + 0.15)
  }

  const hardTotal = Math.floor(contextWindowTokens * hardContextRatio)
  let hardMessageTokens = Math.max(0, hardTotal - outputReserveTokens - toolSchemaTokens)
  const legacyBudget = Number(env.CTX_BUDGET)
  if (Number.isFinite(legacyBudget) && legacyBudget > 0) {
    hardMessageTokens = Math.min(hardMessageTokens, Math.floor(legacyBudget))
  }

  const compactTotal = Math.floor(contextWindowTokens * autoCompactRatio)
  let autoCompactMessageTokens = Math.max(0, compactTotal - outputReserveTokens - toolSchemaTokens)
  // 显式旧预算仍有意义：在它的 75% 提前做语义压缩，而不是到点后粗裁剪。
  if (Number.isFinite(legacyBudget) && legacyBudget > 0) {
    autoCompactMessageTokens = Math.min(autoCompactMessageTokens, Math.floor(legacyBudget * 0.75))
  }
  autoCompactMessageTokens = Math.min(
    autoCompactMessageTokens,
    Math.max(0, Math.floor(hardMessageTokens * 0.8)),
  )

  return {
    contextWindowTokens,
    outputReserveTokens,
    toolSchemaTokens,
    autoCompactEnabled: enabled(env.BIU_AUTO_COMPACT, true),
    autoCompactRatio,
    hardContextRatio,
    autoCompactMessageTokens,
    hardMessageTokens,
    compactMaxOutputTokens: Math.min(
      positiveInt(env.BIU_COMPACT_MAX_OUTPUT, DEFAULT_COMPACT_OUTPUT),
      outputReserveTokens,
    ),
  }
}

export function messageTokenTotal(messages: LlmMessage[]) {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

export function projectedRequestTokens(
  messages: LlmMessage[],
  tools: unknown[],
  outputReserveTokens: number,
) {
  return estimateRequestTokens(messages, tools) + outputReserveTokens
}

export const AUTO_COMPACT_PROMPT = `你是 Agent 会话压缩器。请把此前上下文压缩成一份可直接接手执行的结构化摘要。

必须保留：
1. 当前任务目标和用户原话中的硬约束
2. 已完成事项与可验证结果
3. 关键技术决策及原因
4. 已修改文件、重要符号和接口
5. 失败尝试、错误信息与不能重复踩的坑
6. 当前正在执行的位置
7. 未完成事项和明确下一步
8. 用户偏好、禁止事项、提交/推送状态

要求：
- 只总结事实，不编造
- 路径、命令、ID、数值保持准确
- 当前用户请求必须完整保留
- 工具输出只保留结论和关键证据
- 输出简洁但足以让另一个 Agent 无缝继续
- 不回答原任务，只输出摘要`

function withoutPrimarySystem(messages: LlmMessage[]): LlmMessage[] {
  const output = [...messages]
  if (output[0]?.role === 'system') output.shift()
  return output.map((message) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'image_url'
          ? { type: 'text' as const, text: '（历史消息包含图片，图片二进制未放入压缩请求）' }
          : part,
      ),
    }
  })
}

export function buildAutoCompactMessages(
  source: LlmMessage[],
  hardMessageTokens: number,
): { messages: LlmMessage[]; droppedMessages: number; overBudget: boolean } {
  const system: LlmMessage = { role: 'system', content: AUTO_COMPACT_PROMPT }
  const instruction: LlmMessage = { role: 'user', content: '请现在输出上述结构化压缩摘要。' }
  const fixed = estimateMessageTokens(system) + estimateMessageTokens(instruction)
  const historyBudget = Math.max(0, hardMessageTokens - fixed)
  const history = fitMessagesToTokenBudget(withoutPrimarySystem(source), historyBudget)
  return {
    messages: [system, ...history.messages, instruction],
    droppedMessages: history.droppedMessages,
    overBudget: history.overBudget,
  }
}
