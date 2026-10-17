import assert from 'node:assert/strict'
import { test } from 'vitest'
import { sessionProjectForClient } from './index.ts'

test('online sessions expose a managed cloud workspace instead of a server path', () => {
  const previous = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '1'
  try {
    assert.deepEqual(
      sessionProjectForClient({
        project: { name: 'legacy-server-path', path: '/srv/private', boundAt: 12 },
        config: { createdAt: 42 },
      }),
      { name: '云端工作区', boundAt: 42, managed: true },
    )
  } finally {
    if (previous === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previous
  }
})

test('offline sessions keep their explicitly bound local folder', () => {
  const previous = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '0'
  const project = { name: 'local-app', path: '/Users/example/app', boundAt: 12 }
  try {
    assert.deepEqual(sessionProjectForClient({ project }), project)
  } finally {
    if (previous === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previous
  }
})
