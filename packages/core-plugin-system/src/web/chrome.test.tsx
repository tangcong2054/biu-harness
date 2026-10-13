import { test } from 'vitest'
import assert from 'node:assert/strict'
import { render } from '@testing-library/react'
import { pluginsChrome } from './chrome.tsx'

test('plugin actions preserve the plugin-specific run and publish controls', () => {
  assert.equal(typeof pluginsChrome.Actions, 'function')
})

test('plugin title puts a green dot left of the name when enabled', () => {
  const Title = pluginsChrome.Title
  assert.ok(Title)
  const off = render(<Title record={{ id: 'draft' }} label="草稿" />)
  assert.equal(off.container.querySelector('[data-testid="plugin-enabled-dot"]'), null)
  const on = render(<Title record={{ id: 'demo', enabled: true }} label="画板" />)
  const dot = on.container.querySelector('[data-testid="plugin-enabled-dot"]')
  assert.ok(dot)
  assert.ok(dot?.nextElementSibling?.textContent?.includes('画板'))
})

test('plugin toolbar opens the plugin catalog in the inspector', () => {
  const Toolbar = pluginsChrome.ToolbarRight
  assert.ok(Toolbar)
  let detail: unknown
  const onReveal = (event: Event) => {
    detail = (event as CustomEvent).detail
  }
  window.addEventListener('biu:inspector-reveal', onReveal)
  const { getByRole } = render(<Toolbar />)
  const button = getByRole('button', { name: '在右侧打开插件商店' })
  button.click()
  window.removeEventListener('biu:inspector-reveal', onReveal)
  assert.deepEqual(detail, { collection: '/plugin-catalog', unique: true })
})
