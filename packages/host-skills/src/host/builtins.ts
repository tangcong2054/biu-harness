import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skillRoot, type SkillRecord } from './store.ts'

/**
 * 随包发布的系统技能。只读、不落盘、不进 /skills 表（前端不展示），
 * 但 skill_list / skill_read / 系统提示词摘要里可见。
 * 云端按「空间」规则可见：本空间正式成员（含查看者）可见，外部协作者与访客不可见。
 * 空间 owner / admin 可通过 db_action /skills/<id> remove-builtin 从本空间移除。
 */
export const BUILTIN_PREFIX = 'sys-'

export function isBuiltinSkillId(id: string) {
  return String(id ?? '').trim().startsWith(BUILTIN_PREFIX)
}

const PLUGIN_MAKER = `# 制作插件

用户想做一个插件（新功能、小工具、面板、集成等）时，按下面的顺序来，不要一上来就写代码。

## 1. 先调研
- 用 web_search 搜索有没有实现同类功能的现成软件、开源项目或常见做法；需要细看时用 web_fetch 打开页面。
- 关键词至少换两三种说法（中文、英文、功能名、竞品名），避免漏掉主流方案。
- 每种方案记下：名字或链接、核心交互、优缺点、实现难度。

## 2. 有多种方案：先问用户
- 把找到的方案整理成简短对比（2–4 个即可），说明各自的样子和取舍。
- 明确询问用户想按哪种方式做，或要不要组合。用户没选之前不要开始实现。

## 3. 只有一种方案
- 简要说明这个方案和参考来源，确认用户同意后再按它实现。

## 4. 没有类似方案：按 Apple 风格设计
- 参考 Apple Human Interface Guidelines：内容优先、层级清晰、留白充足、对齐一致。
- 系统字体（-apple-system / SF Pro），克制的配色，强调色只用在关键操作上。
- 圆角卡片、柔和阴影、细分隔线；控件尺寸统一，点击区域不小于 44pt。
- 动效短而自然（约 200–300ms，ease-out），不做花哨装饰。
- 同时适配浅色和深色模式。

## 5. 默认做成页面块（在 page 里使用）
- 除非用户明确要别的形态（侧栏面板、纯后台工具等），插件默认做成能嵌进页面正文的块。
- web 端在 apply 里调用 ctx.pageEditor.registerBlock({ kind, plugin, label, blockType, View, ... })，plugin 必须等于插件 id；用到 data.file 等资产时要声明 assets。
- README 写清「示例写法」，给出完整的 :::pageBlock {kind=... plugin=...} 围栏，方便用户和 Agent 直接插入页面。
- 做完后真的插进一个页面里验证：能加载、能交互、刷新后还在。

## 6. 文字可选中，并能用 Ctrl/Cmd+L 发给 Agent
- 插件里展示的所有文字都必须能用鼠标选中：不要设置 user-select: none，不要把文字画在 canvas 里，不要放进 iframe 或 shadow DOM（这些地方的文字宿主拿不到）。
- 宿主在块上按下鼠标时会把整个块设为选中，按 Ctrl/Cmd+L 只会把整块发出去。所以：
  - 在放文字的容器上拦住 mousedown 冒泡（React 里 onMouseDown={(e) => e.stopPropagation()}），让浏览器能正常拖选文字；
  - 在插件根节点上用捕获阶段监听 keydown：Ctrl/Cmd+L（不带 Alt/Shift、不在输入法组合中）且 window.getSelection() 在插件内有非空文字时，preventDefault + stopPropagation，再通过宿主的 pick 服务（在 apply 里 ctx.inject(['pick'], (inner) => ...) 拿到 inner.pick）调用 attach，传入 { kind: 'text', id, label, route: location.pathname, selection: 选中的文字 }；没有选中文字时不拦截，交给宿主按整块发送。
- 自测：选中插件里的一段文字按 Ctrl/Cmd+L，确认对话框里收到的正是这段文字，而不是整个块。

## 7. 状态默认保存进页面（快照）
- 用户在插件里产生的内容和设置（输入、配置、结果、历史等），默认通过 View 收到的 update(patch) 写回块数据。块数据随页面 markdown 一起保存，退出重新登录后打开页面还能看到。
- 只保存可序列化、能还原界面的快照；大块内容放进 data.file 并在 registerBlock 的 assets 里声明，别把大文件直接塞进 JSON。
- 连接状态不要保存：WebSocket、远程会话、子进程、轮询定时器、token、在线/离线状态等都只放在运行时。重新打开页面时根据快照恢复界面，需要连接的再重新建立；连不上时界面仍要能展示已保存的内容。
- 写入要节流（例如输入停顿后再保存），别每次按键都写一次页面。

## 8. 实现与交付
- 按本项目的插件规范实现，做完自测能正常加载和运行。
- 告诉用户插件做了什么、怎么用、参考了哪个方案。
`

const DOCS = `# 官方文档

用户问官方文档、使用文档、帮助文档、说明书在哪里时，直接给出官方文档地址：

https://helloooooooooooooo97.github.io/biu

回答保持简短；如果用户问的是某个具体功能，可以在给出地址的同时提示去文档里查对应章节。
`

const BUILTINS: ReadonlyArray<Omit<SkillRecord, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'sys-plugin-maker',
    name: '制作插件',
    description: '用户需要做插件时使用：先上网调研同类软件或实现方式，多种方案先询问用户选择，没有类似方案时按 Apple 风格制作；默认做成页面块，文字可选中并支持 Ctrl/Cmd+L 发给 Agent，状态以快照保存进页面。',
    enabled: true,
    source: '',
    notes: PLUGIN_MAKER.trim(),
    tags: ['系统'],
    emoji: '',
  },
  {
    id: 'sys-docs',
    name: '官方文档',
    description: '用户问官方文档在哪里时使用：给出官方文档网址。',
    enabled: true,
    source: 'https://helloooooooooooooo97.github.io/biu',
    notes: DOCS.trim(),
    tags: ['系统'],
    emoji: '',
  },
]

export function builtinSkills(): SkillRecord[] {
  return BUILTINS.map((item) => ({ ...item, tags: [...item.tags], createdAt: 0, updatedAt: 0 }))
}

export function builtinSkill(id: string): SkillRecord | null {
  return builtinSkills().find((item) => item.id === id) ?? null
}

/** 各空间移除了哪些系统技能：{ [workspaceKey]: id[] }。磁盘上的内置内容只有一份，移除只影响该空间。 */
const REMOVED_FILE = '.builtin-removed.json'

function removedPath() {
  return join(skillRoot(), REMOVED_FILE)
}

function readRemoved(): Record<string, string[]> {
  try {
    const file = removedPath()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.map(String).filter(isBuiltinSkillId)
    }
    return out
  } catch {
    return {}
  }
}

function writeRemoved(data: Record<string, string[]>) {
  const file = removedPath()
  mkdirSync(skillRoot(), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2))
  renameSync(temp, file)
}

export function removedBuiltins(workspaceKey: string): Set<string> {
  return new Set(readRemoved()[workspaceKey] ?? [])
}

export function setBuiltinRemoved(workspaceKey: string, id: string, removed: boolean) {
  const data = readRemoved()
  const current = new Set(data[workspaceKey] ?? [])
  if (removed) current.add(id)
  else current.delete(id)
  if (current.size) data[workspaceKey] = [...current].sort()
  else delete data[workspaceKey]
  writeRemoved(data)
}
