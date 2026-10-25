import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

/**
 * MySQL 控制面把 AccountService 的一批方法改成了异步（读云端而不是本机 SQLite）。
 * 只要调用点还按同步消费，返回值就是 Promise —— `Boolean(promise)` 恒为 true，
 * 三元分支也永远走同一边，等于鉴权被静默绕过。这类问题在 review 里极难发现，
 * 所以用静态扫描把它固定住。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')

/** AccountService 上公开且异步的方法。 */
function asyncAccountMethods(): string[] {
  const source = readFileSync(join(here, 'index.ts'), 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/^\s{2}async\s+([A-Za-z_]\w*)\s*\(/gm)) found.add(match[1]!)
  return [...found].sort()
}

type Hit = { file: string; line: number; method: string; text: string }

function scanSyncConsumers(): Hit[] {
  const methods = asyncAccountMethods()
  if (!methods.length) throw new Error('no async AccountService methods found')
  const receiver = '([A-Za-z_]\\w*)'
  // `store.*` 是同步的 CollabStore，`this.*` 是服务内部调用，两者都不是跨服务调用。
  const internalReceivers = new Set(['store', 'this'])
  const hits: Hit[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
      if (entry.includes('.test.')) continue
      const text = readFileSync(full, 'utf8')
      const lines = text.split('\n')
      for (const method of methods) {
        const call = new RegExp(`${receiver}\\s*\\??\\.\\s*${method}\\s*\\(`)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!
          const match = call.exec(line)
          if (!match) continue
          // 从 `this` 的中间开始匹配时 receiver 会变成 `his`，用整行文本再确认一次。
          if (internalReceivers.has(match[1]!)) continue
          if (new RegExp(`\\bthis\\s*\\??\\.\\s*${method}\\s*\\(`).test(line)) continue
          const snippet = line.trim()
          // 类型声明与方法定义不参与。
          if (/^\s*(private|public|protected|async)\s/.test(snippet)) continue
          if (/\)\s*:\s*Promise/.test(snippet) || /\)\s*:\s*\(/.test(snippet)) continue
          const at = match.index
          const before = `${lines.slice(Math.max(0, index - 4), index).join('\n')}\n${line.slice(0, at)}`
          // 同一语句里已经 await 过（`? await svc.m(...) : other.m(...)`）。
          if (/\bawait\b/.test(before.slice(-160))) continue
          // `.then/.catch` 与 `void` 都是异步消费，不是同步取值。
          const after = line.slice(at)
          if (/\)\s*\.\s*(then|catch|finally)\s*\(/.test(after)) continue
          if (/\bvoid\s+$/.test(before.slice(-8))) continue
          hits.push({ file: full.slice(root.length + 1), line: index + 1, method, text: snippet.slice(0, 120) })
        }
      }
    }
  }
  walk(join(root, 'packages'))
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

test('AccountService async methods are never consumed without await', () => {
  const hits = scanSyncConsumers()
  const formatted = hits.map((hit) => `${hit.file}:${hit.line} ${hit.method} — ${hit.text}`)
  /**
   * 已知待修（本次合并未引入，但把方法的异步性扩散到了更多调用点）：
   * - core-plugin-system/src/host/store.ts 的 catalog 路由只取了 `ctx.get('account').store`，
   *   这个对象上没有 `canAccessPlugin`，于是 `account?.canAccessPlugin?.(...)` 恒为 undefined，
   *   线上 `/api/plugins/catalog` 的 assigned 永远是 false。
   * 修好后把对应条目从这里删掉，测试会重新变绿并锁住回归。
   */
  const known = new Set(['packages/core-plugin-system/src/host/store.ts:1176 canAccessPlugin'])
  const unexpected = hits.filter((hit) => !known.has(`${hit.file}:${hit.line} ${hit.method}`))
  assert.deepEqual(
    unexpected.map((hit) => `${hit.file}:${hit.line} ${hit.method}`),
    [],
    `同步消费了 AccountService 的异步方法（Promise 被当成布尔值）：\n${formatted.join('\n')}`,
  )
  // 防止有人把方法改回同步后忘记更新这条约束。
  assert.ok(asyncAccountMethods().includes('canAccessPlugin'))
  assert.ok(asyncAccountMethods().includes('tenantForRecord'))
})
