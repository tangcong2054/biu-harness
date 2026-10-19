import { Service, type Context } from 'cordis'
import { normalizeSchemaValue } from '@biu/type-file-system'
import {
  openAndMigrateBiu,
  readEditorContentRecord,
  writeEditorContent,
  runWithRequestWorkspace,
} from '@biu/host-plugin-loader/data-dir'
import {
  asDifficulty,
  asPriority,
  asStatus,
  defaultTrigger,
  mapRow,
  normalizeActor,
  normalizeReportIntervalSec,
  normalizeTrigger,
  type TaskActor,
  type TaskCreateInput,
  type TaskListFilter,
  type TaskReport,
  type TaskRow,
  type TaskUpdateInput,
} from './index.ts'

export type MysqlTaskRawRepository = {
  workspaceIds(): Promise<string[]>
  list(filter?: TaskListFilter, projected?: boolean): Promise<Array<Record<string, unknown>>>
  get(id: string): Promise<Record<string, unknown> | undefined>
  maxSort(status: string): Promise<number>
  insert(values: Record<string, unknown>): Promise<void>
  insertWithContent(values: Record<string, unknown>, body: string): Promise<void>
  update(id: string, values: Record<string, unknown>): Promise<void>
  updateWithContent(id: string, values: Record<string, unknown>, body: string): Promise<void>
  delete(id: string): Promise<boolean>
  deleteWithContent(id: string): Promise<boolean>
}

export type TaskContentRepository = {
  read(collection: string, recordId: string): Promise<{ body: string; version: number }>
  write?(collection: string, recordId: string, body: string): Promise<{ body: string; version: number }>
  delete?(collection: string, recordId: string): Promise<void>
}

export class SqliteTaskContentRepository implements TaskContentRepository {
  private readonly db: import('node:sqlite').DatabaseSync

  constructor(path: string) {
    this.db = openAndMigrateBiu(path, { foreignKeys: false })
  }

  async read(collection: string, recordId: string) {
    return readEditorContentRecord(this.db, collection, recordId)
  }

  async write(collection: string, recordId: string, body: string) {
    return writeEditorContent(this.db, collection, recordId, body)
  }

  async delete(collection: string, recordId: string) {
    this.db.prepare('DELETE FROM editor_content WHERE collection = ? AND record_id = ?').run(collection, recordId)
  }
}

export class ShadowTaskContentRepository implements TaskContentRepository {
  constructor(
    private readonly primary: TaskContentRepository,
    private readonly shadow: TaskContentRepository,
    private readonly warn: (error: unknown) => void,
  ) {}

  read(collection: string, recordId: string) {
    return this.primary.read(collection, recordId)
  }

  async write(collection: string, recordId: string, body: string) {
    const written = this.primary.write
      ? await this.primary.write(collection, recordId, body)
      : await this.primary.read(collection, recordId)
    try {
      await this.shadow.write?.(collection, recordId, body)
    } catch (error) {
      this.warn(error)
    }
    return written
  }

  async delete(collection: string, recordId: string) {
    await this.primary.delete?.(collection, recordId)
    try {
      await this.shadow.delete?.(collection, recordId)
    } catch (error) {
      this.warn(error)
    }
  }
}

const MAX_DEPTH = 3

function nextId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function actorsEqual(a: TaskActor | null, b: TaskActor | null) {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.name === b.name && (a.sessionId ?? '') === (b.sessionId ?? '')
}

export class MysqlTasksService extends Service {
  constructor(
    ctx: Context,
    private readonly repository: MysqlTaskRawRepository,
    private readonly content: TaskContentRepository,
    private readonly atomicContent = true,
    serviceName = 'tasks',
  ) {
    super(ctx, serviceName as 'tasks')
  }

  private emitChange(extra: Record<string, unknown> = {}) {
    try {
      ;(this.ctx as Context & { http?: { broadcast?(type: string, value: unknown): void } })
        .http?.broadcast?.('tasks', { ts: Date.now(), ...extra })
    } catch {
      /* test/minimal host */
    }
  }

  workspaceIds() {
    return this.repository.workspaceIds()
  }

  inWorkspace<T>(workspaceId: string, run: () => T) {
    return runWithRequestWorkspace(workspaceId, run)
  }

  async list(filter: TaskListFilter = {}) {
    return this.listRows(filter, false)
  }

  async listProjected(filter: TaskListFilter = {}) {
    return this.listRows(filter, true)
  }

  private async listRows(filter: TaskListFilter, projected: boolean) {
    if (!this.atomicContent && filter.q?.trim()) {
      const query = filter.q.trim().toLowerCase()
      const rawRows = await this.repository.list({ ...filter, q: undefined }, false)
      const matched: TaskRow[] = []
      for (const raw of rawRows) {
        const body = (await this.content.read('/tasks', String(raw.id))).body
        if (!`${JSON.stringify(raw)}\n${body}`.toLowerCase().includes(query)) continue
        matched.push({ ...mapRow(raw, projected), description: body })
      }
      return matched
    }
    const rows = (await this.repository.list(filter, projected)).map((row) => mapRow(row, projected))
    if (!filter.q?.trim()) return rows
    return Promise.all(rows.map((row) => this.withDescription(row)))
  }

  async get(id: string): Promise<TaskRow | undefined> {
    const row = await this.repository.get(id)
    return row ? this.withDescription(mapRow(row)) : undefined
  }

  private async withDescription(row: TaskRow) {
    const record = await this.content.read('/tasks', row.id)
    return { ...row, description: record.body }
  }

  async create(
    input: TaskCreateInput & { creator: TaskActor; assignee?: TaskActor | null; assignedAt?: number | null },
  ): Promise<TaskRow> {
    const title = String(input.title ?? '').trim()
    if (!title) throw new Error('title required')
    const requested = typeof input.id === 'string' ? input.id.trim() : ''
    const id = /^task_[A-Za-z0-9_-]+$/.test(requested) ? requested : nextId()
    const ts = typeof input.updatedAt === 'number' && input.updatedAt > 0 ? input.updatedAt : Date.now()
    const status = asStatus(input.status)
    const parentId = typeof input.parentId === 'string' && input.parentId ? input.parentId : null
    let depth = 0
    if (parentId) {
      const parent = await this.get(parentId)
      if (!parent) throw new Error(`unknown parent task: ${parentId}`)
      if (parent.depth + 1 > MAX_DEPTH) throw new Error(`depth exceeds MAX_DEPTH=${MAX_DEPTH}`)
      depth = parent.depth + 1
    }
    const creator = normalizeActor(input.creator, '用户') ?? { kind: 'user' as const, name: '用户' }
    const assignee = input.assignee ? normalizeActor(input.assignee) : null
    const assignedAt = assignee ? (input.assignedAt ?? ts) : null
    const dependsOn = (input.dependsOn ?? []).map(String).filter((value) => value && value !== id)
    const values = {
      id,
      title,
      status,
      priority: asPriority(input.priority),
      difficulty: asDifficulty(input.difficulty),
      assignee: assignee?.name ?? '',
      due_at: input.dueAt == null || Number.isNaN(Number(input.dueAt)) ? null : Number(input.dueAt),
      notes: String(input.notes ?? ''),
      sort: (await this.repository.maxSort(status)) + 1,
      created_at: ts,
      updated_at: ts,
      creator_json: JSON.stringify(creator),
      assignee_json: assignee ? JSON.stringify(assignee) : null,
      assigned_at: assignedAt,
      reports_json: '[]',
      start_at: null,
      project: typeof input.project === 'string' ? input.project.trim() : '',
      tags_json: JSON.stringify((input.tags ?? []).map(String).map((tag) => tag.trim()).filter(Boolean)),
      parent_id: parentId,
      depends_on: JSON.stringify(dependsOn),
      depth,
      trigger_json: JSON.stringify(normalizeTrigger(input.trigger)),
      report_interval_sec: normalizeReportIntervalSec(input.reportIntervalSec),
      last_report_prompt_at: null,
      report_prompt_count: 0,
      facet_json: JSON.stringify(normalizeSchemaValue(input.facet)),
      emoji: typeof input.emoji === 'string' ? input.emoji : '',
    }
    const description = String(input.description ?? '')
    if (this.atomicContent) await this.repository.insertWithContent(values, description)
    else {
      await this.repository.insert(values)
      await this.content.write?.('/tasks', id, description)
    }
    this.emitChange()
    return (await this.get(id))!
  }

  async update(
    id: string,
    patch: TaskUpdateInput & { assignee?: TaskActor | null; assignedAt?: number | null },
  ): Promise<TaskRow> {
    const current = await this.get(id)
    if (!current) throw new Error('unknown task')
    const title = patch.title == null ? current.title : String(patch.title).trim()
    if (!title) throw new Error('title required')
    const status = patch.status == null ? current.status : asStatus(patch.status)
    let sort = patch.sort == null ? current.sort : Number(patch.sort)
    if (status !== current.status && patch.sort == null) sort = (await this.repository.maxSort(status)) + 1
    let parentId = current.parentId
    let depth = current.depth
    if ('parentId' in patch) {
      parentId = typeof patch.parentId === 'string' && patch.parentId ? patch.parentId : null
      if (parentId) {
        if (parentId === id) throw new Error('cannot set a task as its own parent')
        const parent = await this.get(parentId)
        if (!parent) throw new Error(`unknown parent task: ${parentId}`)
        if (parent.depth + 1 > MAX_DEPTH) throw new Error(`depth exceeds MAX_DEPTH=${MAX_DEPTH}`)
        depth = parent.depth + 1
      } else depth = 0
    }
    let dependsOn = current.dependsOn
    if (patch.dependsOn !== undefined) {
      dependsOn = patch.dependsOn.map(String).filter((value) => value && value !== id)
      await this.assertNoCycle(id, dependsOn)
    }
    let creator = current.creator
    if ('creator' in patch) {
      creator = patch.creator
        ? (normalizeActor(patch.creator, '用户') ?? { kind: 'user', name: '用户' })
        : { kind: 'user', name: '用户' }
    }
    let assignee = current.assignee
    let assignedAt = current.assignedAt
    if ('assignee' in patch) {
      assignee = patch.assignee ? normalizeActor(patch.assignee) : null
      if (!actorsEqual(assignee, current.assignee)) assignedAt = assignee ? (patch.assignedAt ?? Date.now()) : null
    }
    const trigger = normalizeTrigger({ ...(current.trigger ?? defaultTrigger()), ...(patch.trigger ?? {}) })
    const values = {
      title,
      status,
      priority: patch.priority == null ? current.priority : asPriority(patch.priority),
      difficulty: patch.difficulty == null ? current.difficulty : asDifficulty(patch.difficulty),
      assignee: assignee?.name ?? '',
      due_at: patch.dueAt === undefined
        ? current.dueAt
        : patch.dueAt == null || Number.isNaN(Number(patch.dueAt)) ? null : Number(patch.dueAt),
      notes: patch.notes == null ? current.notes : String(patch.notes),
      sort,
      updated_at: typeof patch.updatedAt === 'number' && patch.updatedAt > 0 ? patch.updatedAt : Date.now(),
      creator_json: JSON.stringify(creator),
      assignee_json: assignee ? JSON.stringify(assignee) : null,
      assigned_at: assignedAt,
      project: patch.project === undefined ? (current.project ?? '') : String(patch.project ?? '').trim(),
      tags_json: JSON.stringify(patch.tags === undefined ? current.tags : patch.tags.map(String).map((tag) => tag.trim()).filter(Boolean)),
      parent_id: parentId,
      depends_on: JSON.stringify(dependsOn),
      depth,
      trigger_json: JSON.stringify(trigger),
      report_interval_sec: patch.reportIntervalSec === undefined
        ? current.reportIntervalSec
        : normalizeReportIntervalSec(patch.reportIntervalSec),
      last_report_prompt_at: patch.lastReportPromptAt === undefined
        ? current.lastReportPromptAt
        : patch.lastReportPromptAt == null ? null : Number(patch.lastReportPromptAt),
      report_prompt_count: patch.reportPromptCount === undefined
        ? current.reportPromptCount
        : Math.max(0, Math.round(Number(patch.reportPromptCount) || 0)),
      facet_json: JSON.stringify(patch.facet === undefined ? current.facet : normalizeSchemaValue(patch.facet)),
      emoji: patch.emoji === undefined ? current.emoji : String(patch.emoji ?? ''),
    }
    const description = patch.description == null ? current.description : String(patch.description)
    if (this.atomicContent) await this.repository.updateWithContent(id, values, description)
    else {
      await this.repository.update(id, values)
      await this.content.write?.('/tasks', id, description)
    }
    this.emitChange()
    return (await this.get(id))!
  }

  async delete(id: string) {
    const deleted = this.atomicContent
      ? await this.repository.deleteWithContent(id)
      : await this.repository.delete(id)
    if (deleted && !this.atomicContent) await this.content.delete?.('/tasks', id)
    if (deleted) this.emitChange()
    return deleted
  }

  async report(id: string, report: TaskReport) {
    const current = await this.get(id)
    if (!current) throw new Error('unknown task')
    await this.repository.update(id, {
      reports_json: JSON.stringify([...(current.reports ?? []), report]),
      updated_at: Date.now(),
      last_report_prompt_at: null,
      report_prompt_count: 0,
    })
    this.emitChange()
    return (await this.get(id))!
  }

  private async assertNoCycle(id: string, dependsOn: string[]) {
    const visited = new Set<string>()
    const dfs = async (nodeId: string): Promise<void> => {
      if (nodeId === id) throw new Error('dependency cycle detected')
      if (visited.has(nodeId)) return
      visited.add(nodeId)
      const node = await this.get(nodeId)
      if (!node) return
      for (const dependency of node.dependsOn) await dfs(dependency)
    }
    for (const dependency of dependsOn) await dfs(dependency)
  }
}

type TaskServiceLike = {
  list(filter?: TaskListFilter): TaskRow[] | Promise<TaskRow[]>
  listProjected(filter?: TaskListFilter): TaskRow[] | Promise<TaskRow[]>
  get(id: string): TaskRow | undefined | Promise<TaskRow | undefined>
  create(input: TaskCreateInput & { creator: TaskActor; assignee?: TaskActor | null; assignedAt?: number | null }): TaskRow | Promise<TaskRow>
  update(id: string, patch: TaskUpdateInput & { assignee?: TaskActor | null; assignedAt?: number | null }): TaskRow | Promise<TaskRow>
  delete(id: string): boolean | Promise<boolean>
  report(id: string, report: TaskReport): TaskRow | Promise<TaskRow>
}

export class ShadowTasksService {
  constructor(
    private readonly primary: TaskServiceLike,
    private readonly shadow: TaskServiceLike,
    private readonly warn: (error: unknown) => void,
    private readonly content?: TaskContentRepository,
  ) {}

  async list(filter: TaskListFilter = {}) {
    const rows = await this.primary.list(filter)
    if (!this.content) return rows
    return Promise.all(rows.map(async (row) => ({
      ...row,
      description: (await this.content!.read('/tasks', row.id)).body,
    })))
  }
  listProjected(filter: TaskListFilter = {}) { return this.primary.listProjected(filter) }
  async get(id: string) {
    const row = await this.primary.get(id)
    if (!row || !this.content) return row
    return { ...row, description: (await this.content.read('/tasks', id)).body }
  }

  async create(input: Parameters<TaskServiceLike['create']>[0]) {
    const row = await this.primary.create(input)
    try {
      await this.shadow.create({ ...input, id: row.id, updatedAt: row.updatedAt })
    } catch (error) {
      this.warn(error)
    }
    return row
  }

  async update(id: string, patch: Parameters<TaskServiceLike['update']>[1]) {
    const row = await this.primary.update(id, patch)
    try {
      await this.shadow.update(id, patch)
    } catch (error) {
      this.warn(error)
    }
    return row
  }

  async delete(id: string) {
    const deleted = await this.primary.delete(id)
    try {
      await this.shadow.delete(id)
    } catch (error) {
      this.warn(error)
    }
    return deleted
  }

  async report(id: string, report: TaskReport) {
    const row = await this.primary.report(id, report)
    try {
      await this.shadow.report(id, report)
    } catch (error) {
      this.warn(error)
    }
    return row
  }
}

export class ContentRoutedTasksService {
  constructor(
    private readonly primary: TaskServiceLike,
    private readonly content: TaskContentRepository,
    private readonly readFromContent: boolean,
    private readonly warn: (error: unknown) => void,
  ) {}

  async list(filter: TaskListFilter = {}) {
    const rows = await this.primary.list(filter)
    if (!this.readFromContent) return rows
    return Promise.all(rows.map(async (row) => ({
      ...row,
      description: (await this.content.read('/tasks', row.id)).body,
    })))
  }
  listProjected(filter: TaskListFilter = {}) { return this.primary.listProjected(filter) }
  async get(id: string) {
    const row = await this.primary.get(id)
    if (!row || !this.readFromContent) return row
    return { ...row, description: (await this.content.read('/tasks', id)).body }
  }
  async create(input: Parameters<TaskServiceLike['create']>[0]) {
    const row = await this.primary.create(input)
    try {
      await this.content.write?.('/tasks', row.id, row.description)
    } catch (error) {
      this.warn(error)
      if (this.readFromContent) throw error
    }
    return row
  }
  async update(id: string, patch: Parameters<TaskServiceLike['update']>[1]) {
    const row = await this.primary.update(id, patch)
    try {
      await this.content.write?.('/tasks', id, row.description)
    } catch (error) {
      this.warn(error)
      if (this.readFromContent) throw error
    }
    return row
  }
  async delete(id: string) {
    const deleted = await this.primary.delete(id)
    if (deleted) {
      try {
        await this.content.delete?.('/tasks', id)
      } catch (error) {
        this.warn(error)
      }
    }
    return deleted
  }
  report(id: string, report: TaskReport) { return this.primary.report(id, report) }
}
