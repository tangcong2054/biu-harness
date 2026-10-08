import assert from 'node:assert/strict'
import * as React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

test('static HTML selection can be attached with Ctrl+L and keeps block dragging intact', async () => {
  vi.stubGlobal('React', React)
  const attached: Array<Array<Record<string, unknown>>> = []
  const blocks = new Map<string, (props: {
    data: Record<string, unknown>
    update: (patch: Record<string, unknown>) => void
    writable: boolean
  }) => React.ReactNode>()
  const { apply, inject } = await import('./web.tsx')
  assert.deepEqual(inject, ['pageEditor', 'pick'])
  apply({
    pick: {
      picking: false,
      attach: (refs) => attached.push(refs),
    },
    pageEditor: {
      registerBlock: (spec) => blocks.set(spec.kind, spec.View),
    },
  })

  const View = blocks.get('html')
  assert.ok(View)
  const HtmlView = View as React.ComponentType<{
    data: Record<string, unknown>
    update: (patch: Record<string, unknown>) => void
    writable: boolean
  }>
  const { container } = render(
    <div draggable>
      <HtmlView
        data={{ html: '<p data-testid="copy">select this text</p>', deck: false }}
        update={() => {}}
        writable
      />
    </div>,
  )
  const copy = container.querySelector('[data-testid="copy"]')!
  fireEvent.mouseDown(copy)
  assert.equal(container.firstElementChild?.getAttribute('draggable'), 'false')

  const range = document.createRange()
  range.selectNodeContents(copy)
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: () => ({ top: 80, left: 20, width: 120, height: 20, right: 140, bottom: 100 }),
  })
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))

  await waitFor(() => assert.ok(document.querySelector('[data-testid="html-selection-bubble"]')))
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'l',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }))
  await waitFor(() => assert.equal(attached.length, 1))
  assert.equal(attached[0]?.[0]?.selection, 'select this text')
  assert.equal(attached[0]?.[0]?.plugin, 'page-html-blocks')
  assert.equal(selection.rangeCount, 0)

  window.dispatchEvent(new MouseEvent('mouseup'))
  assert.equal(container.firstElementChild?.getAttribute('draggable'), 'true')
})
