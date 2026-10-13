import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type RegistryConfig = {
  /** 商店身份。换部署地址时保持不变，本机 origins 靠它认同一家商店。 */
  id: string
  /** Registry 服务存放安装包的目录。Biu 客户端使用远端时不会读这个目录。 */
  dataDir: string
  /** Biu 客户端访问的 API 根地址。空字符串仅用于兼容内嵌模式。 */
  url: string
  /** 独立 Registry 服务监听地址。 */
  listenHost: string
  listenPort: number
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/

export function registryConfigPath(cwd = process.cwd()) {
  const fromEnv = String(process.env.BIU_PLUGIN_REGISTRY_CONFIG ?? '').trim()
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(cwd, fromEnv)
  return join(cwd, 'plugin-registry.config.json')
}

export function loadRegistryConfig(cwd = process.cwd(), path = registryConfigPath(cwd)): RegistryConfig {
  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
    } catch {
      throw new Error(`invalid plugin registry config: ${path}`)
    }
  }
  const id = String(process.env.BIU_PLUGIN_REGISTRY_ID ?? raw.id ?? 'local').trim() || 'local'
  if (!ID_RE.test(id)) throw new Error(`invalid plugin registry id: ${id}`)
  const dirRaw = String(process.env.BIU_PLUGIN_REGISTRY_DIR ?? raw.dataDir ?? '.plugin-registry').trim() || '.plugin-registry'
  const dataDir = isAbsolute(dirRaw) ? dirRaw : resolve(cwd, dirRaw)
  const url = String(process.env.BIU_PLUGIN_REGISTRY ?? raw.url ?? '').trim().replace(/\/+$/, '')
  const listenHost = String(process.env.BIU_PLUGIN_REGISTRY_HOST ?? raw.listenHost ?? '127.0.0.1').trim() || '127.0.0.1'
  const listenPort = Number(process.env.BIU_PLUGIN_REGISTRY_PORT ?? raw.listenPort ?? 3161)
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error(`invalid plugin registry port: ${listenPort}`)
  }
  return { id, dataDir, url, listenHost, listenPort }
}
