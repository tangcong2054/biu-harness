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
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line} ${hit.method}`),
    [],
    `同步消费了 AccountService 的异步方法（Promise 被当成布尔值）：\n${formatted.join('\n')}`,
  )
  // 防止有人把方法改回同步后忘记更新这条约束。
  assert.ok(asyncAccountMethods().includes('canAccessPlugin'))
  assert.ok(asyncAccountMethods().includes('tenantForRecord'))
})

/**
 * 第二类问题：直接拿 `ctx.get('account').store`（同步的本机 CollabStore）做成员 / 插件 / 归属 / 身份判定。
 * MySQL 控制面下本机这些表是空的，判定恒为假或恒为空——catalog、/api/mcp/info、UI Actions
 * 都曾因此在线上失效。规则：这类调用前面必须先走过异步服务方法（同一语句的三元 / if 分支），
 * 只有在服务没有异步方法时才回退到 store。
 */
const STORE_SENSITIVE = [
  'isMember', 'canAccessPlugin', 'tenantForRecord', 'accountByToken', 'recordWorkspace',
  'workspaceHasPlugin', 'resolveMcpCredential', 'hasExecutionLease', 'acquireExecutionLease',
  'renewExecutionLease', 'requireExecutionLease', 'releaseExecutionLease',
]

/**
 * 已审查过的回退：每条都在异步分支之后，或者只在本机 SQLite 就是权威的路径上执行。
 * key 是「文件 方法」，不绑行号，避免无关改动让测试抖动。
 */
const REVIEWED_STORE_FALLBACKS = new Map<string, string>([
  ['packages/host-http/src/host/index.ts tenantForRecord', '`if (account?.tenantForRecord)` 异步分支 return 之后的回退'],
  ['packages/host-http/src/host/index.ts accountByToken', 'else 分支：账号服务没有异步方法时才走'],
  ['packages/host-http/src/host/index.ts isMember', 'else 分支：账号服务没有异步方法时才走'],
  ['packages/core-chat/src/host/index.ts acquireExecutionLease', 'executionLeases() 在服务缺少异步租约方法时的适配器'],
  ['packages/core-chat/src/host/index.ts renewExecutionLease', '同上'],
  ['packages/core-chat/src/host/index.ts requireExecutionLease', '同上'],
  ['packages/core-chat/src/host/index.ts releaseExecutionLease', '同上'],
  ['packages/core-chat/src/host/index.ts hasExecutionLease', '同上'],
  ['packages/core-file-system/src/host/index.ts isMember', '写本机归属；MySQL 归属由 attachMysqlWorkspaceRecord 单独写入'],
  ['packages/core-file-system/src/host/index.ts recordWorkspace', '桌面端转发云端结果后写本机缓存，本机 SQLite 是权威'],
  ['packages/host-tools/src/host/index.ts canAccessPlugin', 'canAccessPluginCached 三元的回退分支'],
])

function storeAliases(text: string) {
  // `const account = (ctx.get('account') as {...} | undefined)?.store` 这类别名：变量名不叫 store，
  // 但拿到的同样是同步的本机 CollabStore（catalog 路由当年就是这么写的）。
  const aliases = new Set(['store', 'accountStore'])
  const decl = /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*[\s\S]{0,600}?\)\s*\??\.store\b(?!\s*\??\.)/g
  for (const match of text.matchAll(decl)) {
    const body = match[0]
    // 别名声明里不能跨越另一个声明（避免把前一个 const 吞进来）。
    if (/\n\s*(?:const|let)\s/.test(body.slice(body.indexOf('=') + 1))) continue
    aliases.add(match[1]!)
  }
  return [...aliases]
}

function scanStoreFallbacks(only?: { file: string; text: string }) {
  const out: Hit[] = []
  const check = (file: string, text: string) => {
    // 账号服务自身就是分发层，内部读 store 是它的职责。
    if (file.startsWith('packages/host-account/src/host/')) return
    const call = new RegExp(
      `\\b(?:${storeAliases(text).join('|')})\\s*\\??\\.\\s*(${STORE_SENSITIVE.join('|')})\\s*\\??\\.?\\s*\\(`,
    )
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      const match = call.exec(line)
      if (!match) return
      const before = lines.slice(Math.max(0, index - 8), index + 1).join('\n')
      if (/\?\s*\(?\s*await\b|usesMysqlAccounts|Async\s*\(|Async\b\s*\?/.test(before)) return
      if (REVIEWED_STORE_FALLBACKS.has(`${file} ${match[1]}`)) return
      out.push({ file, line: index + 1, method: match[1]!, text: line.trim().slice(0, 120) })
    })
  }
  if (only) {
    check(only.file, only.text)
    return out
  }
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
      check(full.slice(root.length + 1), readFileSync(full, 'utf8'))
    }
  }
  walk(join(root, 'packages'))
  return out
}

test('the store-fallback rule catches the shapes that broke catalog, MCP info and UI actions', () => {
  // 这三段是修复前的原始写法（节选）。规则必须把它们都报出来。
  const catalog = `
    const account = (
      ctx.get('account') as {
        store?: { isMember?(a: string, w: string): boolean }
      } | undefined
    )?.store
    const canManagePackages = !isOnlineRuntime() || Boolean(account?.isMember?.(accountId, workspaceId))`
  const mcpInfo = `
      const store = (
        ctx.get('account') as { store?: { isMember?(a: string, w: string): boolean } } | undefined
      )?.store
      if (!store?.isMember?.(accountId, workspaceId)) return route.send(403, { error: '不在这个空间' })`
  const uiActions = `
    const accountId = (
      this.ctx.get('account') as { store?: { accountByToken?(t: string): { id: string } | null } } | undefined
    )?.store?.accountByToken?.(token)?.id ?? ''`
  assert.equal(scanStoreFallbacks({ file: 'packages/x/catalog.ts', text: catalog }).length, 1)
  assert.equal(scanStoreFallbacks({ file: 'packages/x/mcp.ts', text: mcpInfo }).length, 1)
  assert.equal(scanStoreFallbacks({ file: 'packages/x/ui.ts', text: uiActions }).length, 1)
  // 先走异步方法、store 只做回退的写法不报。
  const guarded = `
    const member = account?.isMemberAsync
      ? await account.isMemberAsync(accountId, workspaceId)
      : account?.store?.isMember?.(accountId, workspaceId)`
  assert.equal(scanStoreFallbacks({ file: 'packages/x/ok.ts', text: guarded }).length, 0)
})

test('sync CollabStore is never the only source for membership, plugin, tenant or identity checks', () => {
  const hits = scanStoreFallbacks()
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line} ${hit.method} — ${hit.text}`),
    [],
    '这些调用只读本机 SQLite；MySQL 控制面下会恒假。先调用账号服务的异步方法，store 只做回退。',
  )
})
