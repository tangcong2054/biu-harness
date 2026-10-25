import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { PageEditorService } from './service.ts'
import { parsePageBlockRowData, PageBlocksView, PageBlockContent, PageBlockStage, openSourcePage, openBlockInInspector, pageLabelOf, pageNameFromRecord, mergeLiveBlockData, persistBlockDataPatch } from './page-blocks-view.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('parsePageBlockRowData reads json string or object', () => {
  assert.deepEqual(parsePageBlockRowData('{"html":"<p>a</p>"}'), { html: '<p>a</p>' })
  assert.deepEqual(parsePageBlockRowData({ html: '<p>b</p>' }), { html: '<p>b</p>' })
  assert.deepEqual(parsePageBlockRowData(''), {})
})

test('live block data keeps the record title and does not persist a stale one', () => {
  const live = mergeLiveBlockData({ title: '旧名', sid: 's1' }, { history: [] }, { title: '新名' })
  assert.equal(live.title, '新名')
  assert.deepEqual(live.history, [])
  assert.deepEqual(persistBlockDataPatch(live, { history: [] }), { sid: 's1', history: [] })
})

test('page-blocks view paints the registered block View', async () => {
  const ctx = new Context()
  new PageEditorService(ctx)
  ctx.pageEditor.registerBlock({
    kind: 'html',
    plugin: 'page-html-blocks',
    label: '静态HTML',
    View: ({ data }) => <div data-testid="html-ui">{String(data.html ?? '')}</div>,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input)
      if (url.includes('pages%2Fp1') || url.includes('/pages/p1')) return { ok: true, json: async () => ({ value: { id: 'p1', title: '首页' } }) }
      return { ok: true, json: async () => ({}) }
    }),
  )
  const opened: string[] = []
  const { container } = render(
    <PageBlocksView
      path="/page-blocks"
      rows={[
        { id: 'p1::a1', title: '刊头', pageId: 'p1', blockKind: 'html', plugin: 'page-html-blocks', data: '{"html":"<b>hi</b>"}' },
        { id: 'p1::a2', title: '缺插件', blockKind: 'gone', plugin: 'missing-plugin', data: '{}' },
      ]}
      onOpen={(row) => opened.push(String(row.id))}
    />,
  )
  assert.equal(container.querySelector('[data-testid="html-ui"]')?.textContent, '<b>hi</b>')
  assert.equal(container.querySelector('[data-testid="html-ui"]')?.getAttribute('data-biu-plugin'), 'page-html-blocks')
  assert.ok(container.querySelector('[data-testid="page-block-missing"]'))
  await waitFor(() => assert.equal(container.querySelector('[data-testid="page-blocks-view-page"]')?.textContent, '首页'))
  fireEvent.click(container.querySelector('[data-testid="page-blocks-view-zoom"]')!)
  assert.deepEqual(opened, ['p1::a1'])
  const seen: unknown[] = []
  const onReveal = (event: Event) => seen.push((event as CustomEvent).detail)
  window.addEventListener('biu:inspector-reveal', onReveal)
  fireEvent.click(container.querySelector('[data-testid="page-blocks-view-inspector"]')!)
  window.removeEventListener('biu:inspector-reveal', onReveal)
  assert.deepEqual(seen, [{ collection: '/page-blocks', recordId: 'p1::a1', unique: true }])
  const title = container.querySelector('[data-testid="page-blocks-view-title"]') as HTMLInputElement
  fireEvent.change(title, { target: { value: '新刊头' } })
  fireEvent.blur(title)
  await waitFor(() => {
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    assert.ok(
      calls.some((item) => String(item[0]).includes('/api/db/update') && String(item[1]?.body ?? '').includes('新刊头')),
    )
  })
})

test('gallery page label is the page title, never the id', () => {
  assert.equal(pageLabelOf({ id: 'p1::a', pageId: 'p1', pageTitle: '首页' }), '首页')
  assert.equal(pageLabelOf({ id: 'p1::a', pageId: 'p1', pageTitle: 'p1' }), '')
  assert.equal(pageLabelOf({ id: 'p1::a', pageId: 'p1' }, '手册'), '手册')
  assert.equal(pageNameFromRecord({ id: 'p1', title: '首页' }, 'p1'), '首页')
  assert.equal(pageNameFromRecord({ id: 'p1', title: 'p1' }, 'p1'), '')
})

test('opening a block in the inspector reveals /page-blocks', () => {
  const seen: unknown[] = []
  const onReveal = (event: Event) => seen.push((event as CustomEvent).detail)
  window.addEventListener('biu:inspector-reveal', onReveal)
  openBlockInInspector('p1::a1')
  window.removeEventListener('biu:inspector-reveal', onReveal)
  assert.deepEqual(seen, [{ collection: '/page-blocks', recordId: 'p1::a1', unique: true }])
})

test('opening the source page reveals /pages in the inspector', () => {
  const seen: unknown[] = []
  const onReveal = (event: Event) => seen.push((event as CustomEvent).detail)
  window.addEventListener('biu:inspector-reveal', onReveal)
  openSourcePage('p1')
  window.removeEventListener('biu:inspector-reveal', onReveal)
  assert.deepEqual(seen, [{ collection: '/pages', recordId: 'p1', unique: true }])
})

test('component gallery can scroll inside the collection stage', () => {
  const css = readFileSync(resolve(import.meta.dirname, './style.ts'), 'utf8')
  assert.match(css, /\.page-blocks-view\{[^}]*min-height:0/)
  assert.match(css, /\.page-blocks-view\{[^}]*overflow:auto/)
  assert.match(css, /\.page-blocks-view-head\{[^}]*display:flex/)
  assert.match(css, /\.page-blocks-view-meta\{[^}]*margin-left:auto/)
})

test('gallery block writes notify other surfaces', () => {
  const src = readFileSync(resolve(import.meta.dirname, './page-blocks-view.tsx'), 'utf8')
  assert.match(src, /window.dispatchEvent\(new Event\('fsdb:change'\)\)/)
  assert.match(src, /bindPageBlockPlugin/)
})

test('page-block detail content paints the registered View', () => {
  const ctx = new Context()
  new PageEditorService(ctx)
  ctx.pageEditor.registerBlock({
    kind: 'html',
    plugin: 'page-html-blocks',
    label: '静态HTML',
    View: ({ data }) => <div data-testid="html-detail">{String(data.html ?? '')}</div>,
  })
  const { container } = render(
    <PageBlockContent
      record={{ id: 'p1::a1', title: '刊头', blockKind: 'html', plugin: 'page-html-blocks' }}
      field="data"
      spec={{ type: 'string', writable: true }}
      value={{ html: '<i>detail</i>' }}
      writable
    />,
  )
  assert.ok(container.querySelector('[data-testid="page-blocks-detail"]'))
  assert.equal(container.querySelector('[data-testid="html-detail"]')?.textContent, '<i>detail</i>')
})

test('block data that fails to save rolls back and tells the user', async () => {
  const ctx = new Context()
  new PageEditorService(ctx)
  ctx.pageEditor.registerBlock({
    kind: 'counter',
    plugin: 'counter-block',
    label: '计数',
    View: ({ data, update }) => (
      <button type="button" data-testid="counter" onClick={() => update({ n: Number(data.n ?? 0) + 1 })}>
        {String(data.n ?? 0)}
      </button>
    ),
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, statusText: 'Forbidden', json: async () => ({ error: '只读成员' }) })))
  const { container, findByRole } = render(
    <PageBlockStage row={{ id: 'p1::c1', title: '计数', blockKind: 'counter', plugin: 'counter-block', data: '{"n":1}' }} />,
  )
  const button = () => container.querySelector('[data-testid="counter"]') as HTMLButtonElement
  assert.equal(button().textContent, '1')
  fireEvent.click(button())
  assert.equal(button().textContent, '2')
  const alert = await findByRole('alert')
  assert.match(alert.textContent ?? '', /只读成员/)
  assert.equal(button().textContent, '1')
})

test('block title that fails to save goes back to the stored title', async () => {
  const ctx = new Context()
  new PageEditorService(ctx)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    if (String(input).includes('/api/db/update')) return { ok: false, statusText: 'Forbidden', json: async () => ({ error: '只读成员' }) }
    return { ok: true, json: async () => ({}) }
  }))
  const { container, findByRole } = render(
    <PageBlocksView path="/page-blocks" rows={[{ id: 'p1::a1', title: '刊头', blockKind: 'html', data: '{}' }]} onOpen={() => {}} />,
  )
  const title = container.querySelector('[data-testid="page-blocks-view-title"]') as HTMLInputElement
  fireEvent.change(title, { target: { value: '新刊头' } })
  fireEvent.blur(title)
  assert.match((await findByRole('alert')).textContent ?? '', /只读成员/)
  assert.equal((container.querySelector('[data-testid="page-blocks-view-title"]') as HTMLInputElement).value, '刊头')
})
