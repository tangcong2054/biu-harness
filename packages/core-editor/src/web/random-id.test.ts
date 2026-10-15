import assert from 'node:assert/strict'
import { test } from 'vitest'
import { installInsecureRandomUUID, randomUUID } from './random-id.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('randomUUID still works when the secure-context API is missing', () => {
  const cryptoObj = globalThis.crypto
  const original = cryptoObj.randomUUID
  Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, writable: true, value: undefined })
  try {
    assert.match(randomUUID(), UUID)
    installInsecureRandomUUID()
    assert.equal(typeof cryptoObj.randomUUID, 'function')
    assert.match(cryptoObj.randomUUID(), UUID)
  } finally {
    Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, writable: true, value: original })
  }
})
