import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { Context, Service } from 'cordis'
import { AccountService } from './index.ts'

/**
 * 回归点：执行租约以前只写本机 SQLite。Online 多实例部署时，A 实例发出的租约 B 实例看不到，
 * 「会话正在桌面设备上运行」的保护失效，同一会话可能被两处同时驱动。
 */

const dirs: string[] = []
let previousOnline: string | undefined

beforeEach(() => {
  previousOnline = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '1'
})

afterEach(() => {
  if (previousOnline === undefined) delete process.env.BIU_ONLINE
  else process.env.BIU_ONLINE = previousOnline
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一张「云端」租约表，两台实例共用。 */
function sharedLeaseRepository() {
  const leases = new Map<string, { accountId: string; leaseId: string; executorId: string }>()
  let seq = 0
  return {
    async acquireExecutionLease(accountId: string, sessionId: string, executorId: string) {
      const held = leases.get(sessionId)
      if (held) throw Object.assign(new Error(`这个会话正在由 ${held.executorId} 运行`), { status: 409 })
      const leaseId = `lease_${++seq}`
      leases.set(sessionId, { accountId, leaseId, executorId })
      return { leaseId, sessionId, expiresAt: Date.now() + 90_000 }
    },
    async renewExecutionLease(accountId: string, sessionId: string, leaseId: string) {
      const held = leases.get(sessionId)
      if (!held || held.accountId !== accountId || held.leaseId !== leaseId) {
        throw Object.assign(new Error('执行租约已失效'), { status: 409 })
      }
      return { leaseId, sessionId, expiresAt: Date.now() + 90_000 }
    },
    async requireExecutionLease(accountId: string, sessionId: string, leaseId: string) {
      const held = leases.get(sessionId)
      if (!held || held.accountId !== accountId || held.leaseId !== leaseId) {
        throw Object.assign(new Error('执行租约不存在或已失效'), { status: 409 })
      }
    },
    async releaseExecutionLease(accountId: string, sessionId: string, leaseId: string) {
      const held = leases.get(sessionId)
      if (held && held.accountId === accountId && held.leaseId === leaseId) leases.delete(sessionId)
      return { ok: true }
    },
    async hasExecutionLease(sessionId: string) {
      return leases.has(sessionId)
    },
  }
}

function instance(repository: ReturnType<typeof sharedLeaseRepository>) {
  const dir = mkdtempSync(join(tmpdir(), 'biu-lease-'))
  dirs.push(dir)
  const ctx = new Context()
  class CloudStorage extends Service {
    accountMode = 'mysql' as const
    accountRepository = repository
    constructor(inner: Context) {
      super(inner, 'cloudStorage')
    }
  }
  new CloudStorage(ctx)
  // 每台实例各有一份本机 SQLite；租约不能只写在这里。
  return new AccountService(ctx, { sqlitePath: join(dir, 'biu.sqlite') })
}

test('execution leases are shared across Online instances on the MySQL control plane', async () => {
  const repository = sharedLeaseRepository()
  const a = instance(repository)
  const b = instance(repository)
  const lease = await a.acquireExecutionLease('ada', 's1', 'ada-laptop')
  assert.equal(await b.hasExecutionLease('s1'), true)
  await assert.rejects(() => b.acquireExecutionLease('ada', 's1', 'ada-desktop'), /ada-laptop/)
  await b.renewExecutionLease('ada', 's1', lease.leaseId)
  await b.requireExecutionLease('ada', 's1', lease.leaseId)
  await b.releaseExecutionLease('ada', 's1', lease.leaseId)
  assert.equal(await a.hasExecutionLease('s1'), false)
  // 本机 SQLite 没有被当成权威写入。
  assert.equal(a.store.hasExecutionLease('s1'), false)
})
