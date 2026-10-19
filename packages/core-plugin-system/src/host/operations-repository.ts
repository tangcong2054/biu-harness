export type MaybePromise<T> = T | Promise<T>

export type OperationsKind = 'account' | 'workspace' | 'usage' | 'device' | 'sync' | 'security'

export type OperationsRow = Record<string, unknown> & { id: string }

export type OperationsCounts = {
  accounts: number
  workspaces: number
  usage: number
  devices: number
  sync: number
  security: number
  audits: number
}

export interface OperationsRepository {
  list(kind: OperationsKind, q?: string): MaybePromise<OperationsRow[]>
  audits(q?: string): MaybePromise<OperationsRow[]>
  counts(): MaybePromise<OperationsCounts>
  upsert(
    kind: OperationsKind,
    input: Record<string, unknown>,
    now?: number,
  ): MaybePromise<OperationsRow | null>
  setAccountStatus(
    id: string,
    status: 'active' | 'suspended',
    actorId: string,
    now?: number,
  ): MaybePromise<OperationsRow | null>
  audit(
    actorId: string,
    action: string,
    target: string,
    summary: string,
    now?: number,
  ): MaybePromise<void>
  upsertAudit(
    id: string,
    actorId: string,
    action: string,
    target: string,
    summary: string,
    createdAt: number,
  ): MaybePromise<void>
  removePlaceholderIdentity(): MaybePromise<void>
}
