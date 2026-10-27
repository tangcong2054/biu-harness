import { test } from 'vitest'
import assert from 'node:assert/strict'
import { deliverSessionChoices, type DeliverSessionChoice } from './deliver-session.ts'

function session(patch: Partial<DeliverSessionChoice> & Pick<DeliverSessionChoice, 'id'>): DeliverSessionChoice {
  return {
    title: patch.id,
    updatedAt: 0,
    ...patch,
  }
}

test('deliver picker keeps sessions in the open session project', () => {
  const choices = deliverSessionChoices(
    [
      session({ id: 'old', title: '旧的', updatedAt: 1, projectPath: '/repo/a', projectName: 'a' }),
      session({ id: 'now', title: '当前', updatedAt: 3, projectPath: '/repo/biu', projectName: 'biu' }),
      session({ id: 'other', title: '别的项目', updatedAt: 9, projectPath: '/repo/other', projectName: 'other' }),
      session({ id: 'peer', title: '同项目', updatedAt: 2, projectPath: '/repo/biu', projectName: 'biu' }),
    ],
    'now',
  )
  assert.equal(choices.projectPath, '/repo/biu')
  assert.equal(choices.projectName, 'biu')
  assert.deepEqual(choices.sessions.map((item) => item.id), ['now', 'peer'])
})

test('deliver picker lists every session when the open one has no project', () => {
  const choices = deliverSessionChoices(
    [
      session({ id: 'loose', title: '未绑定', updatedAt: 1 }),
      session({ id: 'bound', title: '有项目', updatedAt: 4, projectPath: '/repo/biu', projectName: 'biu' }),
    ],
    'loose',
  )
  assert.equal(choices.projectPath, '')
  assert.equal(choices.projectName, '')
  assert.deepEqual(choices.sessions.map((item) => item.id), ['bound', 'loose'])
})

test('deliver picker uses the folder name when the project has no display name', () => {
  const choices = deliverSessionChoices(
    [session({ id: 'now', updatedAt: 1, projectPath: '/Users/me/biu-harness' })],
    'now',
  )
  assert.equal(choices.projectName, 'biu-harness')
})
