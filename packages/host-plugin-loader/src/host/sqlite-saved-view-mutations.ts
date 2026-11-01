import {
  applySavedViewMutation,
  captureSavedViewMutations,
  savedViewMutationError,
  type SavedViewMutation,
  type SavedViewMutationResult,
} from './saved-view-mutations.ts'

type DatabaseSync = import('node:sqlite').DatabaseSync

export function mutateSqliteSavedViews(
  db: DatabaseSync,
  workspaceId: string,
  accountId: string,
  input: readonly SavedViewMutation[],
): SavedViewMutationResult[] {
  const mutations = captureSavedViewMutations(input)
  if (!mutations.length) return []
  const read = db.prepare('SELECT payload_json FROM saved_views WHERE workspace_id = ? AND collection = ? AND view_id = ?')
  const write = db.prepare(`INSERT INTO saved_views (workspace_id, collection, view_id, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, collection, view_id)
    DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const results: SavedViewMutationResult[] = []
    for (const mutation of mutations) {
      const row = read.get(workspaceId, mutation.collection, mutation.id) as { payload_json: string } | undefined
      let current: unknown = null
      if (row) {
        try {
          current = JSON.parse(row.payload_json) ?? undefined
        } catch {
          throw savedViewMutationError('SAVED_VIEW_CONFLICT')
        }
      }
      const now = Date.now()
      const result = applySavedViewMutation(mutation, current, accountId, now, workspaceId === '')
      write.run(workspaceId, mutation.collection, mutation.id, JSON.stringify(result.view), now)
      if (mutation.type === 'delete') {
        const columns = db.prepare('PRAGMA table_info(shares)').all() as Array<{ name: string }>
        const scoped = columns.some((column) => column.name === 'workspace_id')
        if (scoped) {
          db.prepare("DELETE FROM shares WHERE workspace_id = ? AND kind = 'view' AND collection = ? AND view_id = ?")
            .run(workspaceId, mutation.collection, mutation.id)
        } else {
          const target = db.prepare("SELECT 1 FROM shares WHERE kind = 'view' AND collection = ? AND view_id = ? LIMIT 1")
            .get(mutation.collection, mutation.id)
          const otherWorkspace = db.prepare('SELECT 1 FROM saved_views WHERE workspace_id <> ? LIMIT 1').get(workspaceId)
          if (target && (workspaceId !== '' || otherWorkspace)) {
            throw savedViewMutationError('SAVED_VIEW_DENIED')
          }
          db.prepare("DELETE FROM shares WHERE kind = 'view' AND collection = ? AND view_id = ?")
            .run(mutation.collection, mutation.id)
        }
      }
      results.push(result)
    }
    db.exec('COMMIT')
    return results
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Saved view transaction rollback failed')
    }
    throw error
  }
}
