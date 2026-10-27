import { test } from 'vitest'
import assert from 'node:assert/strict'
import { FacetStore } from './facets-store.ts'
import { facetsCollection } from './facets-collection.ts'

test('facetsCollection lists facets with stamp counts and supports create/update/delete', async () => {
  const store = new FacetStore()
  store.replace([{ id: 'dp', label: '动态规划', fields: [{ key: 'complexity', type: 'string' }] }])
  store.indexRecord('/pages', 'home', '首页', ['dp'])
  const spec = facetsCollection(store)
  assert.equal(spec.path, '/facets')
  assert.equal(spec.label, '合集')
  assert.equal(spec.view?.title, '合集')
  assert.equal(spec.view?.icon, 'rectangle-stack')
  const listed = await spec.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.title, '动态规划')
  assert.equal(listed[0]?.fieldCount, 1)
  assert.equal(listed[0]?.stampCount, 1)

  const created = await spec.create!([{ title: 'IO' }])
  assert.equal(created[0]?.id, 'io')
  assert.equal(store.get('io')?.label, 'IO')
  assert.ok(Number(created[0]?.createdAt) > 0)
  assert.ok(Number(created[0]?.updatedAt) >= Number(created[0]?.createdAt))
  const createdAt = Number(created[0]?.createdAt)

  const updated = await spec.update!(created[0]!.id, { title: 'I/O', fields: [{ key: 'format', type: 'string', label: '格式' }] })
  assert.equal(updated.title, 'I/O')
  assert.equal(Number(updated.createdAt), createdAt)
  assert.ok(Number(updated.updatedAt) >= Number(created[0]?.updatedAt))
  assert.equal(updated.fieldCount, 1)
  assert.equal(store.get('io')?.fields[0]?.key, 'format')
  assert.equal(spec.schema.fields.fields?.writable, true)
  assert.match(String(updated.fields), /format/)

  const withNotes = await spec.update!(created[0]!.id, { notes: '# 合集说明\n' })
  assert.equal(withNotes.notes, '# 合集说明\n')
  assert.equal(store.notes('io'), '# 合集说明\n')
  assert.equal(spec.schema.contentField, 'notes')
  store.upsert({ id: 'io', label: 'I/O', fields: [{ key: 'format', type: 'string', label: '格式' }] })
  assert.equal(store.notes('io'), '# 合集说明\n')

  await spec.remove!({ ids: [created[0]!.id] })
  assert.equal(store.get('io'), null)
  assert.equal((await spec.list()).length, 1)

  const specWithTables = facetsCollection(store, () => [{ id: 'pages', path: '/pages', label: '页面' }])
  const collected = await specWithTables.list({ filter: { facetId: 'dp' } })
  assert.equal(collected.length, 1)
  assert.equal(collected[0]?.id, 'pages::home')
  assert.equal(collected[0]?.table, '页面')
  assert.equal(collected[0]?.tablePath, '/pages')
  assert.equal(collected[0]?.sourceId, 'home')
  assert.equal(collected[0]?.facetId, 'dp')
})

test('facet fields reject malformed input instead of wiping existing properties', async () => {
  const store = new FacetStore()
  store.replace([{ id: 'dp', label: '动态规划', fields: [{ key: 'complexity', type: 'string' }] }])
  const spec = facetsCollection(store)
  await assert.rejects(async () => spec.update!('dp', { fields: '[{"key":"a",' }), /JSON 数组/)
  await assert.rejects(async () => spec.update!('dp', { fields: [{ key: 'a', type: 'text' }] }), /unknown field type/)
  assert.equal(store.get('dp')?.fields[0]?.key, 'complexity')
  await spec.update!('dp', { fields: '[{"key":"category","type":"string","label":"类别"}]' })
  assert.equal(store.get('dp')?.fields[0]?.key, 'category')
})

test('批量删除合集遇到不存在的 id 时一个都不删', async () => {
  const store = new FacetStore()
  store.replace([
    { id: 'a', label: 'A', fields: [] },
    { id: 'b', label: 'B', fields: [] },
  ])
  const spec = facetsCollection(store)
  await assert.rejects(async () => spec.remove!({ ids: ['a', 'nope'] }), /unknown 合集: nope/)
  assert.deepEqual(store.list().map((item) => item.id).sort(), ['a', 'b'])
  assert.deepEqual(await spec.remove!({ ids: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(store.list(), [])
})

test('按 label 删除合集会真的删掉，不会假成功', async () => {
  const store = new FacetStore()
  store.replace([{ id: 'dp', label: '动态规划', fields: [] }])
  const spec = facetsCollection(store)
  assert.deepEqual(await spec.remove!({ ids: ['动态规划'] }), ['动态规划'])
  assert.equal(store.get('dp'), null)
  assert.equal(store.get('动态规划'), null)
})

test('合集的贴行不能当作合集删除', async () => {
  const store = new FacetStore()
  store.replace([{ id: 'dp', label: '动态规划', fields: [] }])
  store.indexRecord('/pages', 'home', '首页', ['dp'])
  const spec = facetsCollection(store)
  await assert.rejects(async () => spec.remove!({ ids: ['pages::home'] }), /cannot delete collected row/)
  assert.equal(store.get('dp')?.label, '动态规划')
})
