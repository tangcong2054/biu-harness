import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import {
  SESSION_FORMAT_VERSION,
  type SessionConfig,
  type SessionEvent,
  type SessionEventBody,
  type SessionMascot,
  type SessionProject,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
  nameFromSessionMascot,
  normalizeSessionConfig,
  sessionDisplayTitle,
} from '@biu/type-session'
import { isSessionMascot, parseSessionMascot } from '@biu/host-sessions/mascot'

const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type SessionRow = RowDataPacket & {
  id: string
  version: number
  project_json: string | null
  mascot_json: string | null
  config_json: string | null
  event_count: number
  title: string
  updated_at: number
}

function parseJson<T>(raw: unknown): T | undefined {
  if (raw == null || raw === '') return undefined
  try {
    const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
    return (typeof value === 'string' ? JSON.parse(value) : value) as T
  } catch {
    return undefined
  }
}

function parseProject(raw: unknown) {
  return parseJson<SessionProject>(raw)
}

function parseMascot(raw: unknown): SessionMascot | undefined {
  const parsed = typeof raw === 'string' ? parseSessionMascot(raw) : raw
  return parsed && isSessionMascot(parsed) ? parsed : undefined
}

function parseConfig(raw: unknown): SessionConfig | undefined {
  return normalizeSessionConfig(parseJson(raw))
}

/**
 * Online Session 热存储。表名固定、值全部参数化；每个会话的写入由 sessions
 * 主键行锁串行化，确保 events 的 seq 分配和 event_count 在同一事务中提交。
 */
export class MysqlSessionStore implements SessionStore {
  private readonly database: string

  constructor(
    private readonly pool: Pick<Pool, 'query' | 'getConnection'>,
    database = 'biu',
  ) {
    if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database name: ${database}`)
    this.database = `\`${database}\``
  }

  private table(name: 'sessions' | 'events') {
    return `${this.database}.\`${name}\``
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT id, version, project_json, mascot_json, config_json
       FROM ${this.table('sessions')} WHERE id = ?`,
      [id],
    )
    const row = rows[0]
    if (!row) return undefined
    if (Number(row.version) !== SESSION_FORMAT_VERSION) {
      throw new Error(`unsupported session version ${row.version}`)
    }
    return {
      id: String(row.id),
      version: Number(row.version),
      events: await this.loadEvents(id),
      ...(parseProject(row.project_json) ? { project: parseProject(row.project_json) } : {}),
      ...(parseMascot(row.mascot_json) ? { mascot: parseMascot(row.mascot_json) } : {}),
      ...(parseConfig(row.config_json) ? { config: parseConfig(row.config_json) } : {}),
    }
  }

  async loadEvents(id: string): Promise<SessionEvent[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { event_json: unknown }>>(
      `SELECT event_json FROM ${this.table('events')} WHERE session_id = ? ORDER BY seq ASC`,
      [id],
    )
    return rows.map((row) => {
      const event = parseJson<SessionEvent>(row.event_json)
      if (!event) throw new Error(`invalid event JSON for session ${id}`)
      return event
    })
  }

  async save(record: SessionRecord): Promise<void> {
    if (record.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`unsupported session version ${record.version}`)
    }
    if (record.events.some((event, index) => event.seq !== index)) {
      throw new Error(`session ${record.id} events must have contiguous seq values starting at 0`)
    }
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const storedCount = await this.lockOrCreateSession(connection, record)
      await this.syncEvents(connection, record.id, record.events, storedCount)
      await this.writeMetadata(connection, record, record.events.length)
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * 原子追加入口，供并发生产者使用。seq 在持有 session 行锁后按 MAX(seq)+1
   * 分配，因此多个进程/连接不会产生重复 seq。
   */
  async append(id: string, body: SessionEventBody, ts = Date.now()): Promise<SessionEvent> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [sessions] = await connection.query<Array<RowDataPacket & { event_count: number; config_json: unknown }>>(
        `SELECT event_count, config_json FROM ${this.table('sessions')} WHERE id = ? FOR UPDATE`,
        [id],
      )
      const session = sessions[0]
      if (!session) throw new Error(`unknown session: ${id}`)
      const [lastRows] = await connection.query<Array<RowDataPacket & { seq: number }>>(
        `SELECT seq FROM ${this.table('events')} WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
        [id],
      )
      const seq = lastRows[0] ? Number(lastRows[0].seq) + 1 : 0
      const event: SessionEvent = { ...body, seq, ts }
      await connection.query(
        `INSERT INTO ${this.table('events')} (session_id, seq, ts, type, event_json)
         VALUES (?, ?, ?, ?, ?)`,
        [id, seq, ts, event.type, JSON.stringify(event)],
      )
      const config = parseConfig(session.config_json)
      const title = event.type === 'user/message' && !config?.title
        ? event.text.slice(0, 48)
        : undefined
      await connection.query(
        `UPDATE ${this.table('sessions')}
         SET event_count = ?, updated_at = ?${title === undefined ? '' : ', title = ?'}
         WHERE id = ?`,
        title === undefined
          ? [seq + 1, ts, id]
          : [seq + 1, ts, title, id],
      )
      await connection.commit()
      return event
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async deleteEvents(id: string, connection?: PoolConnection): Promise<number> {
    const executor = connection ?? this.pool
    const [result] = await executor.query<ResultSetHeader>(
      `DELETE FROM ${this.table('events')} WHERE session_id = ?`,
      [id],
    )
    return Number(result.affectedRows)
  }

  async list(): Promise<string[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${this.table('sessions')} ORDER BY updated_at DESC`,
    )
    return rows.map((row) => String(row.id))
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const [rows] = await this.pool.query<Array<SessionRow & { last_message_at: number | null; first_event_at: number | null }>>(
      `SELECT s.id, s.version, s.project_json, s.mascot_json, s.config_json,
              s.event_count, s.title, s.updated_at,
              MAX(CASE WHEN e.type = 'user/message' THEN e.ts END) AS last_message_at,
              MIN(e.ts) AS first_event_at
       FROM ${this.table('sessions')} s
       LEFT JOIN ${this.table('events')} e ON e.session_id = s.id
       GROUP BY s.id, s.version, s.project_json, s.mascot_json, s.config_json,
                s.event_count, s.title, s.updated_at
       ORDER BY s.updated_at DESC`,
    )
    return rows.map((row) => {
      const project = parseProject(row.project_json)
      const mascot = parseMascot(row.mascot_json)
      const config = parseConfig(row.config_json)
      const createdAt = Number(config?.createdAt)
      const stamp = Number.isFinite(createdAt) && createdAt > 0
        ? createdAt
        : Number(row.first_event_at) || Number(row.updated_at)
      const lastMessageAt = Number(row.last_message_at) || 0
      return {
        id: String(row.id),
        version: Number(row.version),
        eventCount: Number(row.event_count),
        title: row.title && row.title !== String(row.id).slice(0, 8)
          ? String(row.title)
          : mascot
            ? nameFromSessionMascot(mascot)
            : String(row.title || String(row.id).slice(0, 8)),
        updatedAt: Number(row.updated_at),
        ...(lastMessageAt > 0 ? { lastMessageAt } : {}),
        ...(project ? { project } : {}),
        ...(mascot ? { mascot } : {}),
        ...(config || stamp ? { config: { ...(config ?? {}), createdAt: stamp } } : {}),
      }
    })
  }

  async delete(id: string): Promise<boolean> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `SELECT id FROM ${this.table('sessions')} WHERE id = ? FOR UPDATE`,
        [id],
      )
      await this.deleteEvents(id, connection)
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM ${this.table('sessions')} WHERE id = ?`,
        [id],
      )
      await connection.commit()
      return Number(result.affectedRows) > 0
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async lockOrCreateSession(connection: PoolConnection, record: SessionRecord) {
    const now = Date.now()
    await connection.query(
      `INSERT INTO ${this.table('sessions')}
       (id, version, project_json, mascot_json, config_json, event_count, title, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON DUPLICATE KEY UPDATE id = VALUES(id)`,
      [
        record.id,
        record.version,
        record.project ? JSON.stringify(record.project) : null,
        record.mascot ? JSON.stringify(record.mascot) : null,
        record.config ? JSON.stringify(record.config) : null,
        sessionDisplayTitle(record),
        now,
      ],
    )
    const [rows] = await connection.query<Array<RowDataPacket & { event_count: number }>>(
      `SELECT event_count FROM ${this.table('sessions')} WHERE id = ? FOR UPDATE`,
      [record.id],
    )
    return Number(rows[0]?.event_count ?? 0)
  }

  private async replaceEvents(connection: PoolConnection, id: string, events: SessionEvent[]) {
    await this.deleteEvents(id, connection)
    await this.insertEvents(connection, id, events)
  }

  private async syncEvents(
    connection: PoolConnection,
    id: string,
    events: SessionEvent[],
    storedCount: number,
  ) {
    if (storedCount === 0) {
      await this.insertEvents(connection, id, events)
      return
    }
    if (events.length < storedCount) {
      await this.replaceEvents(connection, id, events)
      return
    }
    const [rows] = await connection.query<Array<RowDataPacket & { seq: number; event_json: unknown }>>(
      `SELECT seq, event_json FROM ${this.table('events')}
       WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
      [id],
    )
    const last = rows[0]
    const expected = events[storedCount - 1]
    const prefixMatches = Boolean(
      last
      && expected
      && Number(last.seq) === expected.seq
      && JSON.stringify(parseJson<SessionEvent>(last.event_json)) === JSON.stringify(expected),
    )
    if (!prefixMatches) {
      await this.replaceEvents(connection, id, events)
    } else if (events.length > storedCount) {
      await this.insertEvents(connection, id, events.slice(storedCount))
    }
  }

  private async insertEvents(connection: PoolConnection, id: string, events: SessionEvent[]) {
    for (let offset = 0; offset < events.length; offset += 200) {
      const batch = events.slice(offset, offset + 200)
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
      const values = batch.flatMap((event) => [
        id,
        event.seq,
        event.ts,
        event.type,
        JSON.stringify(event),
      ])
      await connection.query(
        `INSERT INTO ${this.table('events')} (session_id, seq, ts, type, event_json)
         VALUES ${placeholders}`,
        values,
      )
    }
  }

  private async writeMetadata(connection: PoolConnection, record: SessionRecord, eventCount: number) {
    const stamped = Number((record as { updatedAt?: number }).updatedAt)
    const updatedAt = Number.isFinite(stamped) && stamped > 0 ? stamped : Date.now()
    await connection.query(
      `UPDATE ${this.table('sessions')}
       SET version = ?, project_json = ?, mascot_json = ?, config_json = ?,
           event_count = ?, title = ?, updated_at = ?
       WHERE id = ?`,
      [
        record.version,
        record.project ? JSON.stringify(record.project) : null,
        record.mascot ? JSON.stringify(record.mascot) : null,
        record.config ? JSON.stringify(record.config) : null,
        eventCount,
        sessionDisplayTitle(record),
        updatedAt,
        record.id,
      ],
    )
  }
}
