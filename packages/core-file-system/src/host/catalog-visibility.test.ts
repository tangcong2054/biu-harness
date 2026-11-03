/** @vitest-environment node */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DatabaseService } from './index.ts'

test('registry-filtered catalog reads are not denied by legacy private metadata', () => {
  const db = {
    authorization: () => null,
    mysqlUserMode: () => null,
    workspaceMembership: () => null,
    mysqlVisibility: () => false,
    mysqlGrantedRole: () => null,
  }
  const visible = (DatabaseService.prototype as any).visibleRecords
  const published = [{ id: 'approved' }]
  for (const action of ['resource:read', 'resource:list']) {
    assert.deepEqual(visible.call(db, '/plugin-catalog', published, action), published)
    assert.deepEqual(visible.call(db, '/plugin-catalog', [], action), [])
  }
  assert.deepEqual(visible.call(db, '/plugin-catalog', published, 'resource:update'), [])
  assert.deepEqual(visible.call(db, '/pages', published), [])
  assert.deepEqual(visible.call(db, '/plugins', published), [])
  assert.deepEqual(visible.call(db, '/plugin-reviews', published), [])
})
