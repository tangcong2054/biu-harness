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

## 5. 实现与交付
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
    description: '用户需要做插件时使用：先上网调研同类软件或实现方式，多种方案先询问用户选择，没有类似方案时按 Apple 风格制作。',
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
