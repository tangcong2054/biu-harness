import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentAccountId, currentRequestWorkspaceId, dataHome, dataPath, isOnlineRuntime } from '@biu/host-plugin-loader/data-dir'

export type McpTransportKind = 'stdio' | 'http' | 'sse'

/** 工具选择：allow 非空时只允许这些，deny 始终禁用。两者都认 `*` 通配。 */
export type McpToolFilter = {
  allow: string[]
  deny: string[]
}

export type McpServerConfig = {
  id: string
  transport: McpTransportKind
  /** stdio */
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** http / sse */
  url: string
  headers: Record<string, string>
  enabled: boolean
  tools: McpToolFilter
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function mcpConfigPath(cwd = dataHome(), workspaceId = currentRequestWorkspaceId()) {
  // 有登录账号时，无论 BIU_ONLINE 是否开启都读取该账号所在工作区；
  // 仅无账号的本机模式继续使用旧的 mcp.json，不让在线请求回退到全局配置。
  if (!isOnlineRuntime() && !currentAccountId() && !workspaceId) {
    return process.env.BIU_MCP_CONFIG || dataPath(cwd, 'mcp.json')
  }
  if (!/^ws_[A-Za-z0-9_-]{1,100}$/.test(workspaceId)) throw new Error('MCP 操作需要有效的工作区上下文')
  return join(dataPath(cwd), 'mcp-workspaces', `${workspaceId}.json`)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (item == null || typeof item === 'object') continue
    out[key] = String(item)
  }
  return out
}

function asNameList(value: unknown): string[] {
  const listed = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(listed.map((item) => String(item).trim()).filter(Boolean))]
}

/** 未声明 transport 时按 url / command 推断，与 Cursor、Claude Desktop 的写法一致。 */
function inferTransport(raw: Record<string, unknown>): McpTransportKind {
  const declared = String(raw.transport ?? raw.type ?? '').trim().toLowerCase()
  if (declared === 'stdio') return 'stdio'
  if (declared === 'sse') return 'sse'
  if (declared === 'http' || declared === 'streamable-http' || declared === 'streamablehttp') return 'http'
  if (String(raw.url ?? '').trim()) return declared === 'sse' ? 'sse' : 'http'
  return 'stdio'
}

export function normalizeToolFilter(value: unknown): McpToolFilter {
  const raw = asRecord(value)
  // 数组简写等价于 allow 列表：tools: ["read_file"]
  if (Array.isArray(value)) return { allow: asNameList(value), deny: [] }
  return {
    allow: asNameList(raw.allow ?? raw.enabled ?? raw.include),
    deny: asNameList(raw.deny ?? raw.disabled ?? raw.exclude),
  }
}

export function normalizeServerConfig(id: string, value: unknown): McpServerConfig | null {
  const wanted = String(id ?? '').trim()
  if (!ID_PATTERN.test(wanted)) return null
  const raw = asRecord(value)
  const transport = inferTransport(raw)
  const command = String(raw.command ?? '').trim()
  const url = String(raw.url ?? raw.endpoint ?? '').trim()
  // command / url 允许为空：界面上新建的行先落地，字段慢慢填，填齐了再连。
  return {
    id: wanted,
    transport,
    command,
    args: Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : [],
    env: asStringMap(raw.env),
    cwd: String(raw.cwd ?? '').trim(),
    url,
    headers: asStringMap(raw.headers),
    // 只有显式 false / disabled:true 才算关；缺省是开，跟外部配置文件的直觉一致。
    enabled: raw.enabled === undefined ? raw.disabled !== true : raw.enabled !== false,
    tools: normalizeToolFilter(raw.tools),
  }
}

/** 还不能连的草稿：stdio 缺命令，远端缺地址。空串表示配置已齐。 */
export function incompleteReason(config: McpServerConfig) {
  if (config.transport === 'stdio') {
    return config.command ? '' : '还没填命令（command），填好后启用'
  }
  return /^https?:\/\//i.test(config.url) ? '' : '还没填地址（url），需要 http(s) 开头'
}

/** 键值对不能按逗号切：token 里就可能带逗号。数组直接用，字符串按行读。 */
function asPairList(value: unknown): string[] {
  const listed = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []
  return listed.map((item) => String(item).trim()).filter(Boolean)
}

function splitPairs(value: unknown, separator: string) {
  const out: Record<string, string> = {}
  for (const item of asPairList(value)) {
    const cut = item.indexOf(separator)
    if (cut <= 0) continue
    const key = item.slice(0, cut).trim()
    if (key) out[key] = item.slice(cut + separator.length).trim()
  }
  return out
}

/** env / headers 在表格里是字符串列表：env 用 KEY=VALUE，headers 用 Name: Value。 */
export function envToList(env: Record<string, string>) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`)
}

export function listToEnv(value: unknown) {
  return splitPairs(value, '=')
}

export function headersToList(headers: Record<string, string>) {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
}

export function listToHeaders(value: unknown) {
  return splitPairs(value, ':')
}

/** 认 `mcpServers`（Cursor / Claude Desktop）与顶层 `servers` 两种写法。 */
export function parseMcpConfig(raw: unknown): McpServerConfig[] {
  const root = asRecord(raw)
  const bag = asRecord(root.mcpServers ?? root.servers ?? root)
  const out: McpServerConfig[] = []
  for (const [id, value] of Object.entries(bag)) {
    const config = normalizeServerConfig(id, value)
    if (config) out.push(config)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 回写保持 mcpServers 结构，便于用户手写或粘到其它客户端。 */
export function serializeMcpConfig(servers: readonly McpServerConfig[]) {
  const bag: Record<string, unknown> = {}
  for (const server of [...servers].sort((a, b) => a.id.localeCompare(b.id))) {
    const row: Record<string, unknown> = {}
    if (server.transport === 'stdio') {
      row.command = server.command
      if (server.args.length) row.args = server.args
      if (Object.keys(server.env).length) row.env = server.env
      if (server.cwd) row.cwd = server.cwd
    } else {
      row.type = server.transport
      row.url = server.url
      if (Object.keys(server.headers).length) row.headers = server.headers
    }
    if (!server.enabled) row.enabled = false
    if (server.tools.allow.length || server.tools.deny.length) {
      row.tools = {
        ...(server.tools.allow.length ? { allow: server.tools.allow } : {}),
        ...(server.tools.deny.length ? { deny: server.tools.deny } : {}),
      }
    }
    bag[server.id] = row
  }
  return { mcpServers: bag }
}

/** 配置文件存在但读不了 / 解析不了。调用方必须停止回写，否则会把用户配置覆盖成空。 */
export class McpConfigReadError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`MCP 配置文件无法读取（${path}）：${reason}。为避免覆盖原配置，已暂停写入；修好文件后会自动恢复。`)
    this.name = 'McpConfigReadError'
  }
}

/** 文件不存在或为空时返回 []；其他错误抛 McpConfigReadError。 */
export function readMcpConfig(path = mcpConfigPath()): McpServerConfig[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new McpConfigReadError(path, error instanceof Error ? error.message : String(error))
  }
  if (!text.trim()) return []
  try {
    return parseMcpConfig(JSON.parse(text) as unknown)
  } catch (error) {
    throw new McpConfigReadError(path, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 原子写入：先写同目录临时文件再 rename 覆盖，避免 writeFileSync 先截断后写入时被中断，
 * 留下 0 字节或半截文件（0 字节会被当成「空配置」而失去保护，直接覆盖掉用户配置）。
 */
export function writeMcpConfig(servers: readonly McpServerConfig[], path = mcpConfigPath()) {
  mkdirSync(dirname(path), { recursive: true })
  const text = `${JSON.stringify(serializeMcpConfig(servers), null, 2)}\n`
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    const handle = openSync(temp, 'w', 0o600)
    try {
      writeFileSync(handle, text, 'utf8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
    throw error
  }
}

function matches(pattern: string, name: string) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === name
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '\u0000' : `\\${char}`))
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`).test(name)
}

/** 工具选择的唯一判定：deny 优先，allow 非空则白名单。 */
export function toolAllowed(filter: McpToolFilter, name: string) {
  if (filter.deny.some((pattern) => matches(pattern, name))) return false
  if (!filter.allow.length) return true
  return filter.allow.some((pattern) => matches(pattern, name))
}
