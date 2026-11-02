export type SavedViewMutation = {
  collection: string
  id: string
} & (
  | { type: 'create'; view: Record<string, unknown> }
  | { type: 'update'; expectedRevision: number; view: Record<string, unknown> }
  | { type: 'delete'; expectedRevision: number }
)

export type SavedViewMutationResult = {
  collection: string
  id: string
  view: Record<string, unknown> & { id: string; createdBy: string; revision: number }
}

export function savedViewMutationError(code: 'SAVED_VIEW_INVALID' | 'SAVED_VIEW_CONFLICT' | 'SAVED_VIEW_DENIED') {
  const status = code === 'SAVED_VIEW_INVALID' ? 400 : code === 'SAVED_VIEW_CONFLICT' ? 409 : 403
  const message = code === 'SAVED_VIEW_INVALID' ? 'Invalid saved view change'
    : code === 'SAVED_VIEW_CONFLICT' ? 'Saved view changed; reload before saving' : 'Saved view permission denied'
  return Object.assign(new Error(message), { code, status })
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Capture JSON values before yielding so callers cannot mutate a pending transaction. */
export function captureSavedViewMutations(input: readonly SavedViewMutation[]): SavedViewMutation[] {
  const invalid = () => savedViewMutationError('SAVED_VIEW_INVALID')
  if (!Array.isArray(input) || input.length > 200) throw invalid()
  let captured: unknown
  try {
    const json = JSON.stringify(input)
    if (json.length > 1_048_576) throw invalid()
    captured = JSON.parse(json)
  } catch {
    throw invalid()
  }
  if (!Array.isArray(captured)) throw invalid()
  const seen = new Set<string>()
  for (const item of captured) {
    if (!object(item) || !identifier(item.collection, 128) || !identifier(item.id, 128)) throw invalid()
    const segments = item.collection.slice(1).split('/')
    if (!item.collection.startsWith('/') || item.collection === '/views'
      || segments.some((part) => !part || part === '.' || part === '..')
      || item.collection.includes('\\') || /^builtin(?:-|:)/.test(item.id)) throw invalid()
    const key = `${item.collection}\0${item.id}`
    if (seen.has(key)) throw invalid()
    seen.add(key)
    if (item.type !== 'create' && item.type !== 'update' && item.type !== 'delete') throw invalid()
    if (item.type !== 'create' && (!Number.isSafeInteger(item.expectedRevision)
      || (item.expectedRevision as number) < 0 || (item.expectedRevision as number) >= Number.MAX_SAFE_INTEGER)) throw invalid()
    if (item.type === 'create' && item.expectedRevision !== undefined) throw invalid()
    if (item.type !== 'delete') {
      if (!object(item.view) || !identifier(item.view.name, 1024)
        || (item.view.id !== undefined && item.view.id !== item.id)
        || item.view.builtin || item.view.deletedAt != null) throw invalid()
    }
  }
  return captured as SavedViewMutation[]
}

/** Legacy rows without an owner remain claimable; explicit owners cannot be replaced. */
export function applySavedViewMutation(
  mutation: SavedViewMutation,
  current: unknown,
  accountId: string,
  now: number,
  allowAnonymousLocal = false,
): SavedViewMutationResult {
  if (!(allowAnonymousLocal && accountId === '') && !identifier(accountId, 64)) {
    throw savedViewMutationError('SAVED_VIEW_DENIED')
  }
  const conflict = () => savedViewMutationError('SAVED_VIEW_CONFLICT')
  let revision = 0
  if (current !== null) {
    if (!object(current) || current.id !== mutation.id || current.builtin) throw conflict()
    if (current.createdBy != null && current.createdBy !== '' && current.createdBy !== accountId) {
      throw savedViewMutationError('SAVED_VIEW_DENIED')
    }
    if (current.deletedAt != null || mutation.type === 'create') throw conflict()
    const storedRevision = current.revision === undefined ? 0 : current.revision
    if (!Number.isSafeInteger(storedRevision) || (storedRevision as number) < 0
      || storedRevision !== mutation.expectedRevision) throw conflict()
    revision = storedRevision as number
  } else if (mutation.type !== 'create') {
    throw conflict()
  }
  const view = mutation.type === 'delete'
    ? { id: mutation.id, createdBy: accountId, revision: revision + 1, deletedAt: now }
    : { ...mutation.view, id: mutation.id, createdBy: accountId, revision: revision + 1 }
  return { collection: mutation.collection, id: mutation.id, view }
}
