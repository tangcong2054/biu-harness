import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { currentAccountId } from '@biu/host-plugin-loader/data-dir'
import { skillsCollection } from './collection.ts'
import { LEGACY_MIGRATED, legacySkillImports, SkillsStore, type SkillImportInput, type SkillRecord } from './store.ts'

export type SkillSummary = {
  id: string
  name: string
  description: string
  source: string
}

export class SkillsService extends Service {
  private store: SkillsStore

  constructor(ctx: Context) {
    super(ctx, 'skills')
    this.store = new SkillsStore()
    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.register('skills', () => this.promptSection())
    })
    ctx.inject(['database'], (inner) => {
      inner.database.register(skillsCollection(this))
    })
  }

  private changed() {
    this.ctx.emit('hub/change')
    try {
      this.ctx.emit('database/change')
    } catch {
      // File System 尚未挂载时不影响仓库本身。
    }
  }

  /**
   * 把技能认领到当前工作区。
   * store 只写磁盘，不写 record_owners；云端开启账号鉴权后，
   * 没有归属记录的 /skills 记录会被 visibleRecords 判为 PRIVATE_RESOURCE 而列表不可见。
   * 云端导入必须补这一步，否则「导入成功但页面看不到」。
   */
  private claimOwnership(id: string) {
    try {
      const store = (this.ctx.get('account') as {
        store?: {
          activeWorkspaceId?: () => string | null
          claim?: (actorId: string, workspaceId: string, collection: string, recordId: string) => unknown
        }
      } | undefined)?.store
      if (!store?.claim) return
      const workspaceId = store.activeWorkspaceId?.() ?? ''
      const actorId = currentAccountId()
      // 启动期的 legacy 迁移没有账号上下文，跳过即可（后续由使用者在页面里认领）。
      if (!workspaceId || !actorId) return
      store.claim(actorId, workspaceId, '/skills', id)
    } catch {
      // 已归属其它空间 / 非成员等情况不影响技能本身已落盘。
    }
  }

  /**
   * 云端：返回当前工作区可见的技能 id；`null` 表示不做过滤（本地 / 桌面模式）。
   * 技能目录是全局单份，只有这一层把「可见性」约束到工作区，
   * 否则 Agent 的 promptSection / skill_list / skill_read 会读到别的空间技能。
   */
  private visibleIds(skills = this.store.list()): Set<string> | null {
    try {
      const account = this.ctx.get('account') as {
        authorization?: {
          currentActor?: () => { type: string; accountId: string; workspaceId: string } | null
          authorize?: (actor: unknown, action: string, resource: unknown) => { allowed?: boolean } | null
        }
        store?: { activeWorkspaceId?: () => string | null }
      } | undefined
      const authorization = account?.authorization
      // 没有账号服务（本地 / 桌面）：沿用旧行为，全部可见。
      if (!authorization?.authorize) return null
      const workspaceId =
        account?.store?.activeWorkspaceId?.()?.trim() ||
        String(process.env.BIU_SKILL_DEFAULT_WORKSPACE ?? '').trim() ||
        ''
      const accountId = currentAccountId()
      // 云端但拿不到工作区/账号：fail-closed，一条都不给。
      if (!workspaceId || !accountId) return new Set()
      const actor =
        authorization.currentActor?.() ?? ({ type: 'account', accountId, workspaceId } as const)
      if (actor && actor.workspaceId && actor.workspaceId !== workspaceId) return new Set()
      const ids = new Set<string>()
      for (const skill of skills) {
        const decision = authorization.authorize(actor, 'resource:read', {
          type: 'record',
          workspaceId,
          collection: '/skills',
          recordId: skill.id,
        })
        if (decision?.allowed) ids.add(skill.id)
      }
      return ids
    } catch {
      // 授权服务异常时宁可不给，也不要把全部技能暴露出去。
      return new Set()
    }
  }

  private allows(id: string) {
    const ids = this.visibleIds()
    return !ids || ids.has(id)
  }

  list(): SkillRecord[] {
    const all = this.store.list()
    const ids = this.visibleIds(all)
    return ids ? all.filter((item) => ids.has(item.id)) : all
  }

  listEnabled() {
    return this.list().filter((skill) => skill.enabled && skill.description.trim())
  }

  summaries(): SkillSummary[] {
    return this.listEnabled().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
    }))
  }

  recordOrNull(id: string) {
    if (!this.allows(id)) return null
    return this.store.get(id)
  }

  /** 已通过 list() 授权的记录使用，避免列表中每一行再次扫描全部技能做鉴权。 */
  filesOfListed(id: string): string[] {
    try {
      return this.store.listFiles(id, false)
    } catch {
      return []
    }
  }

  /** 只读派生：这条技能目录里已落盘的文件（相对路径，已排序）。 */
  filesOf(id: string): string[] {
    if (!this.allows(id)) return []
    return this.filesOfListed(id)
  }

  /** 读技能目录里一个文件的文本。相对路径已做越界校验。 */
  fileText(id: string, path: string): string {
    if (!this.allows(id)) throw new Error(`unknown skill: ${id}`)
    return this.store.readFile(id, path).text
  }

  record(id: string) {
    const skill = this.store.get(id)
    if (!skill || !this.allows(id)) throw new Error(`unknown skill: ${id}`)
    return skill
  }

  read(id: string) {
    const skill = this.record(id)
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: skill.enabled,
      body: skill.notes,
    }
  }

  create(input: Parameters<SkillsStore['create']>[0]) {
    const created = this.store.create(input)
    this.claimOwnership(created.id)
    this.changed()
    return created
  }

  import(input: SkillImportInput) {
    const created = this.store.import(input)
    this.claimOwnership(created.id)
    this.changed()
    return created
  }

  migrateLegacyDirectories() {
    let migrated = 0
    for (const entry of legacySkillImports()) {
      if (entry.input) {
        const id = String(entry.input.id || '')
        if (!(id && this.store.get(id))) {
          try {
            const created = this.store.import(entry.input)
            this.claimOwnership(created.id)
            migrated += 1
          } catch {
            // 已存在或目录不合法就跳过。
          }
        }
      }
      mkdirSync(entry.folder, { recursive: true })
      if (!existsSync(join(entry.folder, LEGACY_MIGRATED))) {
        writeFileSync(join(entry.folder, LEGACY_MIGRATED), '')
      }
    }
    if (migrated) this.changed()
    return migrated
  }

  patch(id: string, patch: { name?: unknown; description?: unknown; source?: unknown; enabled?: unknown; notes?: unknown; tags?: unknown; emoji?: unknown }) {
    const next = this.store.patch(id, patch)
    this.changed()
    return next
  }

  setEnabled(id: string, enabled: boolean) {
    return this.patch(id, { enabled })
  }

  remove(id: string) {
    const removed = this.store.remove(id)
    if (removed) this.changed()
    return removed
  }

  promptSection() {
    const howto = [
      '从 GitHub 安装技能：db_create /skills，files[] 用 {path, from} 拷整包（from 限工作区或 /tmp），不要把脚本全文塞进 content。',
      '纯正文只写 notes。额外文件用 bash 直接读写技能目录 .biu/skill/<id>/；已落盘的文件见记录的 fileList 字段。',
      'source 写上游 URL（仓库或具体 md），版权可追溯。',
    ]
    const skills = this.listEnabled()
    const lines = skills.map((skill) => {
      const src = skill.source ? ` 来源 ${skill.source}` : ''
      return `- ${skill.id}（${skill.name}）：${skill.description}${src}`
    })
    return [
      '<available_skills>',
      ...howto,
      ...(skills.length
        ? ['这些技能存在 /skills，这里只列摘要。相关时 skill_read 或 db_content /skills/<id>。', ...lines]
        : ['/skills 目前没有已启用技能。']),
      '</available_skills>',
    ].join('\n')
  }
}

export const name = 'skills'
export const inject = ['tools', 'database', 'http']

export function apply(ctx: Context) {
  const skills = new SkillsService(ctx)

  ctx.tools.register({
    name: 'skill_list',
    description: '列出 /skills。默认只列已启用项；all=true 包含停用项。',
    parameters: {
      type: 'object',
      properties: { all: { type: 'boolean' } },
    },
    execution: 'parallel',
    execute: (args) =>
      (args.all === true ? skills.list() : skills.summaries()).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        enabled: 'enabled' in skill ? skill.enabled : true,
      })),
  })

  ctx.tools.register({
    name: 'skill_read',
    description: '读取一个 Skill 的正文。和 db_content /skills/<id> 相同。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execution: 'parallel',
    execute: (args) => skills.read(String(args.id)),
  })

  ctx.http.route('POST', '/api/skills/import', async (route) => {
    try {
      const body = (await route.json()) as Partial<SkillImportInput>
      if (!Array.isArray(body.files) || !body.files.length) {
        route.send(400, { error: 'files are required' })
        return
      }
      const created = skills.import({
        id: body.id,
        name: body.name,
        description: body.description,
        source: body.source,
        tags: body.tags,
        emoji: body.emoji,
        enabled: body.enabled,
        files: body.files,
      })
      route.send(201, { ok: true, id: created.id })
    } catch (error) {
      route.send(400, { error: String(error instanceof Error ? error.message : error) })
    }
  })

  // 技能目录里的文件下载。浏览器拿不到磁盘，只能走 HTTP。
  // 路径走 query（路由编译器只支持 :name，不吃斜杠），安全性由 store.readFile 的相对路径校验兜住。
  ctx.http.route('GET', '/api/skills/file', async (route) => {
    try {
      const id = String(route.query?.get('id') ?? '').trim()
      const path = String(route.query?.get('path') ?? '').trim()
      if (!id || !path) {
        route.send(400, { error: 'id and path are required' })
        return
      }
      const file = skills.fileText(id, path)
      const name = path.split('/').pop() ?? path
      route.res.writeHead(200, {
        'content-type': skillFileMime(name),
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'cache-control': 'no-store',
      })
      route.res.end(file)
    } catch (error) {
      route.send(404, { error: String(error instanceof Error ? error.message : error) })
    }
  })

  const migrationTimer = setTimeout(() => {
    try {
      const migrated = skills.migrateLegacyDirectories()
      if (migrated) ctx.logger('skills').info(`migrated ${migrated} legacy skill directories`)
    } catch (error) {
      ctx.logger('skills').error(error)
    }
  }, 0)
  ctx.effect(() => () => clearTimeout(migrationTimer))
}

export type { SkillImportFile, SkillImportInput, SkillRecord } from './store.ts'
export { skillRoot } from './store.ts'

/** 技能文件下载用的 content-type。技能包以脚本和文本为主，够用即可。 */
function skillFileMime(name: string) {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'))
  if (ext === '.md' || ext === '.txt') return 'text/plain; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.py') return 'text/x-python; charset=utf-8'
  if (ext === '.sh') return 'text/x-shellscript; charset=utf-8'
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}
