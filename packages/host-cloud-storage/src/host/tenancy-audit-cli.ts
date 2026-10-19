import { auditSqliteTenancy } from './tenancy-audit.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: npm run mysql:audit-tenancy -- /path/online-biu.sqlite')
  process.exitCode = 1
} else {
  try {
    const result = auditSqliteTenancy(path)
    console.log(JSON.stringify(result, null, 2))
    if (!result.canUseWorkspacePrimaryKeys) process.exitCode = 2
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
