import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { createSqliteSnapshot } from './sqlite-snapshot.ts'
import { importSqliteIntoMysql } from './sqlite-mysql-importer.ts'
import { collectOwnerlessRecords } from './tenancy-audit.ts'
import { discardOwnerlessMysql } from './ownerless-pruner.ts'

const EXCLUDED_MAIN_TABLES = [
  'events',
  'schema_migrations',
  'sqlite_import_runs',
  'migration_tenancy_exceptions',
  'shadow_sync_cursors',
  'shadow_sync_state',
  'cloud_backups',
  'cloud_backup_items',
  'account_devices',
  'offline_profiles',
  'authz_revisions',
  'cloud_connections',
  'workspace_place',
  'record_place',
  'record_cloud_copy',
  'replica_devices',
  'replica_records',
  'replica_outbox',
  'replica_cursors',
  'edit_locks',
  'presence',
  'session_execution_leases',
  'gc_candidates',
  'collab_state',
  'plugin_loads',
] as const

const SAFE_DATABASE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type ShadowSyncStatus = {
  enabled: boolean
  phase: 'disabled' | 'idle' | 'scheduled' | 'running' | 'error'
  pending: boolean
  runs: number
  lastStartedAt: number | null
  lastSucceededAt: number | null
  lastError: string | null
}

type Logger = { info(message: string): void; warn(message: string): void }

export class ShadowSyncBridge {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private rerun = false
  private readonly state: ShadowSyncStatus

  constructor(
    private readonly sync: () => Promise<void>,
    private readonly logger: Logger,
    private readonly debounceMs = 750,
    enabled = true,
  ) {
    this.state = {
      enabled,
      phase: enabled ? 'idle' : 'disabled',
      pending: false,
      runs: 0,
      lastStartedAt: null,
      lastSucceededAt: null,
      lastError: null,
    }
  }

  status(): ShadowSyncStatus {
    return { ...this.state }
  }

  start() {
    if (this.state.enabled) this.schedule(0)
  }

  notifyChange() {
    if (this.state.enabled) this.schedule(this.debounceMs)
  }

  private schedule(delay: number) {
    this.state.pending = true
    if (this.running) {
      this.rerun = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.state.phase = 'scheduled'
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, delay)
  }

  private drain() {
    if (this.running) return this.running
    this.running = (async () => {
      do {
        this.rerun = false
        this.state.pending = false
        this.state.phase = 'running'
        this.state.lastStartedAt = Date.now()
        this.state.runs += 1
        try {
          await this.sync()
          this.state.phase = 'idle'
          this.state.lastSucceededAt = Date.now()
          this.state.lastError = null
        } catch (error) {
          this.state.phase = 'error'
          this.state.lastError = error instanceof Error ? error.message : String(error)
          this.logger.warn(`MySQL shadow sync failed: ${this.state.lastError}`)
        }
      } while (this.rerun)
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  async flush() {
    if (!this.state.enabled) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.state.pending = false
      await this.drain()
    } else if (this.running) {
      await this.running
    }
  }
}

function mysqlDb(database: string) {
  if (!SAFE_DATABASE.test(database)) throw new Error(`unsafe MySQL database: ${database}`)
  return `\`${database}\``
}

async function ensureShadowTables(connection: PoolConnection, database: string) {
  const db = mysqlDb(database)
  await connection.query(`CREATE TABLE IF NOT EXISTS ${db}.shadow_sync_cursors (
    session_id VARCHAR(128) NOT NULL,
    last_seq BIGINT NOT NULL DEFAULT -1,
    row_count BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (session_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await connection.query(`CREATE TABLE IF NOT EXISTS ${db}.shadow_sync_tables (
    table_name VARCHAR(128) NOT NULL,
    checksum CHAR(64) NOT NULL,
    row_count BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (table_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await connection.query(`CREATE TABLE IF NOT EXISTS ${db}.events (
    session_id VARCHAR(128) NOT NULL,
    seq BIGINT NOT NULL,
    ts BIGINT NOT NULL,
    type VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
    event_json LONGTEXT NOT NULL,
    PRIMARY KEY (session_id, seq),
    KEY events_type_session_ts (type, session_id, ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
}

async function syncMain(
  pool: Pool,
  database: string,
  snapshot: string,
  extraExcluded: readonly string[] = [],
) {
  const connection = await pool.getConnection()
  const db = mysqlDb(database)
  let checksums: Record<string, string>
  try {
    await ensureShadowTables(connection, database)
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name, checksum FROM ${db}.shadow_sync_tables`,
    )
    checksums = Object.fromEntries(
      rows.map((row) => [String(row.table_name), String(row.checksum)]),
    )
  } finally {
    connection.release()
  }
  const result = await importSqliteIntoMysql(pool, database, snapshot, {
    excludeTables: [...EXCLUDED_MAIN_TABLES, ...extraExcluded],
    replace: true,
    previousChecksums: checksums,
  })
  const cursorConnection = await pool.getConnection()
  try {
    for (const table of result.tables) {
      await cursorConnection.query(
        `INSERT INTO ${db}.shadow_sync_tables (table_name, checksum, row_count, updated_at)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
         checksum = VALUES(checksum), row_count = VALUES(row_count), updated_at = VALUES(updated_at)`,
        [table.table, table.checksum, table.sourceRows, Date.now()],
      )
    }
  } finally {
    cursorConnection.release()
  }
}

type EventCursor = { session_id: string; last_seq: number; row_count: number }
type EventSummary = { session_id: string; last_seq: number; row_count: number }

export async function syncEventsSnapshot(pool: Pool, database: string, snapshot: string) {
  const sqlite = new DatabaseSync(snapshot, { readOnly: true })
  const connection = await pool.getConnection()
  const db = mysqlDb(database)
  try {
    await ensureShadowTables(connection, database)
    const source = sqlite.prepare(
      `SELECT session_id, COALESCE(MAX(seq), -1) AS last_seq, COUNT(*) AS row_count
       FROM events GROUP BY session_id`,
    ).all() as EventSummary[]
    const [cursorRows] = await connection.query<RowDataPacket[]>(
      `SELECT session_id, last_seq, row_count FROM ${db}.shadow_sync_cursors`,
    )
    const cursors = new Map(cursorRows.map((row) => [String(row.session_id), {
      session_id: String(row.session_id),
      last_seq: Number(row.last_seq),
      row_count: Number(row.row_count),
    } satisfies EventCursor]))
    const sourceIds = new Set(source.map((row) => row.session_id))

    for (const cursor of cursors.values()) {
      if (sourceIds.has(cursor.session_id)) continue
      await connection.beginTransaction()
      try {
        await connection.query(`DELETE FROM ${db}.events WHERE session_id = ?`, [cursor.session_id])
        await connection.query(`DELETE FROM ${db}.shadow_sync_cursors WHERE session_id = ?`, [cursor.session_id])
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      }
    }

    const readAfter = sqlite.prepare(
      `SELECT session_id, seq, ts, type, event_json FROM events
       WHERE session_id = ? AND seq > ? ORDER BY seq`,
    )
    const readAll = sqlite.prepare(
      `SELECT session_id, seq, ts, type, event_json FROM events
       WHERE session_id = ? ORDER BY seq`,
    )
    for (const summary of source) {
      const cursor = cursors.get(summary.session_id)
      if (cursor?.last_seq === summary.last_seq && cursor.row_count === summary.row_count) continue
      const appendOnly = Boolean(
        cursor && summary.last_seq >= cursor.last_seq
        && summary.row_count - cursor.row_count === summary.last_seq - cursor.last_seq,
      )
      const rows = (appendOnly ? readAfter.all(summary.session_id, cursor!.last_seq) : readAll.all(summary.session_id)) as Array<{
        session_id: string; seq: number; ts: number; type: string; event_json: string
      }>
      await connection.beginTransaction()
      try {
        if (!appendOnly) {
          await connection.query(`DELETE FROM ${db}.events WHERE session_id = ?`, [summary.session_id])
        }
        for (let offset = 0; offset < rows.length; offset += 500) {
          const batch = rows.slice(offset, offset + 500)
          if (!batch.length) continue
          await connection.query(
            `INSERT INTO ${db}.events (session_id, seq, ts, type, event_json) VALUES
             ${batch.map(() => '(?, ?, ?, ?, ?)').join(', ')}
             ON DUPLICATE KEY UPDATE ts = VALUES(ts), type = VALUES(type), event_json = VALUES(event_json)`,
            batch.flatMap((row) => [row.session_id, row.seq, row.ts, row.type, row.event_json]),
          )
        }
        await connection.query(
          `INSERT INTO ${db}.shadow_sync_cursors (session_id, last_seq, row_count, updated_at)
           VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
           last_seq = VALUES(last_seq), row_count = VALUES(row_count), updated_at = VALUES(updated_at)`,
          [summary.session_id, summary.last_seq, summary.row_count, Date.now()],
        )
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      }
    }
  } finally {
    connection.release()
    sqlite.close()
  }
}

export async function syncSqliteShadow(options: {
  pool: Pool
  database: string
  mainPath: string
  eventsPath: string
  syncSessions?: boolean
  excludeMainTables?: readonly string[]
}) {
  const directory = join(tmpdir(), `biu-shadow-${process.pid}-${randomUUID()}`)
  const mainSnapshot = join(directory, 'biu.sqlite')
  const eventsSnapshot = join(directory, 'events.sqlite')
  try {
    await createSqliteSnapshot(options.mainPath, mainSnapshot)
    await syncMain(
      options.pool,
      options.database,
      mainSnapshot,
      [
        ...(options.syncSessions ? [] : ['sessions']),
        ...(options.excludeMainTables ?? []),
      ],
    )
    if (String(process.env.BIU_MYSQL_OWNERLESS ?? 'discard').trim() === 'discard') {
      await discardOwnerlessMysql(
        options.pool,
        options.database,
        collectOwnerlessRecords(mainSnapshot),
      )
    }
    if (options.syncSessions && existsSync(options.eventsPath)) {
      await createSqliteSnapshot(options.eventsPath, eventsSnapshot)
      await syncEventsSnapshot(options.pool, options.database, eventsSnapshot)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
