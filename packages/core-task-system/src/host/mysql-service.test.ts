import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { Context } from 'cordis'
import { createPool, type Pool } from 'mysql2/promise'
import { runWithRequestWorkspace } from '@biu/host-plugin-loader/data-dir'
import {
  MysqlEditorContentRepository,
  MysqlTaskRepository,
} from '../../../host-cloud-storage/src/host/mysql-runtime-repositories.ts'
import { MysqlTasksService } from './mysql-service.ts'

const url = process.env.BIU_MYSQL_TEST_URL
const database = process.env.BIU_MYSQL_TEST_DATABASE
const integration = url && database ? describe : describe.skip

integration('MysqlTasksService integration', () => {
  let pool: Pool
  const workspaceId = `ws_task_test_${randomUUID().replaceAll('-', '')}`
  const ids: string[] = []

  afterAll(async () => {
    if (!pool) return
    await pool.query(
      `DELETE FROM \`${database}\`.editor_content
       WHERE workspace_id = ? AND collection = '/tasks'`,
      [workspaceId],
    )
    await pool.query(`DELETE FROM \`${database}\`.tasks WHERE workspace_id = ?`, [workspaceId])
    await pool.end()
  })

  test('full/projected CRUD, graph, reports, search and content version', async () => {
    pool = createPool({ uri: url! })
    const [columns] = await pool.query<Array<{ COLUMN_NAME: string } & import('mysql2/promise').RowDataPacket>>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'`,
      [database],
    )
    expect(columns.some((row) => row.COLUMN_NAME === 'workspace_id')).toBe(true)
    const [primary] = await pool.query<Array<{ COLUMN_NAME: string; SEQ_IN_INDEX: number } & import('mysql2/promise').RowDataPacket>>(
      `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks' AND INDEX_NAME = 'PRIMARY'
       ORDER BY SEQ_IN_INDEX`,
      [database],
    )
    expect(primary.map((row) => row.COLUMN_NAME)).toEqual(['workspace_id', 'id'])
    const raw = new MysqlTaskRepository(pool, database!, () => workspaceId)
    const content = new MysqlEditorContentRepository(pool, database!, () => workspaceId)
    const service = new MysqlTasksService(new Context(), raw, content, true, 'tasksMysqlIntegration')
    await runWithRequestWorkspace(workspaceId, async () => {
      const parent = await service.create({
        title: 'Parent',
        creator: { kind: 'agent', sessionId: 'creator-1', name: 'Creator' },
        description: 'integration-search-token',
        trigger: { enabled: true, cron: '0 3 * * *' },
      })
      ids.push(parent.id)
      const child = await service.create({
        title: 'Child',
        creator: { kind: 'user', name: 'User' },
        assignee: { kind: 'agent', sessionId: 'worker-1', name: 'Worker' },
        parentId: parent.id,
        dependsOn: [parent.id],
      })
      ids.push(child.id)
      expect(child.depth).toBe(1)
      expect(child.dependsOn).toEqual([parent.id])
      expect((await service.list({ q: 'integration-search-token' }))[0]?.description).toContain('integration-search-token')

      const projected = await service.listProjected()
      expect(projected.find((row) => row.id === parent.id)?.trigger).toBeUndefined()
      expect((await service.get(parent.id))?.trigger?.cron).toBe('0 3 * * *')

      await service.report(child.id, {
        sessionId: 'worker-1',
        turn: 2,
        status: 'doing',
        note: 'working',
        ts: Date.now(),
      })
      expect((await service.get(child.id))?.reports?.[0]?.note).toBe('working')

      const before = await content.read('/tasks', parent.id)
      const written = await content.write('/tasks', parent.id, 'changed', before.version)
      await expect(content.write('/tasks', parent.id, 'stale', before.version)).rejects.toMatchObject({
        code: 'EDITOR_CONTENT_CONFLICT',
        actualVersion: written.version,
      })

      await service.update(parent.id, { status: 'done', priority: 'high' })
      expect((await service.get(parent.id))?.status).toBe('done')
      expect(await service.delete(child.id)).toBe(true)
      expect(await service.get(child.id)).toBeUndefined()
    })
  })
})
