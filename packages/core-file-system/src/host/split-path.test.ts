import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from 'cordis'
import { REQUIRED_RECORD_FIELDS, type DbRecord } from '@biu/type-file-system'
import { DatabaseService } from './index.ts'

/**
 * 记录 id 可能自带斜杠。以前 host 的 splitPath 只给 /page-blocks// 和 /views 开了特例，
 * 其它集合遇到带斜杠的 id 会被 filter(Boolean) 吃掉前导空段或切成多段，读写都 404。
 */
test('record ids with leading or inner slashes resolve in any collection', async () => {
  const db = new DatabaseService(new Context())
  const rows: DbRecord[] = [
    { id: '/pages::p1::c1', title: '组件' },
    { id: 'group/inner', title: '带斜杠' },
    { id: 'plain', title: '普通' },
  ]
  db.register({
    id: 'components',
    path: '/components',
    label: '组件',
    schema: { labelField: 'title', fields: { ...REQUIRED_RECORD_FIELDS, title: { type: 'string', writable: true } } },
    records: { update: true },
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id) ?? null,
    update: (id, patch) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index < 0) throw new Error('unknown')
      rows[index] = { ...rows[index]!, ...patch, id }
      return rows[index]!
    },
  })
  const read = async (path: string) => (await db.read(path)) as { value?: { id?: string } }
  assert.equal((await read('/components//pages::p1::c1')).value?.id, '/pages::p1::c1')
  assert.equal((await read('/components/group/inner')).value?.id, 'group/inner')
  assert.equal((await read('/components/plain')).value?.id, 'plain')
  await db.update('/components//pages::p1::c1', { title: '改名' })
  assert.equal(rows[0]?.title, '改名')
  // 集合本身仍能列出。
  assert.equal((await db.list('/components')).total, 3)
})
