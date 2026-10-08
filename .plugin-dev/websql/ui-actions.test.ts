import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, './web.tsx'), 'utf8')

test('WebSQL exposes semantic UI actions without importing host packages', () => {
  assert.match(source, /inject = \['pageEditor', 'uiActions'\]/)
  assert.match(source, /uiActions\.register/)
  assert.match(source, /set_sql/)
  assert.match(source, /execute/)
  assert.match(source, /read_result/)
  assert.match(source, /risk: 'submit'/)
  assert.doesNotMatch(source, /@biu\/core-ui-actions/)
})

test('WebSQL UI state never exposes the in-memory password', () => {
  const registration = source.slice(source.indexOf('uiActions.register'), source.indexOf('const block ='))
  assert.doesNotMatch(registration, /password:\s*current\.password/)
  assert.doesNotMatch(registration, /password:\s*sharedRef/)
})
