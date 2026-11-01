/** @vitest-environment node */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool, type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionRecord } from '@biu/type-session'
import { MysqlSessionStore } from './mysql-session-store.ts'
import { PRODUCT_MIGRATIONS } from '../../../host-cloud-storage/src/host/migrations.ts'
import { runMysqlMigrations } from '../../../host-cloud-storage/src/host/runner.ts'

const testUrl = process.env.BIU_MYSQL_PROJECTION_TEST_URL
/** 设为 1 时直接使用连接串里已授权的空库（不建库删库），结束时只删除本次建的表。 */
const useExistingDatabase = process.env.BIU_MYSQL_PROJECTION_TEST_EXISTING === '1'

test('projection query binds candidates and never treats an empty candidate set as unrestricted', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const store = new MysqlSessionStore({
    query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return [[], []] },
  } as never, 'biu_test', true)
  assert.deepEqual(await store.listSummaries({ sessionIds: [] }), [])
  assert.equal(calls.length, 0)
  const id = "session' OR 1=1 --"
  await store.listSummaries({ sessionIds: [id, id, 'other'] })
  assert.deepEqual(calls[0].values, [id, 'other'])
  assert.ok(calls[0].sql.includes('WHERE s.id IN (?, ?)'))
  assert.ok(!calls[0].sql.includes(id))
  assert.ok(!calls[0].sql.includes('GROUP BY'))
  assert.ok(calls[0].sql.includes('CASE WHEN s.event_times_ready = 1'))
})

describe.skipIf(!testUrl)('MySQL event-time projection in an isolated database', () => {
  let pool: Pool
  let database: string
  let fast: MysqlSessionStore
  let legacy: MysqlSessionStore
  let created = false

  beforeAll(async () => {
    const url = new URL(testUrl!)
    database = url.pathname.slice(1)
    if (useExistingDatabase) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('Plain test database name required')
      pool = createPool({ uri: url.toString(), connectionLimit: 5 })
      const [tables] = await pool.query(
        'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?', [database],
      )
      if ((tables as unknown[]).length) throw new Error(`${database} must be empty for the projection test`)
    } else {
      if (!/^biu_summary_test_[a-z0-9_]+$/.test(database)) throw new Error('Disposable test database required')
      url.pathname = '/'
      pool = createPool({ uri: url.toString(), connectionLimit: 5 })
      await pool.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    }
    created = true
    await pool.query(`CREATE TABLE \`${database}\`.sessions (
      id VARCHAR(128) PRIMARY KEY, version BIGINT NOT NULL, project_json LONGTEXT NULL,
      mascot_json LONGTEXT NULL, config_json LONGTEXT NULL, event_count BIGINT NOT NULL DEFAULT 0,
      title LONGTEXT NOT NULL, updated_at BIGINT NOT NULL) ENGINE=InnoDB`)
    await pool.query(`CREATE TABLE \`${database}\`.events (
      session_id VARCHAR(128) NOT NULL, seq BIGINT NOT NULL, ts BIGINT NOT NULL,
      type VARCHAR(128) COLLATE utf8mb4_bin NOT NULL, event_json LONGTEXT NOT NULL,
      PRIMARY KEY(session_id, seq), KEY event_times(session_id,type,ts)) ENGINE=InnoDB`)
    await runMysqlMigrations(pool, database, PRODUCT_MIGRATIONS.filter(m => m.version === 14))
    fast = new MysqlSessionStore(pool, database, true)
    legacy = new MysqlSessionStore(pool, database, false)
  })

  afterAll(async () => {
    try {
      if (created && useExistingDatabase) {
        for (const table of ['events', 'sessions', 'schema_migrations']) {
          await pool.query(`DROP TABLE IF EXISTS \`${database}\`.\`${table}\``)
        }
      } else if (created) {
        await pool.query(`DROP DATABASE \`${database}\``)
      }
    } finally {
      await pool?.end()
    }
  })

  const record = (times: number[], createdAt?: number): SessionRecord => ({
    id: randomUUID(), version: SESSION_FORMAT_VERSION,
    ...(createdAt === undefined ? {} : { config: { createdAt, title: 'test' } }),
    events: times.map((ts, seq) => seq === 0
      ? { type: 'session/open', version: SESSION_FORMAT_VERSION, seq, ts }
      : { type: 'user/message', kind: 'wake', text: 'test', seq, ts }) as SessionEvent[],
  })
  const equivalent = async () => {
    const normalize = (rows: Awaited<ReturnType<MysqlSessionStore['listSummaries']>>) => rows.sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(normalize(await fast.listSummaries()), normalize(await legacy.listSummaries()))
  }
  const ready = async (id: string) => {
    const [rows] = await pool.execute(`SELECT event_times_ready FROM \`${database}\`.sessions WHERE id=?`, [id])
    return Number((rows as Array<{ event_times_ready: number }>)[0]?.event_times_ready)
  }

  test('empty, no-user, unordered timestamps, zero/negative timestamps and createdAt fallbacks', async () => {
    for (const item of [record([]), record([50]), record([90, 70, 10, 40]), record([0, -5]), record([90, 120], 15)]) {
      await fast.save(item)
      assert.equal(await ready(item.id), 1)
      await equivalent()
    }
  })

  test('append, replace, truncate, metadata changes, fork and clear preserve old summary semantics', async () => {
    const item = record([50, 70])
    await fast.save(item)
    await fast.append(item.id, { type: 'user/message', kind: 'wake', text: 'earlier' }, 10)
    await fast.append(item.id, { type: 'assistant/chunk', text: 'later' }, 200)
    await equivalent()
    const loaded = (await fast.load(item.id))!
    const fork = { ...loaded, id: randomUUID() }
    await fast.save(fork)
    await equivalent()
    const shortened = { ...loaded, events: loaded.events.slice(0, 2) }
    await fast.save(shortened)
    await equivalent()
    shortened.events[1] = { ...shortened.events[1], ts: 300 }
    await fast.save(shortened)
    await equivalent()
    shortened.config = { title: 'renamed', createdAt: 1 }
    await fast.save(shortened)
    await equivalent()
    await fast.deleteEvents(item.id)
    assert.equal(await ready(item.id), 1)
    await equivalent()
    await fast.delete(item.id)
    await equivalent()
  })

  test('direct historical UPDATE/DELETE and legacy writes cannot return stale summaries', async () => {
    const item = record([50, 70, 90])
    await fast.save(item)
    await pool.execute(`UPDATE \`${database}\`.events SET ts=-10 WHERE session_id=? AND seq=1`, [item.id])
    assert.equal(await ready(item.id), 0)
    await equivalent()
    await fast.backfillEventTimes(item.id)
    assert.equal(await ready(item.id), 1)
    await pool.execute(`DELETE FROM \`${database}\`.events WHERE session_id=? AND seq=2`, [item.id])
    assert.equal(await ready(item.id), 0)
    await equivalent()
    await legacy.save(record([3, 2, 8]))
    await equivalent()
  })

  test('event and projection changes roll back together', async () => {
    const item = record([50, 70])
    await fast.save(item)
    const before = await fast.listSummaries({ sessionIds: [item.id] })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(`SELECT id FROM \`${database}\`.sessions WHERE id=? FOR UPDATE`, [item.id])
      await connection.execute(`INSERT INTO \`${database}\`.events VALUES (?,?,?,?,?)`, [item.id, 2, 999, 'user/message', '{}'])
      await connection.rollback()
    } finally { connection.release() }
    assert.deepEqual(await fast.listSummaries({ sessionIds: [item.id] }), before)
    await equivalent()
  })

  test('backfill racing append is serialized by the session lock without losing events', async () => {
    const item = record([100, 200])
    await legacy.save(item)
    assert.equal(await ready(item.id), 0)
    await Promise.all([
      fast.backfillEventTimes(item.id),
      ...Array.from({ length: 8 }, (_, i) => fast.append(item.id, { type: 'user/message', kind: 'wake', text: 'parallel' }, 80 - i)),
    ])
    const actual = await fast.loadEvents(item.id)
    assert.equal(actual.length, 10)
    assert.equal(new Set(actual.map(e => e.seq)).size, 10)
    assert.equal(await ready(item.id), 1)
    await equivalent()
  })
})
