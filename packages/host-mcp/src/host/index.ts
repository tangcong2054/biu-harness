import { Service, type Context } from 'cordis'
import { statSync } from 'node:fs'
import { currentAccountId, currentRequestWorkspaceId, isOnlineRuntime } from '@biu/host-plugin-loader/data-dir'
import { mcpCollection } from './collection.ts'
import { McpConnection, type McpToolInfo } from './client.ts'
import { applyHostServer } from './serve.ts'
import {
  incompleteReason,
  mcpConfigPath,
  normalizeServerConfig,
  normalizeToolFilter,
  readMcpConfig,
  toolAllowed,
  writeMcpConfig,
  type McpServerConfig,
  type McpToolFilter,
} from './config.ts'

export type McpStatus = 'idle' | 'connecting' | 'ready' | 'error'

export type McpServerRow = {
  id: string
  transport: McpServerConfig['transport']
  command: string
  args: string[]
  url: string
  cwd: string
  enabled: boolean
  builtin: boolean
  status: McpStatus
  error: string
  serverName: string
  serverVersion: string
  connectedAt: number
  /** 过滤后暴露给 Agent 的工具数 / 服务器实际提供的工具数 */
  toolCount: number
  totalToolCount: number
  allow: string[]
  deny: string[]
}

/** 进程内 echo：不依赖子进程，让 MCP 这条缝在没有任何外部 server 时也可自检。 */
const ECHO_TOOLS: McpToolInfo[] = [
  {
    name: 'mcp_echo',
    description: 'echo arguments',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
]

type ServerState = {
  config: McpServerConfig
  status: McpStatus
  error: string
  tools: McpToolInfo[]
  connection?: McpConnection
  connectedAt: number
  builtin: boolean
  generation?: number
  opening?: Promise<void>
}

function echoState(): ServerState {
  return {
    config: normalizeServerConfig('echo', { command: 'builtin:echo' })!,
    status: 'ready',
    error: '',
    tools: ECHO_TOOLS,
    connectedAt: Date.now(),
    builtin: true,
  }
}

export class McpService extends Service {
  private scopes = new Map<string, Map<string, ServerState>>()
  /** 配置文件读失败的作用域 → 错误信息。存在时禁止回写。 */
  private loadErrors = new Map<string, string>()
  /** 作用域 → 上次读到的配置文件指纹，用于发现外部修改。 */
  private stamps = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'mcp')
    ctx.effect(() => () => void this.closeAll(), 'mcp.dispose-all')
    ctx.inject(['database'], (inner) => {
      inner.database.register(mcpCollection(this))
    })
  }

  private scope() {
    const accountId = currentAccountId()
    const store = (this.ctx.get('account') as {
      store?: {
        isMember?(accountId: string, workspaceId: string): boolean
        activeWorkspaceId?(): string | null
      }
    } | undefined)?.store
    if (!accountId && !isOnlineRuntime() && !store) return 'local'
    const workspaceId = currentRequestWorkspaceId() || (accountId ? store?.activeWorkspaceId?.() : '')
    if (!accountId || !workspaceId || !store?.isMember?.(accountId, workspaceId)) {
      throw new Error('MCP 操作需要当前账号的工作区成员身份')
    }
    return workspaceId
  }

  /** 配置文件指纹（mtime:size），用于发现外部修改后重新读盘。 */
  private fileStamp(path: string) {
    try {
      const info = statSync(path)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'none'
    }
  }

  private get servers() {
    const key = this.scope()
    const cached = this.scopes.get(key)
    let path = ''
    try {
      path = mcpConfigPath(undefined, key === 'local' ? '' : key)
    } catch (error) {
      // 拿不到工作区上下文：和「文件坏了」区分开，不要用那句提示误导用户。
      if (cached) return cached
      throw error
    }
    const stamp = this.fileStamp(path)
    if (cached && !this.loadErrors.has(key) && this.stamps.get(key) === stamp) return cached
    let configs: McpServerConfig[]
    try {
      configs = readMcpConfig(path)
    } catch (error) {
      // 配置文件坏了：只保留内置 echo，并记下错误；写操作会被 assertWritable 拦住，不回写覆盖原文件。
      const message = error instanceof Error ? error.message : String(error)
      if (this.loadErrors.get(key) !== message) {
        try {
          this.ctx.logger('mcp').warn(message)
        } catch {
          console.warn(message)
        }
      }
      this.loadErrors.set(key, message)
      this.stamps.set(key, stamp)
      if (cached) return cached
      const fallback = new Map<string, ServerState>([['echo', echoState()]])
      this.scopes.set(key, fallback)
      return fallback
    }
    // 读成功：清掉错误标记并按文件重建（之前读失败的占位、或文件被外部改过）。
    this.loadErrors.delete(key)
    this.stamps.set(key, stamp)
    const servers = new Map<string, ServerState>([['echo', echoState()]])
    this.scopes.set(key, servers)
    for (const config of configs) {
      if (config.id === 'echo') continue
      const prev = cached?.get(config.id)
      // 配置没变的沿用原连接，避免外部改动别的服务器时把正在跑的子进程一起重启。
      if (prev && !prev.builtin && JSON.stringify(prev.config) === JSON.stringify(config)) {
        servers.set(config.id, prev)
        continue
      }
      servers.set(config.id, {
        config, status: 'idle', error: '', tools: [], connectedAt: 0, builtin: false,
      })
    }
    // 被外部删掉或改掉的服务器：关掉旧连接，别留下孤儿子进程。
    for (const [id, state] of cached ?? []) {
      if (state.builtin || servers.get(id) === state) continue
      state.generation = (state.generation ?? 0) + 1
      const connection = state.connection
      state.connection = undefined
      void connection?.close().catch(() => undefined)
    }
    // 每个工作区首次访问时独立连接；不把其他工作区的 MCP 清单/连接带过来。
    for (const state of servers.values()) {
      if (!state.builtin && !state.connection && state.status !== 'connecting' && state.config.enabled && !incompleteReason(state.config)) {
        state.opening = this.connectInScope(key, state)
        void state.opening.catch(() => undefined)
      }
    }
    return servers
  }

  private async connectInScope(key: string, state: ServerState) {
    if (state.connection) return
    if (state.status === 'connecting') return state.opening
    const generation = state.generation = (state.generation ?? 0) + 1
    state.status = 'connecting'
    state.error = ''
    this.changed()
    try {
      const connection = await McpConnection.open(state.config)
      if (this.scopes.get(key)?.get(state.config.id) !== state || state.generation !== generation) {
        await connection.close()
        return
      }
      connection.onClosed((reason) => {
        if (state.connection !== connection) return
        state.connection = undefined
        state.status = 'error'
        state.error = reason || 'mcp server closed'
        state.tools = []
        this.changed()
      })
      state.connection = connection
      const tools = await connection.listTools()
      if (state.generation !== generation) {
        await connection.close()
        return
      }
      state.tools = tools
      state.status = 'ready'
      state.connectedAt = Date.now()
      state.error = ''
    } catch (error) {
      if (state.generation !== generation) return
      state.status = 'error'
      state.error = String(error instanceof Error ? error.message : error)
      state.tools = []
      const connection = state.connection
      state.connection = undefined
      await connection?.close()
      this.changed()
      throw error
    }
    this.changed()
  }

  /** 只有无账号的本机模式在启动时连接全局配置；工作区首次被访问时独立加载。 */
  async restore() {
    if (isOnlineRuntime() || this.ctx.get('account')) return
    const servers = this.servers
    await Promise.all([...servers.values()]
      .filter((state) => !state.builtin && state.config.enabled && !incompleteReason(state.config))
      .map((state) => state.opening?.catch(() => undefined)))
  }

  private changed() {
    this.ctx.emit('hub/change')
    try {
      this.ctx.emit('database/change')
    } catch {
      // File System 还没挂上时不影响 MCP 自身。
    }
  }

  private require(id: string) {
    const state = this.servers.get(id)
    if (state) return state
    // 配置读不出来时，别用「服务器不存在」误导调用方（Agent 会以为已经删掉了）。
    const error = this.loadErrors.get(this.scope())
    if (error) throw new Error(error)
    throw new Error(`unknown mcp server: ${id}`)
  }

  /** 写操作前调用：配置文件读不了时拒绝修改，避免内存里的空表覆盖原文件。 */
  private assertWritable() {
    void this.servers
    const error = this.loadErrors.get(this.scope())
    if (error) throw new Error(error)
  }

  private persist() {
    this.assertWritable()
    const servers = [...this.servers.values()].filter((state) => !state.builtin).map((state) => state.config)
    const key = this.scope()
    const path = mcpConfigPath(undefined, key === 'local' ? '' : key)
    writeMcpConfig(servers, path)
    // 记下自己写出来的指纹，别把自己的写入当成外部改动而重连一轮。
    this.stamps.set(key, this.fileStamp(path))
  }

  async connect(id: string) {
    const state = this.require(id)
    if (state.builtin) return this.row(state)
    const missing = incompleteReason(state.config)
    if (missing) {
      state.status = 'error'
      state.error = missing
      this.changed()
      throw new Error(`mcp server not configured yet: ${id} — ${missing}`)
    }
    if (state.connection) await this.disconnect(id)
    state.status = 'idle'
    state.opening = this.connectInScope(this.scope(), state)
    await state.opening
    return this.row(state)
  }

  async disconnect(id: string) {
    const state = this.require(id)
    if (state.builtin) throw new Error('cannot disconnect built-in echo server')
    state.generation = (state.generation ?? 0) + 1
    await state.connection?.close()
    state.connection = undefined
    state.tools = []
    state.status = 'idle'
    state.connectedAt = 0
    this.changed()
    return this.row(state)
  }

  /** 挂载/覆盖一台 server，在线模式写入当前工作区的配置；单机写入 .biu/mcp.json。 */
  async upsert(raw: Record<string, unknown> & { id: string }) {
    const config = normalizeServerConfig(raw.id, raw)
    if (!config) throw new Error(`invalid mcp server config: ${raw.id}`)
    if (config.id === 'echo') throw new Error('echo is reserved for the built-in server')
    this.assertWritable()
    const existing = this.servers.get(config.id)
    if (existing) await this.disconnect(config.id)
    this.servers.set(config.id, {
      config,
      status: 'idle',
      error: '',
      tools: [],
      connectedAt: 0,
      builtin: false,
    })
    this.persist()
    if (config.enabled) await this.connect(config.id)
    return this.row(this.require(config.id))
  }

  async setEnabled(id: string, enabled: boolean) {
    const state = this.require(id)
    if (state.builtin) throw new Error('built-in echo server is always enabled')
    this.assertWritable()
    state.config = { ...state.config, enabled }
    this.persist()
    if (!enabled) return this.disconnect(id)
    return this.connect(id)
  }

  configOf(id: string): McpServerConfig {
    const state = this.require(id)
    return { ...state.config, args: [...state.config.args], tools: { ...state.config.tools } }
  }

  /** 改 id：迁移配置并按需重连。表格里改「服务器」列走这条。 */
  async rename(id: string, nextId: string) {
    const state = this.require(id)
    if (state.builtin) throw new Error('cannot rename the built-in echo server')
    this.assertWritable()
    const wanted = String(nextId ?? '').trim()
    if (wanted === id) return this.row(state)
    if (this.servers.has(wanted)) throw new Error(`mcp server already exists: ${wanted}`)
    const config = normalizeServerConfig(wanted, { ...state.config, id: wanted })
    if (!config) throw new Error(`invalid mcp server id: ${nextId}`)
    const wasConnected = Boolean(state.connection)
    state.generation = (state.generation ?? 0) + 1
    await state.connection?.close()
    this.servers.delete(id)
    this.servers.set(wanted, {
      config,
      status: 'idle',
      error: '',
      tools: [],
      connectedAt: 0,
      builtin: false,
    })
    this.persist()
    if (wasConnected || (config.enabled && !incompleteReason(config))) {
      await this.connect(wanted).catch(() => undefined)
    }
    this.changed()
    return this.row(this.require(wanted))
  }

  /**
   * 合并配置字段。只有连接参数变了才重连；工具选择与开关各走各的路，
   * 这样在表格里改一个 deny 不会白白掐断一条正常连接。
   */
  async patchConfig(id: string, patch: Partial<McpServerConfig>) {
    const state = this.require(id)
    if (state.builtin) throw new Error('cannot edit the built-in echo server')
    this.assertWritable()
    const before = state.config
    const merged = normalizeServerConfig(id, { ...before, ...patch, id })
    if (!merged) throw new Error(`invalid mcp server config: ${id}`)
    const dialKeys = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers'] as const
    const redial = dialKeys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(merged[key]))
    state.config = merged
    this.persist()
    this.changed()
    if (redial) {
      if (state.connection) await this.disconnect(id)
      if (merged.enabled && !incompleteReason(merged)) await this.connect(id).catch(() => undefined)
      return this.row(this.require(id))
    }
    if (merged.enabled !== before.enabled) return this.setEnabled(id, merged.enabled).catch(() => this.row(state))
    return this.row(state)
  }

  /** 工具选择：只改配置，读时过滤立即生效，不需要重连。 */
  setToolFilter(id: string, filter: unknown) {
    const state = this.require(id)
    if (state.builtin) throw new Error('cannot filter the built-in echo server')
    this.assertWritable()
    state.config = { ...state.config, tools: normalizeToolFilter(filter) }
    this.persist()
    this.changed()
    return this.row(state)
  }

  async remove(id: string) {
    await this.removeMany([id])
    return { id, removed: true }
  }

  /** 批量删除：先校验全部 id，再一起删除并只写一次配置；任一 id 不合法时一个都不删。 */
  async removeMany(ids: readonly string[]) {
    const unique = [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
    const states = unique.map((id) => {
      const state = this.require(id)
      if (state.builtin) throw new Error('cannot remove built-in echo server')
      return state
    })
    this.assertWritable()
    for (const state of states) {
      state.generation = (state.generation ?? 0) + 1
      await state.connection?.close().catch(() => undefined)
      state.connection = undefined
    }
    for (const id of unique) this.servers.delete(id)
    this.persist()
    this.changed()
    return unique
  }

  /** 重新拉取工具清单（server 端热更新了工具时用）。 */
  async refresh(id: string) {
    const state = this.require(id)
    if (state.builtin) return this.row(state)
    if (!state.connection) return this.connect(id)
    state.tools = await state.connection.listTools()
    this.changed()
    return this.row(state)
  }

  /** 界面「新建」用：先落一行停用的 stdio 草稿，字段在表格里慢慢填。 */
  draft() {
    this.assertWritable()
    let id = 'new-server'
    for (let n = 2; this.servers.has(id); n++) id = `new-server-${n}`
    const config = normalizeServerConfig(id, { transport: 'stdio', command: '', enabled: false })
    if (!config) throw new Error(`cannot create mcp draft: ${id}`)
    this.servers.set(id, {
      config,
      status: 'idle',
      error: '',
      tools: [],
      connectedAt: 0,
      builtin: false,
    })
    this.persist()
    this.changed()
    return this.row(this.require(id))
  }

  /** 兼容旧签名：等价于 upsert 一台 stdio server 并连上。 */
  async addStdio(id: string, command: string, args: string[] = [], extra: Record<string, unknown> = {}) {
    await this.upsert({ ...extra, id, command, args, transport: 'stdio' })
    return this.listTools()
  }

  private visibleTools(state: ServerState) {
    if (state.builtin) return state.tools
    return state.tools.filter((tool) => toolAllowed(state.config.tools, tool.name))
  }

  listTools(serverId?: string) {
    const states = serverId ? [this.require(serverId)] : [...this.servers.values()]
    return states.flatMap((state) =>
      this.visibleTools(state).map((tool) => ({ server: state.config.id, ...tool })),
    )
  }

  toolExecutionMode(serverId: string, name: string): 'parallel' | 'exclusive' {
    const state = this.servers.get(serverId)
    const tool = state && this.visibleTools(state).find((item) => item.name === name)
    return tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true
      ? 'parallel'
      : 'exclusive'
  }

  /** 未过滤的全量清单，供 /mcp 表勾选工具用。 */
  catalog(serverId: string) {
    const state = this.require(serverId)
    return state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      allowed: state.builtin || toolAllowed(state.config.tools, tool.name),
    }))
  }

  private row(state: ServerState): McpServerRow {
    const info = state.connection?.serverInfo()
    // 草稿行没有真错误，但要在 error 列告诉用户还差什么。
    const missing = state.builtin ? '' : incompleteReason(state.config)
    return {
      id: state.config.id,
      transport: state.config.transport,
      command: state.config.command,
      args: [...state.config.args],
      url: state.config.url,
      cwd: state.config.cwd,
      enabled: state.builtin ? true : state.config.enabled,
      builtin: state.builtin,
      status: state.status,
      error: state.error || missing,
      serverName: info?.name ?? '',
      serverVersion: info?.version ?? '',
      connectedAt: state.connectedAt,
      toolCount: this.visibleTools(state).length,
      totalToolCount: state.tools.length,
      allow: [...state.config.tools.allow],
      deny: [...state.config.tools.deny],
    }
  }

  listServers(): McpServerRow[] {
    return [...this.servers.values()]
      .map((state) => this.row(state))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  serverIds() {
    return [...this.servers.keys()].sort()
  }

  async call(serverId: string, name: string, args: Record<string, unknown>) {
    const state = this.require(serverId)
    if (state.builtin) {
      if (name !== 'mcp_echo') throw new Error(`unknown mcp tool: ${name}`)
      return { text: String(args.text ?? '') }
    }
    // 工具选择是硬约束：被排除的工具即使 Agent 猜到名字也调不动。
    if (!toolAllowed(state.config.tools, name)) {
      throw new Error(`mcp tool disabled by server config: ${serverId}/${name}`)
    }
    if (state.status === 'connecting') await state.opening
    // 连接中工作区配置可能被另一个请求删除/替换；发起调用前重新校验。
    if (this.require(serverId) !== state) {
      throw new Error(`mcp server not available in this workspace: ${serverId}`)
    }
    if (!state.connection || !state.config.enabled) {
      throw new Error(`mcp server not connected: ${serverId} (${state.error || state.status})`)
    }
    return state.connection.callTool(name, args)
  }

  private async closeAll() {
    for (const servers of this.scopes.values()) {
      for (const state of servers.values()) {
        state.generation = (state.generation ?? 0) + 1
        await state.connection?.close()
      }
      servers.clear()
    }
    this.scopes.clear()
    this.loadErrors.clear()
    this.stamps.clear()
  }
}

export const name = 'mcp'
export const inject = ['tools']

export function apply(ctx: Context) {
  const mcp = new McpService(ctx)
  void mcp.restore()
  ctx.inject(['http'], (inner) => applyHostServer(inner))

  ctx.tools.register({
    name: 'mcp_servers',
    description:
      '列出已挂载的 MCP 服务器及连接状态（status: ready/idle/connecting/error）。toolCount 是工具选择后暴露的数量，totalToolCount 是服务器实际提供的数量。',
    parameters: { type: 'object', properties: {} },
    execution: 'parallel',
    execute: () => mcp.listServers(),
  })
  ctx.tools.register({
    name: 'mcp_list',
    description:
      '列出 MCP 工具（已按各服务器的工具选择过滤）。不传 server 就列全部。拿到 server + name + inputSchema 后用 mcp_call 调用。',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: '只列这台服务器的工具' } },
    },
    execution: 'parallel',
    execute: (args) => {
      const server = String(args.server ?? '').trim()
      return mcp.listTools(server || undefined)
    },
  })
  ctx.tools.register({
    name: 'mcp_call',
    description: '调用 MCP 工具。server 与 name 取自 mcp_list；被禁用的工具会直接报错。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        name: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['server', 'name'],
    },
    execution: (args) => mcp.toolExecutionMode(String(args.server), String(args.name)),
    execute: (args) =>
      mcp.call(String(args.server), String(args.name), (args.arguments as Record<string, unknown>) ?? {}),
  })
  ctx.tools.register({
    name: 'mcp_add_stdio',
    description:
      '挂载 stdio MCP 服务（command + args），在线模式写入当前工作区配置，单机写入 .biu/mcp.json，重启后保留。远端服务器请用 /mcp 表填写 url。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', description: '追加的环境变量' },
        cwd: { type: 'string', description: '子进程工作目录' },
      },
      required: ['id', 'command'],
    },
    execute: (args) =>
      mcp.addStdio(String(args.id), String(args.command), Array.isArray(args.args) ? args.args.map(String) : [], {
        env: args.env,
        cwd: args.cwd,
      }),
  })
  ctx.tools.register({
    name: 'mcp_remove',
    description: '卸载 MCP 服务：断开连接并从 .biu/mcp.json 删掉。只想临时停用请改用 /mcp 表的 disable 动作。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execute: (args) => mcp.remove(String(args.id)),
  })
}

export type { McpServerConfig, McpToolFilter }
export { mcpConfigPath, parseMcpConfig, serializeMcpConfig, toolAllowed } from './config.ts'
