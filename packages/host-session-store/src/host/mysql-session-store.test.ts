import { randomUUID } from 'node:crypto'
import { createPool } from 'mysql2/promise'
import { describe, expect, test } from 'vitest'
import { SESSION_FORMAT_VERSION, type SessionRecord } from '@biu/type-session'
import { resolveSessionBackend } from './index.ts'
import { MysqlSessionStore } from './mysql-session-store.ts'

type FakeSession = Record<string, unknown> & { id: string; event_count: number }

class FakeMysqlPool {
  sessions = new Map<string, FakeSession>()
  events = new Map<string, Array<Record<string, unknown>>>()
  private tail = Promise.resolve()

  async acquire() {
    const previous = this.tail
    let unlock = () => {}
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await previous
    return unlock
  }

  async query(sql: string, values: unknown[] = []) {
    return this.execute(sql, values)
  }

  async getConnection() {
    return new FakeMysqlConnection(this)
  }

  execute(sql: string, values: unknown[] = []): [unknown, unknown[]] {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO') && normalized.includes('`sessions`')) {
      const [id, version, project, mascot, config, title, updated] = values
      if (!this.sessions.has(String(id))) {
        this.sessions.set(String(id), {
          id: String(id), version, project_json: project, mascot_json: mascot,
          config_json: config, event_count: 0, title, updated_at: updated,
        })
      }
      return [{ affectedRows: 1 }, []]
    }
    if (normalized.startsWith('INSERT INTO') && normalized.includes('`events`')) {
      for (let index = 0; index < values.length; index += 5) {
        const [id, seq, ts, type, eventJson] = values.slice(index, index + 5)
        const rows = this.events.get(String(id)) ?? []
        if (rows.some((row) => row.seq === seq)) throw new Error('duplicate seq')
        rows.push({ session_id: id, seq, ts, type, event_json: eventJson })
        rows.sort((left, right) => Number(left.seq) - Number(right.seq))
        this.events.set(String(id), rows)
      }
      return [{ affectedRows: values.length / 5 }, []]
    }
    if (normalized.startsWith('UPDATE') && normalized.includes('SET version =')) {
      const [version, project, mascot, config, count, title, updated, id] = values
      Object.assign(this.sessions.get(String(id))!, {
        version, project_json: project, mascot_json: mascot, config_json: config,
        event_count: count, title, updated_at: updated,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (normalized.startsWith('UPDATE') && normalized.includes('SET event_count =')) {
      const hasTitle = normalized.includes('title = ?')
      const [count, updated, third, fourth] = values
      const id = String(hasTitle ? fourth : third)
      Object.assign(this.sessions.get(id)!, {
        event_count: count,
        updated_at: updated,
        ...(hasTitle ? { title: third } : {}),
      })
      return [{ affectedRows: 1 }, []]
    }
    if (normalized.startsWith('DELETE FROM') && normalized.includes('`events`')) {
      const id = String(values[0])
      const affectedRows = this.events.get(id)?.length ?? 0
      this.events.delete(id)
      return [{ affectedRows }, []]
    }
    if (normalized.startsWith('DELETE FROM') && normalized.includes('`sessions`')) {
      const affectedRows = this.sessions.delete(String(values[0])) ? 1 : 0
      return [{ affectedRows }, []]
    }
    if (normalized.startsWith('SELECT id, version')) {
      const row = this.sessions.get(String(values[0]))
      return [[...(row ? [row] : [])], []]
    }
    if (normalized.startsWith('SELECT event_json')) {
      return [[...(this.events.get(String(values[0])) ?? [])], []]
    }
    if (normalized.startsWith('SELECT id FROM') && normalized.includes('ORDER BY updated_at')) {
      return [[...this.sessions.values()].sort(
        (left, right) => Number(right.updated_at) - Number(left.updated_at),
      ), []]
    }
    if (normalized.startsWith('SELECT s.id')) {
      return [[...this.sessions.values()].map((session) => {
        const events = this.events.get(session.id) ?? []
        const spoken = events.filter((event) => event.type === 'user/message')
        return {
          ...session,
          first_event_at: events[0]?.ts ?? null,
          last_message_at: spoken.at(-1)?.ts ?? null,
        }
      }), []]
    }
    if (normalized.startsWith('SELECT event_count, config_json')) {
      const row = this.sessions.get(String(values[0]))
      return [[...(row ? [row] : [])], []]
    }
    if (normalized.startsWith('SELECT event_count FROM')) {
      const row = this.sessions.get(String(values[0]))
      return [[...(row ? [row] : [])], []]
    }
    if (normalized.startsWith('SELECT seq, event_json') || normalized.startsWith('SELECT seq FROM')) {
      const row = this.events.get(String(values[0]))?.at(-1)
      return [[...(row ? [row] : [])], []]
    }
    if (normalized.startsWith('SELECT id FROM') && normalized.includes('FOR UPDATE')) {
      const row = this.sessions.get(String(values[0]))
      return [[...(row ? [row] : [])], []]
    }
    throw new Error(`unsupported fake SQL: ${normalized}`)
  }
}

class FakeMysqlConnection {
  private unlock?: () => void
  constructor(private pool: FakeMysqlPool) {}
  async beginTransaction() { this.unlock = await this.pool.acquire() }
  async commit() { this.unlock?.(); this.unlock = undefined }
  async rollback() { this.unlock?.(); this.unlock = undefined }
  release() { this.unlock?.(); this.unlock = undefined }
  async query(sql: string, values: unknown[] = []) { return this.pool.execute(sql, values) }
}

describe('session backend routing', () => {
  test('Offline is always SQLite', () => {
    expect(resolveSessionBackend('dual', false)).toBe('sqlite')
    expect(resolveSessionBackend('mysql', false)).toBe('sqlite')
  })

  test('dual defaults to MySQL Online and supports shadow mode', () => {
    expect(resolveSessionBackend('dual', true, undefined)).toBe('mysql')
    expect(resolveSessionBackend('dual', true, 'shadow')).toBe('shadow')
    expect(resolveSessionBackend('dual', true, 'sqlite')).toBe('sqlite')
  })
})

const testUrl = process.env.BIU_MYSQL_TEST_URL

async function verifyStoreContract(store: MysqlSessionStore, id: string) {
    const now = Date.now()
    const record: SessionRecord = {
      id,
      version: SESSION_FORMAT_VERSION,
      config: { title: 'MySQL test', createdAt: now },
      events: [
        { type: 'session/open', version: SESSION_FORMAT_VERSION, seq: 0, ts: now },
        { type: 'user/message', text: 'hello', kind: 'wake', seq: 1, ts: now + 1 },
      ],
    }
    try {
      await store.save(record)
      expect(await store.load(id)).toEqual(record)
      expect(await store.list()).toContain(id)
      expect((await store.listSummaries()).find((item) => item.id === id)).toMatchObject({
        eventCount: 2,
        title: 'MySQL test',
        lastMessageAt: now + 1,
      })

      const appended = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.append(id, { type: 'assistant/chunk', text: String(index) }, now + 10 + index),
        ),
      )
      expect(new Set(appended.map((event) => event.seq)).size).toBe(12)
      const events = await store.loadEvents(id)
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: 14 }, (_, index) => index),
      )

      expect(await store.delete(id)).toBe(true)
      expect(await store.load(id)).toBeUndefined()
      expect(await store.loadEvents(id)).toEqual([])
      expect(await store.delete(id)).toBe(false)
    } finally {
      await store.delete(id).catch(() => false)
    }
}

test('MysqlSessionStore CRUD, ordering, concurrent append, and delete', async () => {
  const pool = new FakeMysqlPool()
  const store = new MysqlSessionStore(pool as never, 'biu_test')
  await verifyStoreContract(store, 'unit_session')
})

describe.skipIf(!testUrl)('MysqlSessionStore integration', () => {
  test('passes the Store contract against MySQL', async () => {
    const parsed = new URL(testUrl!)
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    if (!database) throw new Error('BIU_MYSQL_TEST_URL must include a database')
    const pool = createPool({ uri: testUrl!, connectionLimit: 8 })
    const store = new MysqlSessionStore(pool, database)
    try {
      await verifyStoreContract(store, `test_session_${randomUUID().replaceAll('-', '')}`)
    } finally {
      await pool.end()
    }
  })
})
