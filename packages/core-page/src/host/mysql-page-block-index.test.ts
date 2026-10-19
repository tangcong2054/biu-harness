import { expect, test } from 'vitest'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import type { MetadataRepository } from '@biu/host-plugin-loader/metadata-runtime'
import { PageBlocksIndex } from './page-blocks-index.ts'
import type { PagesStore } from './store.ts'

class MemoryMetadataRepository implements MetadataRepository {
  rows = new Map<string, Array<Record<string, unknown>>>()

  async list(table: string) {
    return this.rows.get(table)?.map((row) => ({ ...row })) ?? []
  }

  async replaceTable(table: string, rows: Array<Record<string, unknown>>) {
    this.rows.set(table, rows.map((row) => ({ workspace_id: 'ws-page-index', ...row })))
  }
}

test('PageBlocksIndex reads and writes the MySQL metadata repository', async () => {
  const repository = new MemoryMetadataRepository()
  const editor = {
    async read() {
      return { body: '', version: 0 }
    },
    async list() {
      return [] as Array<{ record_id: string; body: string; updated_at: number; version: number }>
    },
    async workspaceIds() {
      return ['ws-page-index']
    },
    async write() {},
  }
  const index = new PageBlocksIndex({} as PagesStore)
  index.configureRuntime('mysql', repository, editor)

  await runWithRequestWorkspace('ws-page-index', async () => {
    await index.reindexRecord('/pages', 'p1', {
      title: 'Page One',
      createdAt: 1,
      updatedAt: 2,
      body: ':::pageBlock {kind=html plugin=page-html-blocks id=hero1234}\n<div>hello</div>\n:::\n',
    })
    const rows = await index.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pageId: 'p1', blockId: 'hero1234', pageTitle: 'Page One' })
  })

  expect(repository.rows.get('page_block_index')).toHaveLength(1)
  expect(repository.rows.get('page_block_cover')).toHaveLength(1)
})
