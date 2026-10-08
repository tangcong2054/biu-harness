import { test } from 'vitest'
import assert from 'node:assert/strict'
import { injectDeckBridge, sendDeckCommand } from '../../../../.plugin-dev/page-html-blocks/deck-bridge.ts'

test('injects once, before </body>, and is idempotent', () => {
  const html = '<!DOCTYPE html><html><body><p>hi</p></body></html>'
  const once = injectDeckBridge(html)
  assert.equal(once.indexOf('data-php-deck-bridge') > 0, true)
  assert.equal(once.indexOf('<p>hi</p>') < once.indexOf('data-php-deck-bridge'), true)
  assert.equal(once.indexOf('data-php-deck-bridge') < once.lastIndexOf('</body>'), true)
  assert.equal(injectDeckBridge(once), once, 'idempotent')
})

test('falls back to </html> then to append', () => {
  const a = injectDeckBridge('<html><p>x</p></html>')
  assert.equal(a.indexOf('data-php-deck-bridge') < a.lastIndexOf('</html>'), true)
  const b = injectDeckBridge('<div>x</div>')
  assert.equal(b.endsWith('</' + 'script>'), true)
})

test('bridge source avoids raw closing script tag', () => {
  const out = injectDeckBridge('<body></body>')
  const body = out.slice(out.indexOf('="1">') + 5, out.lastIndexOf('</' + 'script>'))
  assert.equal(body.includes('</' + 'script>'), false)
  assert.equal(body.includes('`'), false, 'no backticks inside template literal')
})

test('sendDeckCommand tolerates null frame', () => {
  assert.doesNotThrow(() => sendDeckCommand(null, 'next'))
})
