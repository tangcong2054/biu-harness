import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import {
  MysqlEditorContentRepository,
  MysqlFileSystemMetadataRepository,
  MysqlPageRepository,
  resolveRuntimeRepositoryMode,
} from './mysql-runtime-repositories.ts'

describe('runtime repository selection', () => {
  test('Offline is always SQLite', () => {
    expect(resolveRuntimeRepositoryMode('dual', false, 'mysql', 'TEST_MODE')).toBe('sqlite')
    expect(resolveRuntimeRepositoryMode('mysql', false, 'shadow', 'TEST_MODE')).toBe('sqlite')
  })

  test('dual selects each requested mode and validates input', () => {
    expect(resolveRuntimeRepositoryMode('dual', true, undefined, 'TEST_MODE')).toBe('mysql')
    expect(resolveRuntimeRepositoryMode('dual', true, 'shadow', 'TEST_MODE')).toBe('shadow')
    expect(resolveRuntimeRepositoryMode('dual', true, 'sqlite', 'TEST_MODE')).toBe('sqlite')
    expect(() => resolveRuntimeRepositoryMode('dual', true, 'bad', 'TEST_MODE')).toThrow(/TEST_MODE/)
  })
})

const mysqlUrl = process.env.BIU_MYSQL_TEST_URL
const mysqlDatabase = process.env.BIU_MYSQL_TEST_DATABASE
const integration = mysqlUrl && mysqlDatabase ? describe : describe.skip

integration('MySQL Page and editor_content repositories', () => {
  let pool: Pool
  const workspaceId = `ws_test_${randomUUID().replaceAll('-', '')}`
  const pageId = `p_${randomUUID().replaceAll('-', '')}`

  afterAll(async () => {
    if (!pool) return
    await pool.query(
      `DELETE FROM \`${mysqlDatabase}\`.editor_content WHERE workspace_id = ? AND record_id = ?`,
      [workspaceId, pageId],
    )
    await pool.query(
      `DELETE FROM \`${mysqlDatabase}\`.pages WHERE workspace_id = ? AND id = ?`,
      [workspaceId, pageId],
    )
    await pool.end()
  })

  test('CRUD, projection and optimistic content conflict', async () => {
    pool = createPool({ uri: mysqlUrl! })
    const pages = new MysqlPageRepository(pool, mysqlDatabase!)
    const content = new MysqlEditorContentRepository(pool, mysqlDatabase!)
    await runWithRequestWorkspace(workspaceId, async () => {
      await pages.createWithContent({
        id: pageId,
        title: 'first',
        notes: 'body one',
        parentId: null,
        dependsOn: [],
        emoji: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const projected = await pages.list([pageId])
      expect(projected).toHaveLength(1)
      expect(projected[0]?.notes).toBe('')
      expect((await pages.get(pageId))?.notes).toBe('body one')

      const first = await content.read('/pages', pageId)
      const second = await content.write('/pages', pageId, 'body two', first.version)
      expect(second.version).toBe(first.version + 1)
      await expect(content.write('/pages', pageId, 'stale', first.version)).rejects.toMatchObject({
        code: 'EDITOR_CONTENT_CONFLICT',
        expectedVersion: first.version,
        actualVersion: second.version,
      })

      await pages.updateWithContent({
        ...(await pages.get(pageId))!,
        title: 'second',
        updatedAt: Date.now(),
      })
      expect((await pages.get(pageId))?.title).toBe('second')
      await pages.deleteWithContent(pageId)
      expect(await pages.get(pageId)).toBeNull()
    })
  })
})

integration('MySQL File System metadata repository', () => {
  let pool: Pool
  const suffix = randomUUID().replaceAll('-', '')
  const workspaceA = `ws_meta_a_${suffix}`
  const workspaceB = `ws_meta_b_${suffix}`
  const facetId = `facet_${suffix}`
  const viewId = `view_${suffix}`
  const token = `share_${suffix}`
  const recordId = `record_${suffix}`

  afterAll(async () => {
    if (!pool) return
    for (const workspaceId of [workspaceA, workspaceB]) {
      const repository = new MysqlFileSystemMetadataRepository(pool, mysqlDatabase!, () => workspaceId)
      await repository.delete('facet_stamps', { facet_id: facetId })
      await repository.delete('facet_record_values', { collection: '/pages', record_id: recordId })
      await repository.delete('record_meta', { collection: '/pages', record_id: recordId })
      await repository.delete('saved_views', { collection: '/pages', view_id: viewId })
      await repository.delete('shares', { token })
      await repository.delete('record_banners', { collection: '/pages', record_id: recordId })
      await repository.delete('banner_gallery', { id: facetId })
      await repository.delete('content_refs', { collection: '/pages', record_id: recordId })
      await repository.delete('block_refs', { collection: '/pages', record_id: recordId })
      await repository.delete('attachments', { name: `${recordId}.txt` })
      await repository.delete('page_block_index', { collection: '/pages', page_id: recordId })
      await repository.delete('page_block_cover', { collection: '/pages', page_id: recordId })
      await repository.delete('page_block_index_meta', { key: `test:${recordId}` })
      await repository.delete('facets', { id: facetId })
    }
    await pool.end()
  })

  test('CRUD, tenant isolation, saved view/share token, soft delete and facet values', async () => {
    pool = createPool({ uri: mysqlUrl! })
    const repository = new MysqlFileSystemMetadataRepository(pool, mysqlDatabase!)

    await runWithRequestWorkspace(workspaceA, async () => {
      await repository.upsert('facets', {
        id: facetId,
        label: 'Workspace A',
        fields_json: '[]',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      await repository.transaction(async (tx) => {
        await tx.upsert('facet_record_values', {
          collection: '/pages',
          record_id: recordId,
          facet_json: JSON.stringify({ tags: [facetId], values: {} }),
        })
        await tx.upsert('facet_stamps', {
          facet_id: facetId,
          collection: '/pages',
          record_id: recordId,
          title: 'Page A',
        })
      })
      await repository.upsert('record_meta', {
        collection: '/pages',
        record_id: recordId,
        emoji: '🅰️',
        tags_json: '[]',
        created_by_json: null,
        updated_by_json: null,
        deleted_at: Date.now(),
      })
      await repository.upsert('saved_views', {
        collection: '/pages',
        view_id: viewId,
        payload_json: JSON.stringify({ id: viewId, name: 'Only A' }),
        updated_at: Date.now(),
      })
      await repository.upsert('shares', {
        token,
        kind: 'view',
        collection: '/pages',
        view_id: viewId,
        record_id: '',
        password_salt: '',
        password_hash: '',
        share_plugins: 0,
        allow_copy: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      await repository.upsert('record_banners', {
        collection: '/pages', record_id: recordId, kind: 'html', html: '<b>A</b>',
      })
      await repository.upsert('banner_gallery', {
        id: facetId, kind: 'html', style: 'mine', title: 'A', html: '<b>A</b>', created_at: Date.now(),
      })
      await repository.upsert('attachments', {
        name: `${recordId}.txt`, etag: 'etag-a', mime: 'text/plain', bytes: 1,
        kind: 'asset', storage: 'name', created_at: Date.now(),
      })
      await repository.upsert('content_refs', {
        collection: '/pages', record_id: recordId, name: `${recordId}.txt`, source: 'content',
      })
      await repository.upsert('block_refs', {
        collection: '/pages', record_id: recordId, block_id: 'block-a',
        name: `${recordId}.txt`, source: 'block:block-a',
      })
      await repository.upsert('page_block_index', {
        collection: '/pages', page_id: recordId, block_id: 'block-a', kind: 'html',
        plugin: '', title: 'Block A', page_title: 'Page A', data_json: '{}',
        page_created_at: Date.now(), page_updated_at: Date.now(),
      })
      await repository.upsert('page_block_cover', {
        collection: '/pages', page_id: recordId, page_updated_at: Date.now(),
      })
      await repository.upsert('page_block_index_meta', {
        key: `test:${recordId}`, value: '1',
      })

      expect((await repository.get('record_meta', {
        collection: '/pages',
        record_id: recordId,
      }))?.deleted_at).toBeTruthy()
      expect(await repository.list('facet_stamps', { facet_id: facetId })).toHaveLength(1)
      expect(await repository.list('content_refs', { record_id: recordId })).toHaveLength(1)
      expect(await repository.list('block_refs', { record_id: recordId })).toHaveLength(1)
      expect(await repository.list('page_block_index', { page_id: recordId })).toHaveLength(1)
      expect((await repository.getShareByToken(token))?.workspace_id).toBe(workspaceA)
    })

    await runWithRequestWorkspace(workspaceB, async () => {
      expect(await repository.get('facets', { id: facetId })).toBeNull()
      expect(await repository.get('saved_views', { collection: '/pages', view_id: viewId })).toBeNull()
      await repository.upsert('facets', {
        id: facetId,
        label: 'Workspace B',
        fields_json: '[]',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      expect((await repository.get('facets', { id: facetId }))?.label).toBe('Workspace B')
    })

    await runWithRequestWorkspace(workspaceA, async () => {
      expect((await repository.get('facets', { id: facetId }))?.label).toBe('Workspace A')
      expect(await repository.delete('record_meta', {
        collection: '/pages',
        record_id: recordId,
      })).toBe(1)
      expect(await repository.get('record_meta', {
        collection: '/pages',
        record_id: recordId,
      })).toBeNull()
    })
  })
})
