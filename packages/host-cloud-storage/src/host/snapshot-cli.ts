import { resolve } from 'node:path'
import { createSqliteSnapshot } from './sqlite-snapshot.ts'

if (process.env.BIU_CREATE_BRANCH_SNAPSHOTS !== '1') {
  throw new Error('refusing to copy data: set BIU_CREATE_BRANCH_SNAPSHOTS=1 explicitly')
}

const root = resolve('.branch-data/mysql-cloud-sync/source-snapshots')
const sources = [
  ['.cloud-data/.biu/biu.sqlite', 'online-biu.sqlite'],
  ['.cloud-data/.biu/events.sqlite', 'online-events.sqlite'],
  ['.cloud-data/.biu/ops.sqlite', 'online-ops.sqlite'],
  ['.local-data/.biu/biu.sqlite', 'offline-biu.sqlite'],
  ['.local-data/.biu/events.sqlite', 'offline-events.sqlite'],
  ['.operations-data/.biu/ops.sqlite', 'operations-ops.sqlite'],
] as const

for (const [source, name] of sources) {
  const result = await createSqliteSnapshot(source, resolve(root, name))
  console.log(`${name}: ${result.bytes} bytes`)
}
