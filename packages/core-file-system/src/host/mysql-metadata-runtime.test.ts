import { describe, expect, test } from 'vitest'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { MetadataRepository } from '@biu/host-plugin-loader/metadata-runtime'
import { FacetStore } from './facets-store.ts'
import { SavedViewsStore } from './saved-views.ts'
import { SharesStore } from './shares-store.ts'

class MemoryMetadataRepository implements MetadataRepository {
  rows = new Map<string, Array<Record<string, unknown>>>()

  async list(table: string) {
    return this.rows.get(table)?.map((row) => ({ ...row })) ?? []
  }

  async replaceTable(table: string, rows: Array<Record<string, unknown>>) {
    this.rows.set(table, rows.map((row) => ({ workspace_id: 'ws-meta', ...row })))
  }

  async getShareByToken(token: string) {
    return this.rows.get('shares')?.find((row) => row.token === token) ?? null
  }

  async deleteShareByToken(token: string) {
    this.rows.set('shares', (this.rows.get('shares') ?? []).filter((row) => row.token !== token))
  }
}

describe('core File System MySQL metadata wiring', () => {
  test('facets, overlays, refs, views and shares flush through the selected repository', async () => {
    const repository = new MemoryMetadataRepository()
    const editorRows = new Map<string, string>()
    const editor = {
      async list() {
        return [] as Array<{ record_id: string; body: string; updated_at: number; version: number }>
      },
      async write(_collection: string, recordId: string, body: string) {
        editorRows.set(recordId, body)
        return { body, version: 1 }
      },
      async delete(_collection: string, recordId: string) {
        editorRows.delete(recordId)
      },
    }

    await runWithRequestWorkspace('ws-meta', async () => {
      const facets = new FacetStore().open(':memory:')
      facets.configureRuntime('mysql', repository, editor)
      await facets.prepare()
      facets.upsert({ id: 'project', label: 'Project', fields: [] }, 'facet notes')
      facets.writeRecordFacet('/pages', 'p1', { tags: ['project'], values: {} }, 'Page 1')
      facets.writeRecordMeta('/pages', 'p1', { emoji: '📄', tags: ['important'] })
      facets.writeRecordBanner('/pages', 'p1', { kind: 'html', html: '<b>banner</b>' })
      facets.putAttachment({ name: 'p1.txt', etag: 'e1', mime: 'text/plain', bytes: 1 })
      facets.replaceContentRefs('/pages', 'p1', ['p1.txt'])
      facets.replaceBlockRefs('/pages', 'p1', 'b1', [{ name: 'p1.txt', source: 'block:b1' }])
      await facets.flush()

      expect(repository.rows.get('facets')?.[0]).toMatchObject({ id: 'project', label: 'Project' })
      expect(repository.rows.get('record_meta')?.[0]).toMatchObject({ record_id: 'p1', emoji: '📄' })
      expect(repository.rows.get('record_banners')).toHaveLength(1)
      expect(repository.rows.get('attachments')).toHaveLength(1)
      expect(repository.rows.get('content_refs')).toHaveLength(1)
      expect(repository.rows.get('block_refs')).toHaveLength(1)
      expect(editorRows.get('project')).toBe('facet notes')

      const views = new SavedViewsStore().open(':memory:')
      views.configureRuntime('mysql', repository)
      await views.prepare()
      views.replace('/pages', [{ id: 'mine', name: 'Mine' }])
      await views.flush()
      expect(repository.rows.get('saved_views')?.[0]).toMatchObject({ collection: '/pages', view_id: 'mine' })

      const shares = new SharesStore().open(':memory:')
      shares.configureRuntime('mysql', repository)
      await shares.prepare()
      const share = shares.upsert({ kind: 'record', collection: '/pages', recordId: 'p1' })
      await shares.flush()
      expect(await repository.getShareByToken(share.token)).toMatchObject({ record_id: 'p1' })
      shares.revoke(share.token)
      await shares.flush()
      expect(await repository.getShareByToken(share.token)).toBeNull()
    })
  })
})
