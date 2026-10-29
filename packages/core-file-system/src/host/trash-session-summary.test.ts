/** @vitest-environment node */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DatabaseService } from './index.ts'

test('trash loads session summaries once without events and retains authorization checks', async () => {
  let lists = 0
  let gets = 0
  const spec = {
    path: '/sessions', label: 'Sessions',
    list: async () => { lists++; return [{ id: 'allowed', title: 'Allowed' }, { id: 'denied', title: 'Denied' }] },
    get: async () => { gets++; throw new Error('Must not load full events') },
  }
  const service = {
    prepareMetadata: async () => {},
    facets: { listDeleted: () => ['allowed', 'denied', 'missing'].map(record_id => ({ collection: '/sessions', record_id, deleted_at: 10 })) },
    collection: () => spec,
    builtinShared: () => false,
    authorization: () => ({
      currentActor: () => ({ accountId: 'account', workspaceId: 'workspace' }),
      authorize: (_actor: unknown, _action: unknown, resource: { recordId: string }) => ({ allowed: resource.recordId === 'allowed' }),
    }),
    decorateRecord: (_spec: unknown, record: unknown) => record,
  }
  const result = await DatabaseService.prototype.listTrash.call(service as unknown as DatabaseService)
  assert.equal(lists, 1)
  assert.equal(gets, 0)
  assert.deepEqual(result.items.map(item => item.id), ['allowed'])
})
