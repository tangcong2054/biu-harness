import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { currentRequestWorkspaceId } from '@biu/host-plugin-loader/data-dir'

const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type RuntimeRepositoryMode = 'sqlite' | 'mysql' | 'shadow'

export function resolveRuntimeRepositoryMode(
  backend: 'sqlite' | 'dual' | 'mysql',
  online: boolean,
  value: string | undefined,
  variable: string,
): RuntimeRepositoryMode {
  if (!online || backend === 'sqlite') return 'sqlite'
  if (backend === 'mysql') return 'mysql'
  const mode = String(value ?? 'mysql').trim().toLowerCase()
  if (mode === 'sqlite' || mode === 'mysql' || mode === 'shadow') return mode
  throw new Error(`${variable} must be mysql, shadow, or sqlite`)
}

export type RuntimePageRow = {
  id: string
  title: string
  notes: string
  parentId: string | null
  dependsOn: string[]
  emoji: string
  createdAt: number
  updatedAt: number
}

export type RuntimeEditorContent = { body: string; version: number }

abstract class MysqlRuntimeRepository {
  protected readonly database: string

  constructor(
    protected readonly pool: Pool,
    database: string,
    protected readonly resolveWorkspaceId: () => string = currentRequestWorkspaceId,
  ) {
    if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database name: ${database}`)
    this.database = `\`${database}\``
  }

  protected workspaceId() {
    const id = this.resolveWorkspaceId().trim()
    if (!id) throw new Error('MySQL runtime repository requires a workspace')
    return id
  }

  protected optionalWorkspaceId() {
    return this.resolveWorkspaceId().trim()
  }
}

export const FILE_SYSTEM_METADATA_TABLES = [
  'facets',
  'facet_stamps',
  'facet_record_values',
  'record_meta',
  'record_banners',
  'banner_gallery',
  'saved_views',
  'shares',
  'attachments',
  'content_refs',
  'block_refs',
  'page_block_index',
  'page_block_cover',
  'page_block_index_meta',
] as const

export type FileSystemMetadataTable = (typeof FILE_SYSTEM_METADATA_TABLES)[number]

const FILE_SYSTEM_METADATA_KEYS: Record<FileSystemMetadataTable, readonly string[]> = {
  facets: ['id'],
  facet_stamps: ['facet_id', 'collection', 'record_id'],
  facet_record_values: ['collection', 'record_id'],
  record_meta: ['collection', 'record_id'],
  record_banners: ['collection', 'record_id'],
  banner_gallery: ['id'],
  saved_views: ['collection', 'view_id'],
  shares: ['token'],
  attachments: ['name'],
  content_refs: ['collection', 'record_id', 'name', 'source'],
  block_refs: ['collection', 'record_id', 'block_id', 'name', 'source'],
  page_block_index: ['collection', 'page_id', 'block_id'],
  page_block_cover: ['collection', 'page_id'],
  page_block_index_meta: ['key'],
}

const FILE_SYSTEM_METADATA_COLUMNS: Record<FileSystemMetadataTable, readonly string[]> = {
  // Facet notes are authoritative in editor_content, never in this legacy column.
  facets: ['id', 'label', 'fields_json', 'created_at', 'updated_at'],
  facet_stamps: ['facet_id', 'collection', 'record_id', 'title'],
  facet_record_values: ['collection', 'record_id', 'facet_json'],
  record_meta: ['collection', 'record_id', 'emoji', 'tags_json', 'created_by_json', 'updated_by_json', 'deleted_at'],
  record_banners: ['collection', 'record_id', 'kind', 'html'],
  banner_gallery: ['id', 'kind', 'style', 'title', 'html', 'created_at'],
  saved_views: ['collection', 'view_id', 'payload_json', 'updated_at'],
  shares: [
    'token', 'kind', 'collection', 'view_id', 'record_id', 'password_salt',
    'password_hash', 'share_plugins', 'allow_copy', 'created_at', 'updated_at',
  ],
  attachments: ['name', 'etag', 'mime', 'bytes', 'kind', 'storage', 'created_at'],
  content_refs: ['collection', 'record_id', 'name', 'source'],
  block_refs: ['collection', 'record_id', 'block_id', 'name', 'source'],
  page_block_index: [
    'collection', 'page_id', 'block_id', 'kind', 'plugin', 'title',
    'page_title', 'data_json', 'page_created_at', 'page_updated_at',
  ],
  page_block_cover: ['collection', 'page_id', 'page_updated_at'],
  page_block_index_meta: ['key', 'value'],
}

function safeColumn(value: string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error(`unsafe MySQL column: ${value}`)
  return `\`${value}\``
}

function checkedColumns(table: FileSystemMetadataTable, values: Record<string, unknown>) {
  const allowed = new Set(FILE_SYSTEM_METADATA_COLUMNS[table])
  const columns = Object.keys(values)
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${table} has no metadata column ${column}`)
  }
  return columns
}

/**
 * Workspace-scoped repository for File System metadata.
 *
 * Callers own higher-level transactions; every primitive is async and every
 * predicate is automatically tenant-scoped. This repository deliberately does
 * not expose an unscoped query escape hatch.
 */
export class MysqlFileSystemMetadataRepository extends MysqlRuntimeRepository {
  async list<T extends Record<string, unknown> = Record<string, unknown>>(
    table: FileSystemMetadataTable,
    where: Record<string, unknown> = {},
  ): Promise<T[]> {
    const clauses = ['workspace_id = ?']
    const params: unknown[] = [this.workspaceId()]
    checkedColumns(table, where)
    for (const [column, value] of Object.entries(where)) {
      clauses.push(`${safeColumn(column)} = ?`)
      params.push(value)
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.database}.${safeColumn(table)}
       WHERE ${clauses.join(' AND ')}`,
      params,
    )
    return rows as T[]
  }

  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    table: FileSystemMetadataTable,
    key: Record<string, unknown>,
  ): Promise<T | null> {
    const rows = await this.list<T>(table, key)
    return rows[0] ?? null
  }

  /** Share tokens are bearer capabilities, so public resolution has no workspace context. */
  async getShareByToken<T extends Record<string, unknown> = Record<string, unknown>>(
    token: string,
  ): Promise<T | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.database}.shares WHERE token = ? LIMIT 1`,
      [token],
    )
    return (rows[0] as T | undefined) ?? null
  }

  async deleteShareByToken(token: string) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM ${this.database}.shares WHERE token = ?`,
      [token],
    )
    return result.affectedRows
  }

  async upsert(table: FileSystemMetadataTable, row: Record<string, unknown>) {
    const columns = checkedColumns(table, row)
    if (!columns.length) throw new Error(`cannot upsert empty ${table} row`)
    const keys = FILE_SYSTEM_METADATA_KEYS[table]
    for (const key of keys) {
      if (!(key in row)) throw new Error(`${table} requires key ${key}`)
    }
    const updates = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${safeColumn(column)} = VALUES(${safeColumn(column)})`)
    const updateSql = updates.length
      ? updates.join(', ')
      : `${safeColumn(keys[0]!)} = ${safeColumn(keys[0]!)}`
    await this.pool.query(
      `INSERT INTO ${this.database}.${safeColumn(table)}
       (workspace_id, ${columns.map(safeColumn).join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${updateSql}`,
      [this.workspaceId(), ...columns.map((column) => row[column])],
    )
  }

  async delete(table: FileSystemMetadataTable, where: Record<string, unknown>) {
    if (!Object.keys(where).length) throw new Error(`refusing unqualified delete from ${table}`)
    checkedColumns(table, where)
    const clauses = ['workspace_id = ?']
    const params: unknown[] = [this.workspaceId()]
    for (const [column, value] of Object.entries(where)) {
      clauses.push(`${safeColumn(column)} = ?`)
      params.push(value)
    }
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM ${this.database}.${safeColumn(table)}
       WHERE ${clauses.join(' AND ')}`,
      params,
    )
    return result.affectedRows
  }

  async replaceTable(table: FileSystemMetadataTable, rows: Array<Record<string, unknown>>) {
    return this.transaction(async (tx) => {
      await tx.clear(table)
      for (const row of rows) await tx.upsert(table, row)
    })
  }

  async transaction<T>(run: (repository: MysqlFileSystemMetadataTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const repository = new MysqlFileSystemMetadataTransaction(
        connection,
        this.database,
        this.workspaceId(),
      )
      const result = await run(repository)
      await connection.commit()
      return result
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
}

export class MysqlFileSystemMetadataTransaction {
  constructor(
    private readonly connection: PoolConnection,
    private readonly database: string,
    private readonly workspaceId: string,
  ) {}

  async upsert(table: FileSystemMetadataTable, row: Record<string, unknown>) {
    const columns = checkedColumns(table, row)
    if (!columns.length) throw new Error(`cannot upsert empty ${table} row`)
    const keys = FILE_SYSTEM_METADATA_KEYS[table]
    for (const key of keys) {
      if (!(key in row)) throw new Error(`${table} requires key ${key}`)
    }
    const updates = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${safeColumn(column)} = VALUES(${safeColumn(column)})`)
    await this.connection.query(
      `INSERT INTO ${this.database}.${safeColumn(table)}
       (workspace_id, ${columns.map(safeColumn).join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${updates.length ? updates.join(', ') : `${safeColumn(keys[0]!)} = ${safeColumn(keys[0]!)}`}`,
      [this.workspaceId, ...columns.map((column) => row[column])],
    )
  }

  async delete(table: FileSystemMetadataTable, where: Record<string, unknown>) {
    if (!Object.keys(where).length) throw new Error(`refusing unqualified delete from ${table}`)
    const columns = checkedColumns(table, where)
    await this.connection.query(
      `DELETE FROM ${this.database}.${safeColumn(table)}
       WHERE workspace_id = ? AND ${columns.map((column) => `${safeColumn(column)} = ?`).join(' AND ')}`,
      [this.workspaceId, ...columns.map((column) => where[column])],
    )
  }

  async clear(table: FileSystemMetadataTable) {
    await this.connection.query(
      `DELETE FROM ${this.database}.${safeColumn(table)} WHERE workspace_id = ?`,
      [this.workspaceId],
    )
  }
}

function jsonList(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function pageRow(row: Record<string, unknown>): RuntimePageRow {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    notes: String(row.body ?? ''),
    parentId: row.parent_id == null || row.parent_id === '' ? null : String(row.parent_id),
    dependsOn: jsonList(row.depends_on_json),
    emoji: String(row.emoji ?? ''),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }
}

export class MysqlPageRepository extends MysqlRuntimeRepository {
  async list(ids?: string[]): Promise<RuntimePageRow[]> {
    const workspaceId = this.workspaceId()
    const params: unknown[] = [workspaceId]
    let where = 'workspace_id = ?'
    if (ids) {
      if (!ids.length) return []
      where += ` AND id IN (${ids.map(() => '?').join(', ')})`
      params.push(...ids)
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, title, parent_id, depends_on_json, emoji, created_at, updated_at
       FROM ${this.database}.pages WHERE ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    )
    return rows.map(pageRow)
  }

  async get(id: string): Promise<RuntimePageRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.title, p.parent_id, p.depends_on_json, p.emoji,
              p.created_at, p.updated_at, c.body
       FROM ${this.database}.pages p
       LEFT JOIN ${this.database}.editor_content c
         ON c.workspace_id = p.workspace_id
        AND c.collection = '/pages'
        AND c.record_id = p.id
       WHERE p.workspace_id = ? AND p.id = ?`,
      [this.workspaceId(), id],
    )
    return rows[0] ? pageRow(rows[0]) : null
  }

  async create(row: RuntimePageRow) {
    await this.pool.query(
      `INSERT INTO ${this.database}.pages
       (workspace_id, id, title, parent_id, depends_on_json, emoji, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.workspaceId(), row.id, row.title, row.parentId, JSON.stringify(row.dependsOn), row.emoji, row.createdAt, row.updatedAt],
    )
    return this.get(row.id)
  }

  async update(row: RuntimePageRow) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.database}.pages SET title = ?, parent_id = ?, depends_on_json = ?,
       emoji = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
      [row.title, row.parentId, JSON.stringify(row.dependsOn), row.emoji, row.updatedAt, this.workspaceId(), row.id],
    )
    if (!result.affectedRows) throw new Error(`unknown page: ${row.id}`)
    return this.get(row.id)
  }

  async delete(id: string) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM ${this.database}.pages WHERE workspace_id = ? AND id = ?`,
      [this.workspaceId(), id],
    )
    if (!result.affectedRows) throw new Error(`unknown page: ${id}`)
  }

  async createWithContent(row: RuntimePageRow) {
    return this.writeWithContent(row, false)
  }

  async updateWithContent(row: RuntimePageRow) {
    return this.writeWithContent(row, true)
  }

  async deleteWithContent(id: string) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = this.workspaceId()
      await connection.query(
        `DELETE FROM ${this.database}.editor_content
         WHERE workspace_id = ? AND collection = '/pages' AND record_id = ?`,
        [workspaceId, id],
      )
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.database}.pages WHERE workspace_id = ? AND id = ?`,
        [workspaceId, id],
      )
      if (!result.affectedRows) throw new Error(`unknown page: ${id}`)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async writeWithContent(row: RuntimePageRow, update: boolean) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = this.workspaceId()
      if (update) {
        const [result] = await connection.query<ResultSetHeader>(
          `UPDATE ${this.database}.pages SET title = ?, parent_id = ?, depends_on_json = ?,
           emoji = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
          [row.title, row.parentId, JSON.stringify(row.dependsOn), row.emoji, row.updatedAt, workspaceId, row.id],
        )
        if (!result.affectedRows) throw new Error(`unknown page: ${row.id}`)
      } else {
        await connection.query(
          `INSERT INTO ${this.database}.pages
           (workspace_id, id, title, parent_id, depends_on_json, emoji, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [workspaceId, row.id, row.title, row.parentId, JSON.stringify(row.dependsOn), row.emoji, row.createdAt, row.updatedAt],
        )
      }
      await connection.query(
        `INSERT INTO ${this.database}.editor_content
         (workspace_id, collection, record_id, body, updated_at, version)
         VALUES (?, '/pages', ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE version = IF(body = VALUES(body), version, version + 1),
         body = VALUES(body), updated_at = VALUES(updated_at)`,
        [workspaceId, row.id, row.notes, row.updatedAt],
      )
      await connection.commit()
      return this.get(row.id)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

}

export class MysqlEditorContentRepository extends MysqlRuntimeRepository {
  async workspaceIds(): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT workspace_id FROM ${this.database}.editor_content WHERE workspace_id <> ''`,
    )
    return rows.map((row) => String(row.workspace_id)).filter(Boolean)
  }

  async list(collection: string): Promise<Array<{ record_id: string; body: string; updated_at: number; version: number }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT record_id, body, updated_at, version FROM ${this.database}.editor_content
       WHERE workspace_id = ? AND collection = ?`,
      [this.workspaceId(), collection],
    )
    return rows.map((row) => ({
      record_id: String(row.record_id),
      body: String(row.body ?? ''),
      updated_at: Number(row.updated_at) || 0,
      version: Math.max(1, Number(row.version) || 1),
    }))
  }

  async read(collection: string, recordId: string): Promise<RuntimeEditorContent> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT body, version FROM ${this.database}.editor_content
       WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId(), collection, recordId],
    )
    const row = rows[0]
    return row
      ? { body: String(row.body ?? ''), version: Math.max(1, Number(row.version) || 1) }
      : { body: '', version: 0 }
  }

  async write(
    collection: string,
    recordId: string,
    body: string,
    expectedVersion?: number,
  ): Promise<RuntimeEditorContent> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = this.workspaceId()
      const current = await this.readForUpdate(connection, workspaceId, collection, recordId)
      if (expectedVersion != null && current.version !== expectedVersion) {
        const error = new Error(`正文版本冲突：期望 v${expectedVersion}，当前为 v${current.version}`) as Error & {
          code: string
          expectedVersion: number
          actualVersion: number
        }
        error.name = 'EditorContentConflictError'
        error.code = 'EDITOR_CONTENT_CONFLICT'
        error.expectedVersion = expectedVersion
        error.actualVersion = current.version
        throw error
      }
      const now = Date.now()
      if (current.version === 0) {
        await connection.query(
          `INSERT INTO ${this.database}.editor_content
           (workspace_id, collection, record_id, body, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [workspaceId, collection, recordId, String(body ?? ''), now],
        )
      } else if (current.body === String(body ?? '')) {
        await connection.query(
          `UPDATE ${this.database}.editor_content SET updated_at = ?
           WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
          [now, workspaceId, collection, recordId],
        )
      } else {
        await connection.query(
          `UPDATE ${this.database}.editor_content SET body = ?, updated_at = ?, version = version + 1
           WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
          [String(body ?? ''), now, workspaceId, collection, recordId],
        )
      }
      const written = await this.readForUpdate(connection, workspaceId, collection, recordId)
      await connection.commit()
      return written
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async delete(collection: string, recordId: string) {
    await this.pool.query(
      `DELETE FROM ${this.database}.editor_content
       WHERE workspace_id = ? AND collection = ? AND record_id = ?`,
      [this.workspaceId(), collection, recordId],
    )
  }

  private async readForUpdate(
    connection: PoolConnection,
    workspaceId: string,
    collection: string,
    recordId: string,
  ) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT body, version FROM ${this.database}.editor_content
       WHERE workspace_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
      [workspaceId, collection, recordId],
    )
    const row = rows[0]
    return row
      ? { body: String(row.body ?? ''), version: Math.max(1, Number(row.version) || 1) }
      : { body: '', version: 0 }
  }
}

export type MysqlTaskListFilter = {
  status?: string
  q?: string
  creatorSessionId?: string
}

export class MysqlTaskRepository extends MysqlRuntimeRepository {
  async workspaceIds() {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT workspace_id FROM ${this.database}.tasks WHERE workspace_id <> ''`,
    )
    return rows.map((row) => String(row.workspace_id)).filter(Boolean)
  }

  async list(filter: MysqlTaskListFilter = {}, projected = false) {
    const clauses = ['t.workspace_id = ?']
    const params: unknown[] = [this.workspaceId()]
    if (filter.status) {
      clauses.push('t.status = ?')
      params.push(filter.status)
    }
    if (filter.q?.trim()) {
      const like = `%${filter.q.trim()}%`
      clauses.push(
        `(t.title LIKE ? OR COALESCE(c.body, '') LIKE ? OR t.notes LIKE ?
          OR t.assignee LIKE ? OR t.creator_json LIKE ? OR t.assignee_json LIKE ?)`,
      )
      params.push(like, like, like, like, like, like)
    }
    if (filter.creatorSessionId?.trim()) {
      clauses.push('t.creator_json LIKE ?')
      params.push(`%${filter.creatorSessionId.trim()}%`)
    }
    const columns = projected
      ? `t.id, t.title, t.status, t.priority, t.difficulty, t.due_at, t.sort,
         t.created_at, t.updated_at, t.creator_json, t.assignee_json, t.assigned_at,
         t.project, t.tags_json, t.parent_id, t.depends_on, t.depth, t.emoji, t.reports_json`
      : 't.*'
    const join = filter.q?.trim()
      ? `LEFT JOIN ${this.database}.editor_content c
           ON c.workspace_id = t.workspace_id AND c.collection = '/tasks' AND c.record_id = t.id`
      : ''
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT ${columns} FROM ${this.database}.tasks t ${join}
       WHERE ${clauses.join(' AND ')}
       ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
       t.sort DESC, t.updated_at DESC`,
      params,
    )
    return rows as Array<Record<string, unknown>>
  }

  async get(id: string) {
    const workspaceId = await this.workspaceForRecord(id)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${this.database}.tasks WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id],
    )
    return rows[0] as Record<string, unknown> | undefined
  }

  async maxSort(status: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(sort), 0) AS m FROM ${this.database}.tasks
       WHERE workspace_id = ? AND status = ?`,
      [this.workspaceId(), status],
    )
    return Number(rows[0]?.m ?? 0)
  }

  async insert(values: Record<string, unknown>) {
    const columns = Object.keys(values)
    await this.pool.query(
      `INSERT INTO ${this.database}.tasks
       (workspace_id, ${columns.map((key) => `\`${key}\``).join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})`,
      [this.workspaceId(), ...columns.map((key) => values[key])],
    )
  }

  async insertWithContent(values: Record<string, unknown>, body: string) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = this.workspaceId()
      const columns = Object.keys(values)
      await connection.query(
        `INSERT INTO ${this.database}.tasks
         (workspace_id, ${columns.map((key) => `\`${key}\``).join(', ')})
         VALUES (?, ${columns.map(() => '?').join(', ')})`,
        [workspaceId, ...columns.map((key) => values[key])],
      )
      await this.writeTaskContent(connection, workspaceId, String(values.id), body)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async update(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values)
    if (!columns.length) return
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE ${this.database}.tasks SET ${columns.map((key) => `\`${key}\` = ?`).join(', ')}
       WHERE workspace_id = ? AND id = ?`,
      [...columns.map((key) => values[key]), await this.workspaceForRecord(id), id],
    )
    if (!result.affectedRows) throw new Error('unknown task')
  }

  async updateWithContent(id: string, values: Record<string, unknown>, body: string) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = await this.workspaceForRecord(id, connection)
      const columns = Object.keys(values)
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE ${this.database}.tasks SET ${columns.map((key) => `\`${key}\` = ?`).join(', ')}
         WHERE workspace_id = ? AND id = ?`,
        [...columns.map((key) => values[key]), workspaceId, id],
      )
      if (!result.affectedRows) throw new Error('unknown task')
      await this.writeTaskContent(connection, workspaceId, id, body)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async delete(id: string) {
    const workspaceId = await this.workspaceForRecord(id)
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM ${this.database}.tasks WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id],
    )
    return result.affectedRows > 0
  }

  async deleteWithContent(id: string) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const workspaceId = await this.workspaceForRecord(id, connection)
      await connection.query(
        `DELETE FROM ${this.database}.editor_content
         WHERE workspace_id = ? AND collection = '/tasks' AND record_id = ?`,
        [workspaceId, id],
      )
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.database}.tasks WHERE workspace_id = ? AND id = ?`,
        [workspaceId, id],
      )
      await connection.commit()
      return result.affectedRows > 0
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async writeTaskContent(
    connection: PoolConnection,
    workspaceId: string,
    id: string,
    body: string,
  ) {
    await connection.query(
      `INSERT INTO ${this.database}.editor_content
       (workspace_id, collection, record_id, body, updated_at, version)
       VALUES (?, '/tasks', ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE version = IF(body = VALUES(body), version, version + 1),
       body = VALUES(body), updated_at = VALUES(updated_at)`,
      [workspaceId, id, body, Date.now()],
    )
  }

  private async workspaceForRecord(
    id: string,
    connection: Pick<PoolConnection, 'query'> | Pick<Pool, 'query'> = this.pool,
  ) {
    const scoped = this.optionalWorkspaceId()
    if (scoped) return scoped
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT workspace_id FROM ${this.database}.tasks WHERE id = ? LIMIT 2`,
      [id],
    )
    if (rows.length !== 1) throw new Error(`Task workspace is ambiguous or missing: ${id}`)
    return String(rows[0]!.workspace_id)
  }
}
