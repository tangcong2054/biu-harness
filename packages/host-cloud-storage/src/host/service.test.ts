import { Context } from 'cordis'
import { expect, test } from 'vitest'
import { CloudStorageService } from './service.ts'

test('defaults to an inert SQLite backend', async () => {
  const previous = process.env.BIU_STORAGE_BACKEND
  delete process.env.BIU_STORAGE_BACKEND
  const ctx = new Context()
  try {
    const service = new CloudStorageService(ctx)
    expect(service.backend).toBe('sqlite')
    expect(await service.health()).toEqual({ backend: 'sqlite', mysql: false })
  } finally {
    if (previous === undefined) delete process.env.BIU_STORAGE_BACKEND
    else process.env.BIU_STORAGE_BACKEND = previous
    await ctx.fiber.dispose()
  }
})

test('enables mysql-only runtime after repositories are migrated', async () => {
  const previous = {
    backend: process.env.BIU_STORAGE_BACKEND,
    online: process.env.BIU_ONLINE,
    url: process.env.BIU_MYSQL_URL,
  }
  process.env.BIU_STORAGE_BACKEND = 'mysql'
  process.env.BIU_ONLINE = '1'
  process.env.BIU_MYSQL_URL = 'mysql://test:test@127.0.0.1:3306'
  const ctx = new Context()
  try {
    const service = new CloudStorageService(ctx)
    expect(service.backend).toBe('mysql')
    expect(service.pool).not.toBeNull()
  } finally {
    if (previous.backend === undefined) delete process.env.BIU_STORAGE_BACKEND
    else process.env.BIU_STORAGE_BACKEND = previous.backend
    if (previous.online === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previous.online
    if (previous.url === undefined) delete process.env.BIU_MYSQL_URL
    else process.env.BIU_MYSQL_URL = previous.url
    await ctx.fiber.dispose()
  }
})
