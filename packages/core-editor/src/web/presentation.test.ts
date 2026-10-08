import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from 'cordis'
import { createElement } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { PagePresentationMinimized, PagePresentationService } from './presentation.tsx'

function registered(service: PagePresentationService, id: string) {
  const inlineTarget = document.createElement('div')
  const host = document.createElement('div')
  document.body.append(inlineTarget)
  const dispose = service.register({
    id,
    plugin: 'demo',
    title: `Demo ${id}`,
    host,
    inlineTarget,
    recordId: `/pages::page::${id}`,
  })
  return { inlineTarget, host, dispose }
}

test('one plugin instance moves between inline sidebar and parking while popout keeps inline host', async () => {
  const opened: string[] = []
  Object.defineProperty(window, 'biuPresentation', {
    configurable: true,
    value: {
      available: true,
      open: async ({ recordId }: { recordId: string }) => opened.push(recordId),
    },
  })
  const ctx = new Context()
  const service = new PagePresentationService(ctx)
  const item = registered(service, 'one')
  assert.equal(item.host.parentElement, item.inlineTarget)

  let requestedPane = ''
  const onTab = (event: Event) => {
    requestedPane = String((event as CustomEvent).detail ?? '')
  }
  window.addEventListener('biu:inspector-tab', onTab)
  service.setMode('one', 'sidebar')
  await Promise.resolve()
  assert.equal(requestedPane, 'page-plugin::one')
  const side = document.createElement('div')
  const detachSide = service.attachTarget('one', side)
  assert.equal(item.host.parentElement, side)

  service.setMode('one', 'minimized')
  assert.equal(item.host.parentElement?.hasAttribute('data-page-presentation-parking'), true)
  service.restore('one')
  assert.equal(service.snapshot('one')?.mode, 'sidebar')
  assert.equal(item.host.parentElement, side)

  service.setMode('one', 'inline')
  await service.openDetached('one')
  assert.deepEqual(opened, ['/pages::page::one'])
  assert.equal(service.snapshot('one')?.mode, 'inline')
  assert.equal(service.snapshot('one')?.detached, true)
  assert.equal(item.host.parentElement, item.inlineTarget)
  service.setMode('one', 'inline')
  assert.equal(item.host.parentElement, item.inlineTarget)

  detachSide()
  item.dispose()
  item.inlineTarget.remove()
  window.removeEventListener('biu:inspector-tab', onTab)
  Reflect.deleteProperty(window, 'biuPresentation')
})

test('multiple plugins can open independent windows without changing inline mode', async () => {
  Object.defineProperty(window, 'biuPresentation', {
    configurable: true,
    value: { available: true, open: async () => undefined },
  })
  const ctx = new Context()
  const service = new PagePresentationService(ctx)
  const first = registered(service, 'first')
  const second = registered(service, 'second')
  await service.openDetached('first')
  await service.openDetached('second')
  assert.equal(service.snapshot('first')?.mode, 'inline')
  assert.equal(service.snapshot('first')?.detached, true)
  assert.equal(service.snapshot('second')?.mode, 'inline')
  assert.equal(service.snapshot('second')?.detached, true)
  first.dispose()
  second.dispose()
  first.inlineTarget.remove()
  second.inlineTarget.remove()
  Reflect.deleteProperty(window, 'biuPresentation')
})

test('minimized presentation shows plugin content and restores on demand', () => {
  let restored = 0
  const { getByTestId, getByRole } = render(
    createElement(
      PagePresentationMinimized,
      { title: '默认标题', onRestore: () => restored += 1 },
      createElement('span', { 'data-testid': 'plugin-minimized-content' }, '最近一次查询：12 行'),
    ),
  )
  assert.equal(getByTestId('plugin-minimized-content').textContent, '最近一次查询：12 行')
  fireEvent.click(getByRole('button', { name: '展开' }))
  assert.equal(restored, 1)
})

test('minimized presentation falls back to its title', () => {
  const { getByText } = render(
    createElement(PagePresentationMinimized, { title: '终端', onRestore: () => undefined }),
  )
  assert.ok(getByText('终端'))
})
