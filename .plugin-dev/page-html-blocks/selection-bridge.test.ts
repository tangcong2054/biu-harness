import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'
import {
  HTML_SELECTION_MESSAGE,
  MAX_HTML_SELECTION_CHARS,
  injectHtmlSelectionBridge,
  parseHtmlSelectionMessage,
  suspendAncestorDrag,
} from './selection-bridge.ts'

test('injects the sandbox selection bridge before body end', () => {
  const html = '<!doctype html><html><body><p>hello</p></body></html>'
  const out = injectHtmlSelectionBridge(html, 'nonce-1')
  assert.match(out, /data-biu-html-selection-bridge/)
  assert.match(out, /biu:page-html-selection/)
  assert.match(out, /nonce-1/)
  assert.ok(out.indexOf('data-biu-html-selection-bridge') < out.indexOf('</body>'))
  assert.match(out, /event\.metaKey\|\|event\.ctrlKey/)
  assert.match(out, /event\.preventDefault\(\)/)
})

test('validates iframe source and nonce before accepting selection text', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const data = {
    type: HTML_SELECTION_MESSAGE,
    nonce: 'n',
    action: 'attach',
    text: '  selected text  ',
    rect: { top: 1, left: 2, width: 30, height: 10 },
  }
  const parsed = parseHtmlSelectionMessage(
    { source: frame.contentWindow, data } as MessageEvent,
    frame,
    'n',
  )
  assert.equal(parsed?.text, 'selected text')
  assert.deepEqual(parsed?.rect, { top: 1, left: 2, width: 30, height: 10 })
  assert.equal(
    parseHtmlSelectionMessage({ source: window, data } as MessageEvent, frame, 'n'),
    null,
  )
  assert.equal(
    parseHtmlSelectionMessage(
      { source: frame.contentWindow, data } as MessageEvent,
      frame,
      'wrong',
    ),
    null,
  )
  frame.remove()
})

test('caps iframe selection payloads', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const parsed = parseHtmlSelectionMessage(
    {
      source: frame.contentWindow,
      data: {
        type: HTML_SELECTION_MESSAGE,
        nonce: 'n',
        action: 'preview',
        text: 'x'.repeat(MAX_HTML_SELECTION_CHARS + 100),
      },
    } as MessageEvent,
    frame,
    'n',
  )
  assert.equal(parsed?.text.length, MAX_HTML_SELECTION_CHARS)
  frame.remove()
})

test('temporarily disables draggable page block while selecting text', () => {
  const block = document.createElement('div')
  block.setAttribute('draggable', 'true')
  const content = document.createElement('div')
  block.append(content)
  document.body.append(block)

  suspendAncestorDrag(content)
  assert.equal(block.getAttribute('draggable'), 'false')
  window.dispatchEvent(new MouseEvent('mouseup'))
  assert.equal(block.getAttribute('draggable'), 'true')
  block.remove()
})

test('web view wires static and iframe selection into core-pick', () => {
  const source = readFileSync(resolve(import.meta.dirname, './web.tsx'), 'utf8')
  assert.match(source, /inject = \['pageEditor', 'pick'\]/)
  assert.match(source, /htmlPick\.attach/)
  assert.doesNotMatch(source, /@biu\//)
  assert.match(source, /data-testid="html-selection-bubble"/)
  assert.match(source, /event\.key !== 'l'/)
  assert.match(source, /suspendAncestorDrag\(event\.currentTarget\)/)
  assert.match(source, /parseHtmlSelectionMessage/)
  assert.match(source, /srcDoc=\{bridgedHtml\}/)
  assert.match(source, /sandbox="allow-scripts"/)
  assert.doesNotMatch(source, /allow-same-origin/)
})
