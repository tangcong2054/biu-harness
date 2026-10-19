import { inspectSqliteReadOnly } from './sqlite-inventory.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: npm run mysql:inventory -- /absolute/path/to/copy.sqlite')
  process.exitCode = 1
} else {
  try {
    console.log(JSON.stringify(inspectSqliteReadOnly(path), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
