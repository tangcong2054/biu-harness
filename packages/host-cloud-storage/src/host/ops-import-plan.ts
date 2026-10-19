import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const OPS_TABLES = {
  ops_accounts: 'updated_at',
  ops_workspaces: 'updated_at',
  ops_usage_daily: 'updated_at',
  ops_devices: 'updated_at',
  ops_sync_health: 'updated_at',
  ops_security_events: 'created_at',
  ops_audit_logs: 'created_at',
} as const

export type OpsSource = { name: string; path: string }

export type OpsMergePlan = {
  sources: Array<{ name: string; path: string }>
  tables: Array<{
    table: keyof typeof OPS_TABLES
    sourceCounts: Record<string, number>
    uniqueRows: number
    duplicateIds: number
    conflicts: number
    selectedBySource: Record<string, number>
  }>
}

export type OpsTable = keyof typeof OPS_TABLES
export type OpsRow = Record<string, unknown> & { id: string }
export type OpsMergeResult = {
  plan: OpsMergePlan
  rows: Record<OpsTable, OpsRow[]>
}

function rowText(row: OpsRow) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))),
  )
}

/** Builds a deterministic union plan and never writes either source. */
export function planOperationsMerge(sources: readonly OpsSource[]): OpsMergePlan {
  return mergeOperationsSources(sources).plan
}

/** Returns the same deterministic selection for an explicit importer. */
export function mergeOperationsSources(sources: readonly OpsSource[]): OpsMergeResult {
  if (sources.length < 2) throw new Error('at least two Operations sources are required')
  const opened = sources.map((source) => ({
    ...source,
    path: resolve(source.path),
    db: new DatabaseSync(resolve(source.path), { readOnly: true }),
  }))
  try {
    const mergedRows: Partial<Record<OpsTable, OpsRow[]>> = {}
    const tables = Object.entries(OPS_TABLES).map(([rawTable, clock]) => {
      const table = rawTable as OpsTable
      const sourceCounts: Record<string, number> = {}
      const selectedBySource: Record<string, number> = {}
      const merged = new Map<string, { row: OpsRow; source: string }>()
      let duplicateIds = 0
      let conflicts = 0

      for (const source of opened) {
        const rows = source.db.prepare(`SELECT * FROM "${table}"`).all() as OpsRow[]
        sourceCounts[source.name] = rows.length
        for (const row of rows) {
          const id = String(row.id ?? '')
          if (!id) throw new Error(`${table} contains an empty id in ${source.name}`)
          const current = merged.get(id)
          if (!current) {
            merged.set(id, { row, source: source.name })
            continue
          }
          duplicateIds += 1
          const differs = rowText(current.row) !== rowText(row)
          if (differs) conflicts += 1
          const currentClock = Number(current.row[clock]) || 0
          const nextClock = Number(row[clock]) || 0
          if (nextClock > currentClock) merged.set(id, { row, source: source.name })
        }
      }
      for (const { source } of merged.values()) {
        selectedBySource[source] = (selectedBySource[source] ?? 0) + 1
      }
      mergedRows[table] = [...merged.values()].map(({ row }) => row)
      return { table, sourceCounts, uniqueRows: merged.size, duplicateIds, conflicts, selectedBySource }
    })
    return {
      plan: {
        sources: opened.map(({ name, path }) => ({ name, path })),
        tables,
      },
      rows: mergedRows as Record<OpsTable, OpsRow[]>,
    }
  } finally {
    for (const source of opened) source.db.close()
  }
}
