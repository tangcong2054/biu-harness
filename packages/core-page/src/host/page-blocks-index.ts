import type { DbRecord } from '@biu/type-file-system'
import { recordBuiltinValues } from '@biu/type-file-system'
import { listPageBlockFences, pageBlockData, pageBlockRecordId, parsePageBlockRecordId, uniquifyPageBlockMarkdown, defaultPageBlockTitle } from '@biu/core-editor/host'
import { assetNamesFromBlock, assetNamesFromHtml } from '@biu/type-file-system'
import {
  currentRequestWorkspaceId,
  openAndMigrateBiu,
  readEditorContent,
  replacePageBlockRefs,
  runWithRequestWorkspace,
  writeEditorContent,
} from '@biu/host-plugin-loader/data-dir'
import {
  SqliteMetadataRuntime,
  type MetadataRepository,
  type MetadataRuntimeMode,
} from '@biu/host-plugin-loader/metadata-runtime'
import type { PagesStore, PageRow } from './store.ts'

export const PAGE_BLOCK_HOT_WINDOW_MS = 5 * 60 * 1000
export const PAGE_BLOCK_HOT_LIMIT = 24
export const PAGE_BLOCK_WARM_LIMIT = 8
export const PAGE_BLOCK_TICK_MS = 15_000
export const EDITOR_BLOCK_COLLECTIONS = ['/pages', '/tasks', '/facets', '/skills', '/plugins'] as const

type Cover = { collection: string; page_id: string; page_updated_at: number }
type IndexRow = {
  collection: string
  page_id: string
  block_id: string
  kind: string
  plugin: string
  title: string
  page_title: string
  data_json: string
  page_created_at: number
  page_updated_at: number
}

function blockTitle(pageName: string, kindName: string, data: Record<string, unknown>) {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim()
  return defaultPageBlockTitle(pageName, kindName)
}

function assetNamesFromFence(kind: string, plugin: string, data: Record<string, unknown>, body: string) {
  const names = new Set(assetNamesFromBlock(kind, plugin, data))
  if (kind === 'html' || kind === 'htmlframe') {
    for (const name of assetNamesFromHtml(body)) names.add(name)
  }
  return names
}

function slimBlockIndexData(kind: string, plugin: string, data: Record<string, unknown>, blockId: string) {
  const bodyKeys = new Set(['html', 'script', 'code', 'source', 'body'])
  const attrs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (bodyKeys.has(key)) continue
    attrs[key] = value
  }
  return {
    blockId,
    kind,
    plugin,
    attrs,
    assets: [...assetNamesFromBlock(kind, plugin, data)].sort(),
  }
}

function toRecord(row: IndexRow): DbRecord {
  const collection = row.collection || '/pages'
  return {
    id: pageBlockRecordId(collection, row.page_id, row.block_id),
    title: row.title,
    collection,
    pageId: row.page_id,
    pageTitle: row.page_title || undefined,
    blockId: row.block_id,
    blockKind: row.kind,
    plugin: row.plugin,
    data: row.data_json,
    ...recordBuiltinValues({ createdAt: row.page_created_at, updatedAt: row.page_updated_at }),
  }
}

function coverKey(collection: string, pageId: string) {
  return `${collection}\0${pageId}`
}

function recordMeta(
  db: import('node:sqlite').DatabaseSync,
  collection: string,
  recordId: string,
): { title: string; createdAt: number } {
  try {
    if (collection === '/pages') {
      const row = db.prepare('SELECT title, created_at FROM pages WHERE id = ?').get(recordId) as
        | { title?: string; created_at?: number }
        | undefined
      return { title: String(row?.title ?? '').trim(), createdAt: Number(row?.created_at) || 0 }
    }
    if (collection === '/tasks') {
      const row = db.prepare('SELECT title, created_at FROM tasks WHERE id = ?').get(recordId) as
        | { title?: string; created_at?: number }
        | undefined
      return { title: String(row?.title ?? '').trim(), createdAt: Number(row?.created_at) || 0 }
    }
    if (collection === '/facets') {
      const row = db.prepare('SELECT label, created_at FROM facets WHERE id = ?').get(recordId) as
        | { label?: string; created_at?: number }
        | undefined
      return { title: String(row?.label ?? '').trim(), createdAt: Number(row?.created_at) || 0 }
    }
  } catch {
    /* table missing in tests */
  }
  return { title: '', createdAt: 0 }
}

export type PageBlocksIndexOptions = {
  hotWindowMs?: number
  hotLimit?: number
  warmLimit?: number
}

/** 倒排只扫脏记录：先最近窗口，再少量补旧的；每拍有上限。 */
export class PageBlocksIndex {
  private runtime: SqliteMetadataRuntime | null = null
  private runtimeDb: import('node:sqlite').DatabaseSync | null = null
  private editorRepository: {
    read(collection: string, recordId: string): Promise<{ body: string; version: number }>
    list(collection: string): Promise<Array<{ record_id: string; body: string; updated_at: number; version: number }>>
    workspaceIds(): Promise<string[]>
    write(collection: string, recordId: string, body: string): Promise<unknown>
  } | null = null

  constructor(
    private store: PagesStore,
    private opts: PageBlocksIndexOptions = {},
  ) {}

  configureRuntime(
    mode: MetadataRuntimeMode,
    repository: MetadataRepository | null,
    editorRepository: PageBlocksIndex['editorRepository'],
    onShadowError?: (error: unknown) => void,
    sqliteDb?: import('node:sqlite').DatabaseSync,
  ) {
    if (mode !== 'sqlite') {
      this.runtimeDb = mode === 'mysql'
        ? openAndMigrateBiu(':memory:', { foreignKeys: false })
        : sqliteDb ?? null
    }
    this.editorRepository = editorRepository
    this.runtime = new SqliteMetadataRuntime(
      mode,
      repository,
      () => {
        if (!this.runtimeDb) throw new Error('page block metadata database is not ready')
        return this.runtimeDb
      },
      ['page_block_index', 'page_block_cover', 'page_block_index_meta', 'block_refs'],
      onShadowError,
    )
  }

  private async prepare() {
    await this.runtime?.prepare()
  }

  private async flush() {
    await this.runtime?.flush()
  }

  private hotWindowMs() {
    return this.opts.hotWindowMs ?? PAGE_BLOCK_HOT_WINDOW_MS
  }

  private hotLimit() {
    return this.opts.hotLimit ?? PAGE_BLOCK_HOT_LIMIT
  }

  private warmLimit() {
    return this.opts.warmLimit ?? PAGE_BLOCK_WARM_LIMIT
  }

  private async db() {
    return this.runtimeDb ?? this.store.sqlite()
  }

  lastRunAt() {
    return this.readMeta('last_run_at').then((raw) => Number(raw) || 0)
  }

  private async readMeta(key: string) {
    await this.prepare()
    const db = await this.db()
    const row = db.prepare('SELECT value FROM page_block_index_meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? ''
  }

  private async writeMeta(key: string, value: string) {
    await this.prepare()
    const db = await this.db()
    db.prepare('INSERT INTO page_block_index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
    this.runtime?.changed('page_block_index_meta')
    await this.flush()
  }

  async reindexPage(page: PageRow) {
    await this.reindexRecord('/pages', page.id, {
      title: page.title,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
  }

  async reindexRecord(
    collection: string,
    recordId: string,
    meta?: { body?: string; title?: string; createdAt?: number; updatedAt?: number },
  ) {
    await this.prepare()
    const db = await this.db()
    let body = meta?.body
      ?? (this.runtime?.mode === 'mysql' && this.editorRepository
        ? (await this.editorRepository.read(collection, recordId)).body
        : readEditorContent(db, collection, recordId))
    const unique = uniquifyPageBlockMarkdown(body)
    if (unique.changed) {
      body = unique.markdown
      writeEditorContent(db, collection, recordId, body, { transaction: false })
      if (this.runtime?.mode === 'mysql' && this.editorRepository) {
        await this.editorRepository.write(collection, recordId, body)
      }
    }
    const stamp = db
      .prepare('SELECT updated_at FROM editor_content WHERE collection = ? AND record_id = ?')
      .get(collection, recordId) as { updated_at?: number } | undefined
    const names = recordMeta(db, collection, recordId)
    const pageTitle = String(meta?.title ?? names.title ?? '').trim()
    const createdAt = meta?.createdAt ?? names.createdAt
    const updatedAt = Number(stamp?.updated_at) || meta?.updatedAt || Date.now()
    const fences = listPageBlockFences(body).filter((item) => item.id)
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM page_block_index WHERE collection = ? AND page_id = ?').run(collection, recordId)
      const insert = db.prepare(`
        INSERT INTO page_block_index(
          collection, page_id, block_id, kind, plugin, title, page_title, data_json, page_created_at, page_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const seen = new Set<string>()
      const blockRefs: Array<{ blockId: string; names: Iterable<string> }> = []
      for (const fence of fences) {
        if (seen.has(fence.id)) continue
        seen.add(fence.id)
        const data = pageBlockData(fence)
        insert.run(
          collection,
          recordId,
          fence.id,
          fence.kind,
          fence.plugin,
          blockTitle(pageTitle, fence.kind, data),
          pageTitle,
          JSON.stringify(slimBlockIndexData(fence.kind, fence.plugin, data, fence.id)),
          createdAt,
          updatedAt,
        )
        blockRefs.push({
          blockId: fence.id,
          names: assetNamesFromFence(fence.kind, fence.plugin, data, fence.body),
        })
      }
      db.prepare(
        `INSERT INTO page_block_cover(collection, page_id, page_updated_at) VALUES(?, ?, ?)
         ON CONFLICT(collection, page_id) DO UPDATE SET page_updated_at=excluded.page_updated_at`,
      ).run(collection, recordId, updatedAt)
      replacePageBlockRefs(db, collection, recordId, blockRefs)
      db.exec('COMMIT')
      this.runtime?.changed('page_block_index', 'page_block_cover', 'block_refs')
      await this.flush()
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async dropPage(pageId: string) {
    await this.dropRecord('/pages', pageId)
  }

  async dropRecord(collection: string, recordId: string) {
    await this.prepare()
    const db = await this.db()
    db.prepare('DELETE FROM page_block_index WHERE collection = ? AND page_id = ?').run(collection, recordId)
    db.prepare('DELETE FROM page_block_cover WHERE collection = ? AND page_id = ?').run(collection, recordId)
    try {
      db.prepare(`DELETE FROM block_refs WHERE collection = ? AND record_id = ?`).run(collection, recordId)
    } catch {
      /* table may not exist yet */
    }
    this.runtime?.changed('page_block_index', 'page_block_cover', 'block_refs')
    await this.flush()
  }

  async sync(now = Date.now()) {
    if (this.runtime?.mode === 'mysql' && !currentRequestWorkspaceId() && this.editorRepository) {
      let scanned = 0
      let dirty = 0
      for (const workspaceId of await this.editorRepository.workspaceIds()) {
        const result = await runWithRequestWorkspace(workspaceId, () => this.sync(now))
        scanned += result.scanned
        dirty += result.dirty
      }
      return { scanned, dirty, lastRunAt: now }
    }
    await this.prepare()
    const db = await this.db()
    if (this.runtime?.mode === 'mysql' && this.editorRepository) {
      db.prepare(`DELETE FROM editor_content WHERE collection IN (${EDITOR_BLOCK_COLLECTIONS.map(() => '?').join(',')})`)
        .run(...EDITOR_BLOCK_COLLECTIONS)
      const insert = db.prepare(
        `INSERT INTO editor_content(collection, record_id, body, updated_at, version) VALUES(?, ?, ?, ?, ?)`,
      )
      for (const collection of EDITOR_BLOCK_COLLECTIONS) {
        for (const row of await this.editorRepository.list(collection)) {
          insert.run(collection, row.record_id, row.body, row.updated_at, row.version)
        }
      }
    }
    const liveRows = db
      .prepare(
        `SELECT collection, record_id AS page_id, updated_at AS page_updated_at FROM editor_content
         WHERE collection IN (${EDITOR_BLOCK_COLLECTIONS.map(() => '?').join(',')})`,
      )
      .all(...EDITOR_BLOCK_COLLECTIONS) as Cover[]
    const live = new Set(liveRows.map((item) => coverKey(item.collection, item.page_id)))
    const covers = (db.prepare('SELECT collection, page_id, page_updated_at FROM page_block_cover').all() as Cover[])
    const coverAt = new Map(covers.map((item) => [coverKey(item.collection, item.page_id), item.page_updated_at]))
    for (const item of covers) {
      if (!live.has(coverKey(item.collection, item.page_id))) await this.dropRecord(item.collection, item.page_id)
    }
    const dirty = liveRows.filter((row) => (coverAt.get(coverKey(row.collection, row.page_id)) ?? -1) < row.page_updated_at)
    const hotCut = now - this.hotWindowMs()
    const hot = dirty
      .filter((row) => row.page_updated_at >= hotCut)
      .sort((a, b) => b.page_updated_at - a.page_updated_at || coverKey(a.collection, a.page_id).localeCompare(coverKey(b.collection, b.page_id)))
    const takeHot = hot.slice(0, this.hotLimit())
    const taken = new Set(takeHot.map((item) => coverKey(item.collection, item.page_id)))
    const warm = dirty
      .filter((row) => !taken.has(coverKey(row.collection, row.page_id)))
      .sort((a, b) => b.page_updated_at - a.page_updated_at || coverKey(a.collection, a.page_id).localeCompare(coverKey(b.collection, b.page_id)))
      .slice(0, this.warmLimit())
    const batch = [...takeHot, ...warm]
    for (const slim of batch) {
      try {
        await this.reindexRecord(slim.collection, slim.page_id, { updatedAt: slim.page_updated_at })
      } catch {
        /* 单条索引失败不拖垮 host */
      }
    }
    await this.writeMeta('last_run_at', String(now))
    await this.writeMeta('last_batch', String(batch.length))
    return { scanned: batch.length, dirty: dirty.length, lastRunAt: now }
  }

  async list() {
    await this.prepare()
    const db = await this.db()
    const rows = db.prepare('SELECT * FROM page_block_index ORDER BY collection, page_id, block_id').all() as IndexRow[]
    return rows.map(toRecord)
  }

  async get(id: string) {
    await this.prepare()
    const parsed = parsePageBlockRecordId(id)
    if (!parsed) return null
    const db = await this.db()
    const row = db
      .prepare('SELECT * FROM page_block_index WHERE collection = ? AND page_id = ? AND block_id = ?')
      .get(parsed.collection, parsed.pageId, parsed.blockId) as IndexRow | undefined
    return row ? toRecord(row) : null
  }
}
