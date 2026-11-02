import { render } from '@testing-library/react'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { test } from 'vitest'
import {
  PAGE_BLOCK_CAPTURE_EVENT,
  PAGE_BLOCK_HANDOFF_EVENT,
  readPageBlockHandoff,
  usePageBlockSync,
} from './page-block-sync.ts'

function Source({ recordId, data }: { recordId: string; data: Record<string, unknown> }) {
  const [current] = useState(data)
  usePageBlockSync(recordId, current, () => undefined, { answerHandoff: true })
  return null
}

test('handoff keeps the block data and the plugin live capture', () => {
  const id = 'pages::p::terminal'
  const onCapture = (event: Event) => {
    const detail = (event as CustomEvent<{ recordId?: string; patch?: Record<string, unknown> }>).detail
    if (detail?.recordId !== id || !detail.patch) return
    detail.patch.snapshot = 'ls\nreadme'
    detail.patch.history = [{ cmd: 'ls' }]
  }
  window.addEventListener(PAGE_BLOCK_CAPTURE_EVENT, onCapture)
  try {
    render(<Source recordId={id} data={{ sid: 't1', snapshot: '' }} />)
    window.dispatchEvent(new CustomEvent(PAGE_BLOCK_HANDOFF_EVENT, { detail: { recordId: id } }))
    assert.deepEqual(readPageBlockHandoff(id), {
      sid: 't1',
      snapshot: 'ls\nreadme',
      history: [{ cmd: 'ls' }],
    })
  } finally {
    window.removeEventListener(PAGE_BLOCK_CAPTURE_EVENT, onCapture)
    localStorage.removeItem(`biu:page-block-live:${id}`)
  }
})

test('a popout edit in localStorage reaches the page', () => {
  const id = 'pages::p::sql'
  const seen: Record<string, unknown>[] = []
  function Sink() {
    usePageBlockSync(id, { sql: '' }, (next) => {
      seen.push(next)
    })
    return null
  }
  const key = `biu:page-block:sync:${id}`
  render(<Sink />)
  try {
    const payload = { at: Date.now(), source: 'popout', data: { sql: 'select 1' } }
    localStorage.setItem(key, JSON.stringify(payload))
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(payload) }))
    assert.equal(seen.at(-1)?.sql, 'select 1')
    const older = { at: payload.at - 1, source: 'popout', data: { sql: 'select 0' } }
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(older) }))
    assert.equal(seen.at(-1)?.sql, 'select 1')
  } finally {
    localStorage.removeItem(key)
  }
})

test('a stale handoff is ignored', () => {
  const id = 'pages::p::old'
  localStorage.setItem(`biu:page-block-live:${id}`, JSON.stringify({ at: Date.now() - 60_000, data: { n: 1 } }))
  try {
    assert.equal(readPageBlockHandoff(id), null)
  } finally {
    localStorage.removeItem(`biu:page-block-live:${id}`)
  }
})
