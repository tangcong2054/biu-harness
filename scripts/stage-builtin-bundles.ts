import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packSandboxDir } from '../packages/core-plugin-system/src/host/plugin-create.ts'

const source = process.argv[2]
const dest = process.argv[3]
if (!source || !dest) throw new Error('usage: stage-builtin-bundles.ts <plugin-dev> <plugin>')
if (!existsSync(source)) process.exit(0)

mkdirSync(dest, { recursive: true })
const copied: string[] = []
for (const name of readdirSync(source).sort()) {
  const dir = join(source, name)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { builtin?: unknown }
  if (manifest.builtin !== true) continue
  await packSandboxDir(dir, join(dest, name), { allPrebuilds: true })
  copied.push(name)
}
console.log(`staged builtin bundles: ${copied.join(' ') || '(none)'}`)
