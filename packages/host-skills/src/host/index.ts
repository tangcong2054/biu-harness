import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { currentAccountId, currentRequestWorkspaceId, isOnlineRuntime } from '@biu/host-plugin-loader/data-dir'
import type { Database } from '@biu/type-file-system'
import { skillsCollection } from './collection.ts'
import { builtinSkill, builtinSkills, isBuiltinSkillId, removedBuiltins, setBuiltinRemoved } from './builtins.ts'
import { LEGACY_MIGRATED, legacySkillImports, SkillsStore, trySkillId, type SkillImportInput, type SkillRecord } from './store.ts'

export type SkillSummary = {
  id: string
  name: string
  description: string
  source: string
}

type SkillAccount = {
  usesMysqlAccounts?: () => boolean
  mysql?: {
    claimRecord(input: {
      actorId: string
      workspaceId: string
      collection: string
      recordId: string
      now: number
    }): Promise<void>
    membership(accountId: string, workspaceId: string): Promise<{ role: string } | null>
    ownedRecordIds(workspaceId: string, collection: string): Promise<string[]>
    ownerWorkspaceIds(collection: string, recordId: string): Promise<string[]>
  }
  store?: {
    activeWorkspaceId?: () => string | null
    claim?: (actorId: string, workspaceId: string, collection: string, recordId: string) => unknown
  }
  authorization?: {
    currentActor?: () => { type: string; accountId: string; workspaceId: string } | null
    authorize?: (actor: unknown, action: string, resource: unknown) => { allowed?: boolean } | null
  }
}

export class SkillsService extends Service {
  private store: SkillsStore
  /** MySQL 模式下当前进程已知的「工作区 → 技能 id」。列表请求会先刷新。 */
  private ownedByWorkspace = new Map<string, Set<string>>()

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
    let database: Database | undefined
    try {
      database = this.ctx.get('database') as Database | undefined
    } catch {
      // 启动期数据库尚未注册时仍通知订阅者。
    }
    if (database?.collectionChanged) database.collectionChanged()
    else this.ctx.emit('database/change')
  }

  private account(): SkillAccount | undefined {
    try {
      return this.ctx.get('account') as SkillAccount | undefined
    } catch {
      return undefined
    }
  }

  private workspaceId() {
    return (
      currentRequestWorkspaceId().trim() ||
      this.account()?.store?.activeWorkspaceId?.()?.trim() ||
      String(process.env.BIU_SKILL_DEFAULT_WORKSPACE ?? '').trim()
    )
  }

  private rememberOwned(workspaceId: string, id: string) {
    const ids = this.ownedByWorkspace.get(workspaceId) ?? new Set<string>()
    ids.add(id)
    this.ownedByWorkspace.set(workspaceId, ids)
  }

  /** 把 MySQL 里这个工作区的技能 id 读进内存，供同步的列表和提示词使用。 */
  async ensureOwned() {
    const account = this.account()
    const mysql = account?.usesMysqlAccounts?.() ? account.mysql : undefined
    if (!mysql?.ownedRecordIds) return
    const workspaceId = this.workspaceId()
    const accountId = currentAccountId()
    if (!workspaceId || !accountId) {
      if (workspaceId) this.ownedByWorkspace.set(workspaceId, new Set())
      return
    }
    const member = await mysql.membership(accountId, workspaceId)
    if (!member) {
      this.ownedByWorkspace.set(workspaceId, new Set())
      return
    }
    this.ownedByWorkspace.set(workspaceId, new Set(await mysql.ownedRecordIds(workspaceId, '/skills')))
  }

  /**
   * 把技能认领到当前工作区。
   * 文件只落在运行目录的磁盘上；Online 没有 record_owners 时，列表会把它当成私有记录藏起来。
   */
  private async claimOwnership(id: string) {
    const actorId = currentAccountId()
    // 启动期的 legacy 迁移没有账号上下文，跳过即可（后续由使用者在页面里认领）。
    if (!actorId) return
    const account = this.account()
    const mysql = account?.usesMysqlAccounts?.() ? account.mysql : undefined
    if (!mysql?.claimRecord && !account?.store?.claim) {
      if (isOnlineRuntime()) throw new Error('无法认领 Skill：缺少账号服务')
      return
    }
    const workspaceId = this.workspaceId()
    if (!workspaceId) throw new Error('没有可用工作区，无法认领 Skill')
    if (mysql?.claimRecord) {
      const owners = await mysql.ownerWorkspaceIds('/skills', id)
      if (owners.some((owner) => owner !== workspaceId)) {
        throw new Error('这条技能已经属于另一个空间')
      }
      if (!owners.includes(workspaceId)) {
        await mysql.claimRecord({
          actorId,
          workspaceId,
          collection: '/skills',
          recordId: id,
          now: Date.now(),
        })
      }
      this.rememberOwned(workspaceId, id)
      return
    }
    account!.store!.claim!(actorId, workspaceId, '/skills', id)
  }

  /**
   * 云端：返回当前工作区可见的技能 id；`null` 表示不做过滤（本地 / 桌面模式）。
   * 技能目录是全局单份，只有这一层把「可见性」约束到工作区，
   * 否则 Agent 的 promptSection / skill_list / skill_read 会读到别的空间技能。
   */
  private visibleIds(skills = this.store.list()): Set<string> | null {
    try {
      const account = this.account()
      const authorization = account?.authorization
      const workspaceId = this.workspaceId()
      const accountId = currentAccountId()
      if (account?.usesMysqlAccounts?.()) {
        if (!workspaceId || !accountId) return new Set()
        return this.ownedByWorkspace.get(workspaceId) ?? new Set()
      }
      // 没有账号服务（本地 / 桌面）：沿用旧行为，全部可见。
      if (!authorization?.authorize) return null
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

  /**
   * 系统技能的空间键。本地 / 桌面（无鉴权）统一为 local；
   * 云端取当前工作区，拿不到时返回 null（fail-closed）。
   */
  private builtinScope(): { key: string; online: false } | { key: string; online: true; accountId: string } | null {
    try {
      const account = this.ctx.get('account') as {
        authorization?: { authorize?: unknown }
        store?: { activeWorkspaceId?: () => string | null }
      } | undefined
      if (!account?.authorization?.authorize) return { key: 'local', online: false }
      const workspaceId =
        account.store?.activeWorkspaceId?.()?.trim() ||
        String(process.env.BIU_SKILL_DEFAULT_WORKSPACE ?? '').trim()
      const accountId = currentAccountId()
      if (!workspaceId || !accountId) return null
      return { key: workspaceId, online: true, accountId }
    } catch {
      return null
    }
  }

  /** 云端按「空间」规则：本空间正式成员（owner/admin/member/viewer）可见，外部协作者、访客不可见。 */
  private isWorkspaceMember(accountId: string, workspaceId: string) {
    try {
      const account = this.ctx.get('account') as {
        store?: { members?: (actorId: string, workspaceId: string) => Array<{ id: string; member_kind?: string }> }
      } | undefined
      const members = account?.store?.members
      if (typeof members !== 'function') return false
      const me = members.call(account!.store, accountId, workspaceId).find((item) => item.id === accountId)
      return Boolean(me) && (me!.member_kind ?? 'member') === 'member'
    } catch {
      return false
    }
  }

  /** 当前空间可见的系统技能。 */
  builtins(): SkillRecord[] {
    const scope = this.builtinScope()
    if (!scope) return []
    if (scope.online && !this.isWorkspaceMember(scope.accountId, scope.key)) return []
    const removed = removedBuiltins(scope.key)
    return builtinSkills().filter((item) => !removed.has(item.id))
  }

  private requireBuiltin(id: string) {
    if (!builtinSkill(id)) throw new Error(`unknown builtin skill: ${id}`)
    const scope = this.builtinScope()
    if (!scope) throw new Error('没有可用工作区，无法操作系统技能')
    if (scope.online && !this.isWorkspaceMember(scope.accountId, scope.key)) {
      throw new Error(`unknown builtin skill: ${id}`)
    }
    return scope
  }

  /** 从当前空间移除系统技能；其他空间不受影响。权限由 /skills 的 resource:delete 把关（仅空间 owner / admin）。 */
  removeBuiltin(id: string) {
    const scope = this.requireBuiltin(id)
    setBuiltinRemoved(scope.key, id, true)
    this.changed()
    return { id, removed: true }
  }

  /** 恢复当前空间移除过的系统技能。 */
  restoreBuiltin(id: string) {
    const scope = this.requireBuiltin(id)
    setBuiltinRemoved(scope.key, id, false)
    this.changed()
    return { id, removed: false }
  }

  /** 给 Agent 用：系统技能 + 本空间可见的普通技能。前端 /skills 表只走 list()，不含系统技能。 */
  listAll(): SkillRecord[] {
    return [...this.builtins(), ...this.list().filter((item) => !builtinSkill(item.id))]
  }

  list(): SkillRecord[] {
    const all = this.store.list()
    const ids = this.visibleIds(all)
    return ids ? all.filter((item) => ids.has(item.id)) : all
  }

  /** 先对齐 MySQL 归属，再按当前工作区过滤。页面列表走这里。 */
  async listInWorkspace() {
    await this.ensureOwned()
    return this.list()
  }

  async recordInWorkspace(id: string) {
    await this.ensureOwned()
    return this.recordOrNull(id)
  }

  listEnabled() {
    return this.listAll().filter((skill) => skill.enabled && skill.description.trim())
  }

  summaries(): SkillSummary[] {
    return this.listEnabled().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
    }))
  }

  /** /skills 表的单条读取。系统技能不进表，这里一律不返回。 */
  recordOrNull(id: string) {
    if (builtinSkill(id)) return null
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
    if (builtinSkill(id)) {
      const builtin = this.builtins().find((item) => item.id === id)
      if (!builtin) throw new Error(`unknown skill: ${id}`)
      return builtin
    }
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

  async create(input: Parameters<SkillsStore['create']>[0]) {
    assertNotReserved(input.id)
    const created = this.store.create(input)
    if (isBuiltinSkillId(created.id)) {
      this.store.remove(created.id)
      assertNotReserved(created.id)
    }
    await this.claimOwnership(created.id)
    this.changed()
    return created
  }

  async import(input: SkillImportInput) {
    assertNotReserved(input.id)
    const created = this.store.import(input)
    if (isBuiltinSkillId(created.id)) {
      this.store.remove(created.id)
      assertNotReserved(created.id)
    }
    try {
      await this.claimOwnership(created.id)
    } catch (error) {
      this.store.remove(created.id)
      throw error
    }
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
            void this.claimOwnership(created.id).catch(() => undefined)
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
      'sys- 开头的是系统技能：只读，用 skill_read 读取，不能 db_update / db_content。空间 owner 或 admin 要求删除时用 db_action /skills/<id> remove-builtin（只从本空间移除），恢复用 restore-builtin。',
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
    execute: async (args) => {
      await skills.ensureOwned()
      return (args.all === true ? skills.listAll() : skills.summaries()).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        enabled: 'enabled' in skill ? skill.enabled : true,
      }))
    },
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
    execute: async (args) => {
      await skills.ensureOwned()
      return skills.read(String(args.id))
    },
  })

  ctx.http.route('POST', '/api/skills/import', async (route) => {
    try {
      const body = (await route.json()) as Partial<SkillImportInput>
      if (!Array.isArray(body.files) || !body.files.length) {
        route.send(400, { error: 'files are required' })
        return
      }
      const created = await skills.import({
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
      await skills.ensureOwned()
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

/** sys- 前缀保留给系统技能，用户新建 / 导入不能占用。 */
function assertNotReserved(id: unknown) {
  const raw = String(id ?? '').trim()
  if (!raw) return
  const normalized = trySkillId(raw) || raw.toLowerCase()
  if (isBuiltinSkillId(normalized)) throw new Error(`skill id 不能以 sys- 开头（保留给系统技能）：${raw}`)
}

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
