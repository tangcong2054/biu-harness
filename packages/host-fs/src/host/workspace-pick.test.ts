import { test } from 'vitest'
import assert from 'node:assert/strict'
import { macFolderPickOutcome } from './workspace-pick.ts'

test('cancelling the folder dialog is not a reason to open another one', () => {
  assert.equal(macFolderPickOutcome(''), 'cancel')
  assert.equal(macFolderPickOutcome('\n'), 'cancel')
})

test('a bad default location can fall back to a second dialog', () => {
  assert.equal(macFolderPickOutcome('ERR:-1700:Cannot make some data into the expected type.'), 'retry')
})

test('a chosen folder path is returned once', () => {
  assert.deepEqual(macFolderPickOutcome('/Users/tangcong/Documents/UGit/biu-harness/\n'), {
    path: '/Users/tangcong/Documents/UGit/biu-harness',
  })
})
