import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const COLLECTION_TABLES = {
  '/pages': 'pages',
  '/tasks': 'tasks',
  '/sessions': 'sessions',
  '/facets': 'facets',
  '/plugins': 'plugin_packages',
} as const

const WORKSPACE_COLLECTIONS = new Set(['/pages', '/tasks', '/sessions', '/facets', '/skills'])

export type TenancyAudit = {
  source: string
  collections: Array<{
    collection: string
    records: number
    owned: number
    ownerless: number
    ownerlessSample: string[]
  }>
  editorContent: {
    records: number
    owned: number
    ownerless: number
    ownerlessSample: string[]
  }
  canUseWorkspacePrimaryKeys: boolean
}

export type OwnerlessRecord = { collection: string; recordId: string }

export function collectOwnerlessRecords(path: string): OwnerlessRecord[] {
  const source = resolve(path)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    const owners = db
      .prepare('SELECT collection, record_id FROM record_owners')
      .all() as Array<{ collection: string; record_id: string }>
    const owned = new Set(owners.map((row) => `${row.collection}\t${row.record_id}`))
    const missing = new Map<string, OwnerlessRecord>()
    for (const [collection, table] of Object.entries(COLLECTION_TABLES)) {
      if (!WORKSPACE_COLLECTIONS.has(collection)) continue
      const rows = db.prepare(`SELECT DISTINCT id FROM "${table}"`).all() as Array<{ id: string }>
      for (const row of rows) {
        const key = `${collection}\t${row.id}`
        if (!owned.has(key)) missing.set(key, { collection, recordId: String(row.id) })
      }
    }
    const content = db
      .prepare('SELECT collection, record_id FROM editor_content')
      .all() as Array<{ collection: string; record_id: string }>
    for (const row of content) {
      if (!WORKSPACE_COLLECTIONS.has(row.collection)) continue
      const key = `${row.collection}\t${row.record_id}`
      if (!owned.has(key)) {
        missing.set(key, { collection: row.collection, recordId: row.record_id })
      }
    }
    return [...missing.values()].sort((left, right) =>
      `${left.collection}\t${left.recordId}`.localeCompare(`${right.collection}\t${right.recordId}`),
    )
  } finally {
    db.close()
  }
}

/** Read-only preflight for adding workspace_id to MySQL business tables. */
export function auditSqliteTenancy(path: string): TenancyAudit {
  const source = resolve(path)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    const owners = db
      .prepare('SELECT workspace_id, collection, record_id FROM record_owners')
      .all() as Array<{ workspace_id: string; collection: string; record_id: string }>
    const ownerKeys = new Set(
      owners.map((row) => `${row.collection}\t${row.record_id}`),
    )
    const collections = Object.entries(COLLECTION_TABLES).map(([collection, table]) => {
      const idColumn = table === 'plugin_packages' ? 'id' : 'id'
      const rows = db.prepare(`SELECT DISTINCT "${idColumn}" AS id FROM "${table}"`).all() as Array<{
        id: string
      }>
      const ownerless = rows
        .map((row) => String(row.id))
        .filter((id) => !ownerKeys.has(`${collection}\t${id}`))
      return {
        collection,
        records: rows.length,
        owned: rows.length - ownerless.length,
        ownerless: ownerless.length,
        ownerlessSample: ownerless.slice(0, 10),
      }
    })
    const contentRows = db
      .prepare('SELECT collection, record_id FROM editor_content')
      .all() as Array<{ collection: string; record_id: string }>
    const ownerlessContent = contentRows.filter(
      (row) => !ownerKeys.has(`${row.collection}\t${row.record_id}`),
    )
    return {
      source,
      collections,
      editorContent: {
        records: contentRows.length,
        owned: contentRows.length - ownerlessContent.length,
        ownerless: ownerlessContent.length,
        ownerlessSample: ownerlessContent
          .slice(0, 10)
          .map((row) => `${row.collection}/${row.record_id}`),
      },
      canUseWorkspacePrimaryKeys:
        collections
          .filter((item) => WORKSPACE_COLLECTIONS.has(item.collection))
          .every((item) => item.ownerless === 0)
        && ownerlessContent.filter((item) => WORKSPACE_COLLECTIONS.has(item.collection)).length === 0,
    }
  } finally {
    db.close()
  }
}
