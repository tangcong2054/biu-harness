import {
  BUILTIN_FIELDS,
  isReservedSchemaFieldKey,
  isReservedSchemaFieldLabel,
  normalizeSchemaPack,
  type CollectionSchemaPack,
} from '@biu/type-file-system'

export const FACETS_KEY = 'fsdb.facets'

let memory: CollectionSchemaPack[] | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function parseFacets(raw: unknown): CollectionSchemaPack[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => normalizeSchemaPack(item)).filter((item): item is CollectionSchemaPack => Boolean(item))
}

export function subscribeFacets(_collectionPath: string | undefined, fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function loadFacets(_collectionPath?: string): CollectionSchemaPack[] {
  if (memory) return memory
  try {
    memory = parseFacets(JSON.parse(localStorage.getItem(FACETS_KEY) ?? '[]'))
    return memory
  } catch {
    memory = []
    return memory
  }
}

export const FACETS_SAVE_FAILED_EVENT = 'fsdb:facets-save-failed'

let facetsWriteGen = 0

function applyFacetsLocally(next: CollectionSchemaPack[]) {
  memory = next
  try {
    localStorage.setItem(FACETS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  emit()
  try {
    window.dispatchEvent(new Event('fsdb:change'))
  } catch {
    /* ignore */
  }
}

/**
 * 先切界面再保存。保存失败（网络错误或非 2xx）且期间没有更新的写入时，
 * 回滚到修改前的分面并广播失败事件，不能让界面停在服务端没有的配置上。
 * 返回是否保存成功；同步调用方可以忽略返回值。
 */
export function persistFacets(facets: CollectionSchemaPack[], _collectionPath?: string): Promise<boolean> {
  const previous = loadFacets()
  const next = parseFacets(facets)
  const gen = ++facetsWriteGen
  applyFacetsLocally(next)
  const request = typeof fetch === 'function'
    ? fetch('/api/db/facets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ facets: next }),
      })
    : Promise.reject(new Error('fetch unavailable'))
  return request
    .then(async (res) => {
      if (res.ok) return true
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null
      throw new Error(typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`)
    })
    .catch((error: unknown) => {
      if (gen !== facetsWriteGen) return false
      applyFacetsLocally(previous)
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[facets] save failed', message)
      try {
        window.dispatchEvent(new CustomEvent(FACETS_SAVE_FAILED_EVENT, { detail: { error: message } }))
      } catch {
        /* ignore */
      }
      return false
    })
}

export async function pullFacets(_collectionPath?: string) {
  try {
    const res = await fetch('/api/db/facets')
    const body = (await res.json()) as { facets?: unknown[] }
    if (!res.ok || !Array.isArray(body.facets)) return loadFacets()
    const facets = parseFacets(body.facets)
    const prev = JSON.stringify(memory ?? [])
    const next = JSON.stringify(facets)
    memory = facets
    try {
      localStorage.setItem(FACETS_KEY, JSON.stringify(facets))
    } catch {
      /* ignore */
    }
    if (prev !== next) emit()
    return facets
  } catch {
    /* ignore */
  }
  return loadFacets()
}

export function slugFacetId(label: string, used: Set<string>) {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'facet'
  let id = /^[a-z]/.test(base) ? base : `f-${base}`
  let n = 2
  while (used.has(id) || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    id = `${base.slice(0, 20)}-${n}`
    if (!/^[a-z]/.test(id)) id = `f-${id}`
    n += 1
  }
  return id
}

export function fieldKeyFromLabel(label: string, used: Set<string>) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  let key = /^[A-Za-z]/.test(slug) ? slug : `f_${slug || 'field'}`
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) key = 'field'
  const blocked = new Set([...used, ...Object.keys(BUILTIN_FIELDS)])
  let n = 2
  let next = key
  while (blocked.has(next)) {
    next = `${key}_${n}`
    n += 1
  }
  return next
}

export function registerFacetFieldKey(
  label: string,
  used: { keys?: Iterable<string>; labels?: Iterable<string> } = {},
): string | null {
  const name = label.trim()
  if (!name) return null
  if (isReservedSchemaFieldKey(name) || isReservedSchemaFieldLabel(name)) return null
  const usedLabels = new Set([...used.labels ?? []].map((item) => String(item).trim().toLowerCase()).filter(Boolean))
  if (usedLabels.has(name.toLowerCase())) return null
  const usedKeys = new Set(used.keys ?? [])
  const key = fieldKeyFromLabel(name, usedKeys)
  if (isReservedSchemaFieldKey(key) || usedKeys.has(key)) return null
  return key
}
