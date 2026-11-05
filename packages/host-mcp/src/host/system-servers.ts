import { normalizeServerConfig, type McpServerConfig } from './config.ts'

/**
 * 桌面安装包内置的远程 MCP。只在打包后的宿主设置 BIU_SYSTEM_MCP=1 时挂上。
 * 凭证留在程序里，不写入工作区的 mcp.json。
 * gongfeng 原来的 timeout 是 60，按秒换算成 60000 毫秒。
 */
const SYSTEM_MCP_SERVERS: Array<Record<string, unknown> & { id: string }> = [
  {
    id: 'cloud-dba-ai-cdb-mcpserver',
    type: 'http',
    url: 'https://cloud-dba-ai-cdb-pre.mcp.it.woa.com/cdb/',
    timeoutMs: 60_000,
    headers: {
      Authorization: 'Bearer tai_pat_iAOP1r3FtM1xjhAULHyfs_6O2goGlUGaQRchnUuDoG4.G-Ck2fOa354ywY0SgTIwyrvGMy3cYG_5Ch6WgJMAPwA',
    },
  },
  {
    id: 'tapd',
    title: 'TAPD官方MCP',
    type: 'http',
    url: 'https://tapd.mcp.woa.com',
    headers: {
      Authorization: 'Bearer tai_pat_edYdcOGBFhB8zF5CFV8MSbNSC42Id-_67hUVpPiZKwQ.gdWZtiEaqq08OOnYu5rGKr4S_BT6NQaknUdDub4tjZw',
    },
  },
  {
    id: 'iWiki',
    type: 'http',
    url: 'https://prod.mcp.it.woa.com/app_iwiki_mcp/mcp3',
    headers: {
      Authorization: 'Bearer tai_pat_Vv-_TUpC4C8NW7wCB5vC0vZ2COc9n_LuruBZ1RjdeLE.J_RU6YBV55dQaU-69QdPJIju7oLeiS70Z1oLwiq8qRQ',
    },
  },
  {
    id: 'gongfeng',
    type: 'http',
    url: 'https://mcpgw.knot.woa.com/gongfeng',
    timeoutMs: 60_000,
    headers: {
      Authorization: 'Bearer tai_pat_Vv-_TUpC4C8NW7wCB5vC0vZ2COc9n_LuruBZ1RjdeLE.J_RU6YBV55dQaU-69QdPJIju7oLeiS70Z1oLwiq8qRQ',
    },
  },
  {
    id: 'CDB_CLS_MCP_SERVER',
    type: 'sse',
    url: 'http://api.open.vedas.woa.com/mcp/api/CDB_CLS_MCP_SERVER/ins_AoLU87MWjI/sse',
    timeoutMs: 30_000,
    headers: {
      Authorization: 'Bearer HmxqsW4rNxys9qYSl89B9GTK@4661',
      'x-request-from': 'router',
    },
  },
]

export function systemMcpConfigs(): McpServerConfig[] {
  if (process.env.BIU_SYSTEM_MCP !== '1') return []
  const override = Number(process.env.BIU_SYSTEM_MCP_TIMEOUT || 0)
  return SYSTEM_MCP_SERVERS.map((raw) => {
    const config = normalizeServerConfig(raw.id, raw)
    if (!config?.url) throw new Error(`invalid system mcp server: ${raw.id}`)
    return override > 0 ? { ...config, timeoutMs: override } : config
  })
}

export function systemMcpIds() {
  return new Set(systemMcpConfigs().map((config) => config.id))
}
