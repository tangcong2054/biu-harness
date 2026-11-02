import type { CollectionSchema, CollectionSchemaPack, DbRecord } from '@biu/type-file-system'
import { isBuiltinAllViewId, parseBuiltinScopeViewId, stubBuiltinMemberView } from '../catalog-views.ts'
import { matchListFilterRecord } from '../query-logic.ts'
import { recordMatchesGrantedView, type DataScopeName } from '../view-access.ts'

type View = { id: string; filters?: Record<string, unknown>; filterTree?: unknown }

function validTree(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 32) return false
  const node = value as Record<string, unknown>
  if (node.kind === 'group') {
    return (node.combinator === 'and' || node.combinator === 'or') && Array.isArray(node.children)
      && node.children.every((child) => validTree(child, depth + 1))
  }
  return node.kind === 'rule' && typeof node.field === 'string' && Boolean(node.field.trim())
    && node.field !== 'shareScope' && !node.field.startsWith('$')
    && ['eq', 'neq', 'contains', 'not_contains', 'is_empty', 'not_empty', 'gt', 'lt', 'within'].includes(String(node.op))
    && typeof node.value === 'string'
    && (node.op === 'is_empty' || node.op === 'not_empty' || Boolean(node.value.trim()))
}

/** 匹配器只认顶层为规则组的树；顶层单条规则会被当成“无条件”，授权时必须拒绝。 */
function validRootTree(value: unknown) {
  return validTree(value) && (value as { kind?: unknown }).kind === 'group'
}

function validView(view: View) {
  if (view.filterTree !== undefined && view.filterTree !== null && !validRootTree(view.filterTree)) return false
  if (view.filters === undefined) return true
  if (!view.filters || typeof view.filters !== 'object' || Array.isArray(view.filters)) return false
  return Object.entries(view.filters).every(([key, value]) => {
    if (key === '$tree') return validRootTree(value)
    if (key === '$scope') return ['personal', 'workspace', 'shared'].includes(String(value))
    if (key.startsWith('$') || key === 'shareScope') return false
    return value == null || ['string', 'number', 'boolean'].includes(typeof value)
  })
}

function withFilterTree(view: View) {
  return { ...view, filters: { ...view.filters, ...(view.filterTree ? { $tree: view.filterTree } : {}) } }
}

export function accessMemberViewMatches(viewId: string, member: DbRecord, views: View[]) {
  const view = views.find((item) => item.id === viewId) ?? stubBuiltinMemberView(viewId)
  return Boolean(view && validView(view) && !view.filters?.$scope && matchListFilterRecord(member, withFilterTree(view).filters))
}

export function accessRecordViewMatches(
  viewId: string, record: DbRecord, views: View[], scope: DataScopeName | null,
  ownerId: string, grantedBy: string,
  schema?: CollectionSchema, packs: CollectionSchemaPack[] = [],
) {
  const normalized = views.filter(validView).map(withFilterTree)
  const baseId = parseBuiltinScopeViewId(viewId)?.viewId ?? viewId
  if (!normalized.some((view) => view.id === baseId)) return false
  if (isBuiltinAllViewId(baseId) && (!grantedBy || ownerId !== grantedBy)) return false
  return recordMatchesGrantedView(record, viewId, normalized, scope, { recordOwnerId: ownerId, grantedBy }, schema, packs)
}
