import { test } from 'vitest'
import assert from 'node:assert/strict'
import { captureLiveUiContext, focusFromRoute } from './live-ui-context.ts'

test('focusFromRoute keeps record ids that start with a slash', () => {
  const blockId = '/pages::p1::b1'
  assert.equal(
    focusFromRoute(`/database/${encodeURIComponent('/page-blocks')}/record/${encodeURIComponent(blockId)}`).path,
    '/page-blocks//pages::p1::b1',
  )
  assert.equal(focusFromRoute(`/database/${encodeURIComponent('/pages')}/record/p1`).path, '/pages/p1')
  assert.equal(focusFromRoute('/somewhere/else').path, undefined)
})

test('captureLiveUiContext snapshots the main session', () => {
  const live = captureLiveUiContext({
    get: () => ({
      sessionId: 's1',
      sessions: [{ id: 's1', title: '配图讨论' }],
      sessionInspector: { tab: 'database:/pages' },
    }),
  })
  assert.equal(live?.sessionId, 's1')
  assert.equal(live?.sessionTitle, '配图讨论')
  assert.equal(live?.inspectorTab, 'database:/pages')
})
