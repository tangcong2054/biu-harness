import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { openAndMigrateBiu, runWithAccount } from '@biu/host-plugin-loader/data-dir'
import { CollabStore } from './store.ts'
import { workspaceMembersCollection } from './workspace-members-collection.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('workspace members collection lists and manages only the active workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-members-collection-'))
  dirs.push(dir)
  const store = new CollabStore(openAndMigrateBiu(join(dir, 'biu.sqlite')))
  const ada = store.register('', Date.now(), 'secret1', 'ada@example.com')
  const bob = store.register('', Date.now(), 'secret1', 'bob@example.com')
  const cara = store.register('', Date.now(), 'secret1', 'cara@example.com')
  const workspace = store.createWorkspace(ada.id, 'Product')
  store.addMemberByEmail(ada.id, workspace.id, bob.email)
  store.setActive(ada.id, workspace.id)
  store.setActive(bob.id, workspace.id)
  const collection = workspaceMembersCollection(store)
  assert.equal(collection.records?.update, true)
  assert.equal(typeof collection.update, 'function')
  assert.deepEqual(collection.schema.fields.role.enumLabels, {
    owner: '所有者',
    admin: '管理者',
    member: '编辑者',
    viewer: '查看者',
  })
  assert.equal(collection.schema.fields.email.writable, undefined)

  const before = await runWithAccount(ada.id, () => collection.list())
  assert.deepEqual(before.map((row) => row.email).sort(), ['ada@example.com', 'bob@example.com'])

  const created = await runWithAccount(ada.id, () => collection.create!([{ email: cara.email }]))
  assert.equal(created[0]?.email, cara.email)
  store.setActive(cara.id, workspace.id)
  assert.deepEqual(
    (await runWithAccount(cara.id, () => collection.list())).map((row) => row.email).sort(),
    ['ada@example.com', 'bob@example.com', 'cara@example.com'],
  )

  const promoted = await runWithAccount(ada.id, () => collection.update!(bob.id, { role: 'admin' }))
  assert.equal(promoted.role, 'admin')
  const viewer = await runWithAccount(ada.id, () => collection.update!(bob.id, { role: 'viewer' }))
  assert.equal(viewer.role, 'viewer')
  await assert.rejects(
    () => runWithAccount(bob.id, () => collection.update!(cara.id, { role: 'admin' })),
    /只有所有者可以这样做/,
  )
  await assert.rejects(
    () => runWithAccount(bob.id, () => collection.remove!({ ids: [cara.id] })),
    /所有者或管理员/,
  )
  assert.notEqual(await runWithAccount(ada.id, () => collection.get(cara.id)), null)
})

test('a device-only workspace exposes no member collection or mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-local-members-collection-'))
  dirs.push(dir)
  const store = new CollabStore(openAndMigrateBiu(join(dir, 'biu.sqlite')))
  const ada = store.register('', Date.now(), 'secret1', 'local-ada@example.com')
  const workspace = store.createWorkspace(ada.id, 'Private device')
  store.setActive(ada.id, workspace.id)
  const collection = workspaceMembersCollection(store, () => false, false)

  assert.equal(collection.view, undefined)
  assert.deepEqual(await runWithAccount(ada.id, () => collection.list()), [])
  await assert.rejects(
    () => runWithAccount(ada.id, () => collection.create!([{ email: 'nobody@example.com' }])),
    /本机空间不提供成员功能/,
  )
})

test('online member collection uses only MySQL and the request workspace', async () => {
  const { runWithRequestWorkspace } = await import('@biu/host-plugin-loader/data-dir')
  const calls: string[] = []
  const rows = [
    { id: 'ada', name: 'Ada', display_name: '', email: 'ada@example.test', role: 'owner', member_kind: 'member' as const, created_at: 1 },
  ]
  const local = new Proxy({}, { get() { throw new Error('local account replica must not be read') } }) as CollabStore
  const mysql = {
    async members(actor: string, ws: string) { calls.push(`list:${actor}:${ws}`); return rows },
    async addMemberByEmail(actor: string, ws: string, email: string) {
      calls.push(`add:${actor}:${ws}:${email}`)
      rows.push({ id: 'bob', name: 'Bob', display_name: '', email, role: 'member', member_kind: 'member', created_at: 2 })
      return rows
    },
    async updateMemberRole(actor: string, ws: string, id: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
      calls.push(`update:${actor}:${ws}:${id}`)
      rows.find((r) => r.id === id)!.role = role
    },
    async removeMember(actor: string, ws: string, id: string) {
      calls.push(`remove:${actor}:${ws}:${id}`)
      rows.splice(rows.findIndex((r) => r.id === id), 1)
    },
  }
  const spec = workspaceMembersCollection(local, () => true, true, mysql)
  const asOwner = <T,>(fn: () => T) => runWithAccount('ada', () => runWithRequestWorkspace('ws_mysql', fn))
  assert.deepEqual((await asOwner(() => spec.list())).map((r) => r.id), ['ada'])
  assert.equal((await asOwner(() => spec.create!([{ email: 'bob@example.test' }])))[0]?.title, 'Bob')
  assert.equal((await asOwner(() => spec.update!('bob', { role: 'viewer' }))).role, 'viewer')
  await asOwner(() => spec.remove!({ ids: ['bob'] }))
  assert.equal((await asOwner(() => spec.get!('bob'))), null)
  assert.ok(calls.every((call) => call.includes(':ada:ws_mysql')))
  await assert.rejects(async () => runWithAccount('ada', () => spec.list()), /UNAUTHENTICATED/)
})
