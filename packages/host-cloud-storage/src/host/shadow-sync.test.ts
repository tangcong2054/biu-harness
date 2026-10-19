import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { ShadowSyncBridge, syncEventsSnapshot } from './shadow-sync.ts'

afterEach(() => vi.useRealTimers())

const logger = { info: vi.fn(), warn: vi.fn() }

describe('ShadowSyncBridge', () => {
  test('debounces changes and only runs once', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => {})
    const bridge = new ShadowSyncBridge(sync, logger, 100)
    bridge.notifyChange()
    bridge.notifyChange()
    bridge.notifyChange()
    await vi.advanceTimersByTimeAsync(99)
    expect(sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(bridge.status().lastSucceededAt).not.toBeNull()
  })

  test('serializes a change received during a run', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => { release = resolve })
    const sync = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    const bridge = new ShadowSyncBridge(sync, logger, 10)
    bridge.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    bridge.notifyChange()
    release()
    await bridge.flush()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  test('records failures without rejecting flush and can recover', async () => {
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error('mysql unavailable'))
      .mockResolvedValue(undefined)
    const bridge = new ShadowSyncBridge(sync, logger, 10)
    bridge.notifyChange()
    await bridge.flush()
    expect(bridge.status()).toMatchObject({ phase: 'error', lastError: 'mysql unavailable' })
    bridge.notifyChange()
    await bridge.flush()
    expect(bridge.status().phase).toBe('idle')
    expect(bridge.status().lastError).toBeNull()
  })

  test('stays inert when disabled', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => {})
    const bridge = new ShadowSyncBridge(sync, logger, 10, false)
    bridge.start()
    bridge.notifyChange()
    await vi.runAllTimersAsync()
    await bridge.flush()
    expect(sync).not.toHaveBeenCalled()
    expect(bridge.status().phase).toBe('disabled')
  })
})

test('event shadow uses per-session cursors and reconciles deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'biu-shadow-events-'))
  const path = join(dir, 'events.sqlite')
  const sqlite = new DatabaseSync(path)
  sqlite.exec(`CREATE TABLE events (
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
    type TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (session_id, seq)
  )`)
  const insert = sqlite.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)')
  insert.run('s1', 0, 10, 'user', '{"seq":0}')
  insert.run('s1', 1, 11, 'assistant', '{"seq":1}')

  const events = new Map<string, Map<number, unknown[]>>()
  const cursors = new Map<string, { last_seq: number; row_count: number }>()
  let inserted = 0
  const connection = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('SELECT session_id, last_seq, row_count')) {
        return [[...cursors].map(([session_id, cursor]) => ({ session_id, ...cursor })), []]
      }
      if (sql.includes('DELETE FROM `biu`.events')) {
        events.delete(String(params[0]))
      } else if (sql.includes('DELETE FROM `biu`.shadow_sync_cursors')) {
        cursors.delete(String(params[0]))
      } else if (sql.includes('INSERT INTO `biu`.events')) {
        for (let offset = 0; offset < params.length; offset += 5) {
          const sessionId = String(params[offset])
          const seq = Number(params[offset + 1])
          const rows = events.get(sessionId) ?? new Map()
          rows.set(seq, params.slice(offset, offset + 5))
          events.set(sessionId, rows)
          inserted += 1
        }
      } else if (sql.includes('INSERT INTO `biu`.shadow_sync_cursors')) {
        cursors.set(String(params[0]), {
          last_seq: Number(params[1]),
          row_count: Number(params[2]),
        })
      }
      return [[], []]
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  }
  const pool = { async getConnection() { return connection } } as unknown as Pool

  try {
    await syncEventsSnapshot(pool, 'biu', path)
    expect(inserted).toBe(2)
    insert.run('s1', 2, 12, 'assistant', '{"seq":2}')
    await syncEventsSnapshot(pool, 'biu', path)
    expect(inserted).toBe(3)
    expect(events.get('s1')?.size).toBe(3)

    sqlite.prepare('DELETE FROM events WHERE session_id = ? AND seq = ?').run('s1', 1)
    await syncEventsSnapshot(pool, 'biu', path)
    expect(events.get('s1')?.has(1)).toBe(false)
    expect(events.get('s1')?.size).toBe(2)

    sqlite.prepare('DELETE FROM events WHERE session_id = ?').run('s1')
    await syncEventsSnapshot(pool, 'biu', path)
    expect(events.has('s1')).toBe(false)
    expect(cursors.has('s1')).toBe(false)
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
