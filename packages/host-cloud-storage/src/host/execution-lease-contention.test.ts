import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAccountRepository, isLeaseContention } from './mysql-account-repositories.ts'

/**
 * 回归点：两台设备同时接管同一个云端会话时，InnoDB 会把其中一方判成死锁（ER_LOCK_DEADLOCK）。
 * 以前只识别 ER_DUP_ENTRY，死锁落到 HTTP 400 + 原始「Deadlock found…」报错。
 * 这里用替身连接走真实的 acquireExecutionLease 代码，不需要 MySQL。
 */

function mysqlError(code: string, errno: number) {
  return Object.assign(new Error(`${code} from mysql`), { code, errno })
}

function fakePool(failOn: 'select' | 'insert', error: Error) {
  const calls: string[] = []
  const connection = {
    async beginTransaction() {
      calls.push('begin')
    },
    async query(sql: string) {
      const verb = sql.trim().split(/\s+/)[0]!.toUpperCase()
      calls.push(verb)
      if (failOn === 'select' && verb === 'SELECT') throw error
      if (failOn === 'insert' && verb === 'INSERT') throw error
      return [verb === 'SELECT' ? [] : { affectedRows: 1 }]
    },
    async commit() {
      calls.push('commit')
    },
    async rollback() {
      calls.push('rollback')
    },
    release() {
      calls.push('release')
    },
  }
  const pool = { getConnection: async () => connection } as unknown as Pool
  return { pool, calls }
}

describe('acquireExecutionLease under contention', () => {
  it.each([
    ['ER_LOCK_DEADLOCK', 1213, 'insert'],
    ['ER_DUP_ENTRY', 1062, 'insert'],
    ['ER_LOCK_WAIT_TIMEOUT', 1205, 'select'],
  ] as const)('%s is reported as 409 "already running", and the transaction is rolled back', async (code, errno, failOn) => {
    const { pool, calls } = fakePool(failOn, mysqlError(code, errno))
    const repo = new MysqlAccountRepository(pool, 'biu_test')
    await expect(repo.acquireExecutionLease('acc_b', 'sess_1', 'desktop', 90_000, 1_000)).rejects.toMatchObject({
      status: 409,
      message: '这个会话正在由另一台设备运行',
    })
    expect(calls).toContain('rollback')
    expect(calls).not.toContain('commit')
    expect(calls.at(-1)).toBe('release')
  })

  it('other database errors are not disguised as contention', async () => {
    const { pool, calls } = fakePool('insert', mysqlError('ER_NO_SUCH_TABLE', 1146))
    const repo = new MysqlAccountRepository(pool, 'biu_test')
    const error = await repo.acquireExecutionLease('acc_b', 'sess_1', 'desktop', 90_000, 1_000).catch((reason) => reason)
    expect(error).toMatchObject({ code: 'ER_NO_SUCH_TABLE' })
    expect((error as { status?: number }).status).toBeUndefined()
    expect(calls).toContain('rollback')
  })

  it('isLeaseContention only matches lock contention codes', () => {
    expect(isLeaseContention(mysqlError('ER_LOCK_DEADLOCK', 1213))).toBe(true)
    expect(isLeaseContention(mysqlError('ER_DUP_ENTRY', 1062))).toBe(true)
    expect(isLeaseContention(mysqlError('ER_LOCK_WAIT_TIMEOUT', 1205))).toBe(true)
    expect(isLeaseContention(mysqlError('ER_PARSE_ERROR', 1064))).toBe(false)
    expect(isLeaseContention(null)).toBe(false)
    expect(isLeaseContention(new Error('plain'))).toBe(false)
  })
})
