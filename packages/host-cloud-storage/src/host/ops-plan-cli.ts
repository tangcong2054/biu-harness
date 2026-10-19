import { planOperationsMerge } from './ops-import-plan.ts'

const cloud = process.argv[2]
const operations = process.argv[3]
if (!cloud || !operations) {
  console.error('usage: npm run mysql:plan-ops -- /path/online-ops.sqlite /path/operations-ops.sqlite')
  process.exitCode = 1
} else {
  try {
    console.log(
      JSON.stringify(
        planOperationsMerge([
          { name: 'online', path: cloud },
          { name: 'operations', path: operations },
        ]),
        null,
        2,
      ),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
