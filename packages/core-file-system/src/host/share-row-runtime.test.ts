import { describe, expect, it, vi } from 'vitest'
import { currentRequestWorkspaceId, runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { MetadataRepository } from '@biu/host-plugin-loader/metadata-runtime'
import { SharesStore } from './shares-store.ts'

function fixture() {
  const rows = new Map<string, Record<string, unknown>>()
  const conflict = () => Object.assign(new Error('share conflict'), { code: 'SHARE_CONFLICT' })
  const repository = {
    list: vi.fn(async () => [...rows.values()].filter((row) => row.workspace_id === currentRequestWorkspaceId()).map((row) => ({ ...row }))),
    replaceTable: vi.fn(async () => { throw new Error('Full share replacement forbidden') }),
    saveShare: vi.fn(async (next: Record<string, unknown>, previous: Record<string, unknown> | null) => {
      const current = rows.get(String(next.token))
      const workspace = currentRequestWorkspaceId()
      if (previous && (!current || current.workspace_id !== workspace || Object.keys(previous).some((key) => current[key] !== previous[key]))) throw conflict()
      if (!previous && current) throw conflict()
      rows.set(String(next.token), { workspace_id: workspace, ...next })
    }),
    deleteShares: vi.fn(async (where: Record<string, unknown>) => {
      for (const [token, row] of rows) {
        if (row.workspace_id === currentRequestWorkspaceId() && Object.entries(where).every(([key, value]) => row[key] === value)) rows.delete(token)
      }
    }),
    getShareByToken: vi.fn(async (token: string) => rows.get(token) ?? null),
  } satisfies MetadataRepository
  const store = () => {
    const shares = new SharesStore().open(':memory:')
    shares.configureRuntime('mysql', repository)
    return shares
  }
  return { rows, repository, store }
}
const target = { kind: 'record' as const, collection: '/pages', recordId: 'p1' }

describe('share runtime row-level persistence', () => {
  it('does not restore a revoked link when a stale instance saves an unrelated link', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const first = f.store()
      const stale = f.store()
      await first.prepare()
      const share = first.upsert(target)
      await first.flush()
      await stale.prepare()
      first.revoke(share.token)
      await first.flush()
      expect(stale.get(share.token)).not.toBeNull()
      const other = stale.upsert({ ...target, recordId: 'p2' })
      await stale.flush()
      expect(f.rows.has(share.token)).toBe(false)
      expect(f.rows.has(other.token)).toBe(true)
      expect(f.repository.replaceTable).not.toHaveBeenCalled()
    })
  })

  it('rejects updating a revoked token, clears optimistic cache and recovers on reload', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const first = f.store()
      const stale = f.store()
      const share = first.upsert(target)
      await first.flush()
      await stale.prepare()
      first.revoke(share.token)
      await first.flush()
      stale.upsert({ ...target, allowCopy: false })
      await expect(stale.flush()).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
      expect(stale.get(share.token)).toBeNull()
      expect(f.rows.has(share.token)).toBe(false)
      await stale.prepare()
      const reopened = stale.upsert(target)
      await stale.flush()
      expect(reopened.token).not.toBe(share.token)
      expect(f.rows.has(reopened.token)).toBe(true)
    })
  })

  it('rejects stale flag edits instead of silently removing a newly added password', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const first = f.store()
      const stale = f.store()
      const share = first.upsert(target)
      await first.flush()
      await stale.prepare()
      first.upsert({ ...target, password: 'new-password' })
      await first.flush()
      const hash = f.rows.get(share.token)?.password_hash
      stale.upsert({ ...target, allowCopy: false })
      await expect(stale.flush()).rejects.toMatchObject({ code: 'SHARE_CONFLICT' })
      expect(f.rows.get(share.token)?.password_hash).toBe(hash)
      await stale.prepare()
      expect(stale.verifyPassword(share.token, 'new-password')).toBe(true)
    })
  })

  it.each(['record', 'view', 'target', 'token'])('revokes %s directly even with an empty local cache', async (mode) => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const first = f.store()
      const empty = f.store()
      const input = mode === 'record' || mode === 'token' ? target : { kind: 'view' as const, collection: '/pages', viewId: 'v' }
      const share = first.upsert(input)
      await first.flush()
      if (mode === 'record') empty.revokeRecord('/pages', 'p1')
      if (mode === 'view') empty.revokeView('/pages', 'v')
      if (mode === 'target') empty.revokeTarget('view', '/pages', 'v')
      if (mode === 'token') empty.revoke(share.token)
      await empty.flush()
      expect(f.rows.has(share.token)).toBe(false)
      expect(f.repository.replaceTable).not.toHaveBeenCalled()
    })
  })

  it('preserves request workspace and values in queued changes', async () => {
    const f = fixture()
    const first = f.store()
    let a = ''
    let b = ''
    runWithRequestWorkspace('ws-a', () => { a = first.upsert(target).token })
    runWithRequestWorkspace('ws-b', () => { b = first.upsert({ ...target, recordId: 'p2' }).token })
    await first.flush()
    expect(f.rows.get(a)?.workspace_id).toBe('ws-a')
    expect(f.rows.get(b)?.workspace_id).toBe('ws-b')
  })

  it('preserves sequential changes issued before flush without replacing the table', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const first = f.store()
      const share = first.upsert(target)
      first.upsert({ ...target, allowCopy: false })
      first.upsert({ ...target, sharePlugins: true })
      await first.flush()
      expect(f.rows.get(share.token)).toMatchObject({ allow_copy: 0, share_plugins: 1 })
      expect(f.repository.saveShare).toHaveBeenCalledTimes(3)
      expect(f.repository.replaceTable).not.toHaveBeenCalled()
    })
  })

  it('rejects unavailable row APIs before local writes', async () => {
    const shares = new SharesStore().open(':memory:')
    shares.configureRuntime('mysql', { list: async () => [], replaceTable: async () => {} })
    await runWithRequestWorkspace('ws', async () => {
      expect(() => shares.upsert(target)).toThrow('repository required')
      expect(shares.list()).toEqual([])
    })
  })

  it('reports a failed delete and reloads the authoritative link before retry', async () => {
    const f = fixture()
    await runWithRequestWorkspace('ws', async () => {
      const shares = f.store()
      const share = shares.upsert(target)
      await shares.flush()
      f.repository.deleteShares.mockRejectedValueOnce(new Error('temporarily unavailable'))
      shares.revoke(share.token)
      await expect(shares.flush()).rejects.toThrow('temporarily unavailable')
      expect(f.rows.has(share.token)).toBe(true)
      await shares.prepare()
      expect(shares.get(share.token)).not.toBeNull()
      shares.revoke(share.token)
      await shares.flush()
      expect(f.rows.has(share.token)).toBe(false)
    })
  })

  it('keeps shadow errors observable without replacing or rolling back authoritative SQLite', async () => {
    const f = fixture()
    const errors = vi.fn()
    const shares = new SharesStore().open(':memory:')
    shares.configureRuntime('shadow', f.repository, errors)
    await runWithRequestWorkspace('ws', async () => {
      f.repository.saveShare.mockRejectedValueOnce(new Error('shadow unavailable'))
      const share = shares.upsert(target)
      await shares.flush()
      expect(errors).toHaveBeenCalledOnce()
      expect(shares.get(share.token)).not.toBeNull()
      expect(f.repository.replaceTable).not.toHaveBeenCalled()
    })
  })
})
