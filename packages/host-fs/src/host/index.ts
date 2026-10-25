import { mkdirSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Service, type Context } from 'cordis'
import { currentSessionId } from '@biu/host-sessions/scope'
import {
  currentRequestWorkspaceId,
  dataHome,
  dataPath,
  isOnlineRuntime,
} from '@biu/host-plugin-loader/data-dir'
import {
  STR_REPLACE_EDITOR_DESCRIPTION,
  STR_REPLACE_EDITOR_PARAMETERS,
  runStrReplaceEditor,
} from './str-replace-editor.ts'

export class FsService extends Service {
  constructor(
    ctx: Context,
    public defaultRoot: string,
  ) {
    super(ctx, 'fs')
    this.defaultRoot = resolve(defaultRoot)
  }

  /** 当前生效工作区：Online 使用受控云端目录；Offline 可绑定本机目录。 */
  get root() {
    return this.effectiveRoot()
  }

  effectiveRoot() {
    if (isOnlineRuntime()) {
      const sessionId = currentSessionId()
      return sessionId ? this.onlineSessionRoot(sessionId) : this.onlineSystemRoot()
    }
    return this.sessionProjectRoot() ?? this.defaultRoot
  }

  /** Online 的稳定根目录；不复用或迁移旧 `<repo>/.workspace`。 */
  onlineWorkspacesRoot() {
    return dataPath(dataHome(), 'workspaces')
  }

  onlineSystemRoot() {
    return this.ensureRoot(join(this.onlineWorkspacesRoot(), '_system'))
  }

  /**
   * Online 每个 Workspace/Session 一块独立目录。
   * workspaceId 优先取当前请求，后台 Agent 则从 Session 归属反查。
   */
  onlineSessionRoot(sessionId: string) {
    const workspaceId = this.workspaceIdForSession(sessionId) || '_unassigned'
    const root = join(
      this.onlineWorkspacesRoot(),
      `workspace-${encodeURIComponent(workspaceId)}`,
      'sessions',
      `session-${encodeURIComponent(sessionId)}`,
    )
    return this.ensureRoot(root)
  }

  async onlineSessionRootAsync(sessionId: string) {
    const requested = currentRequestWorkspaceId().trim()
    let workspaceId = requested || this.sessionWorkspaces.get(sessionId) || ''
    if (!workspaceId) {
      const account = this.ctx.get('account') as {
        tenantForRecord?(collection: string, recordId: string): Promise<{ workspaceId?: string } | null>
      } | undefined
      workspaceId = String((await account?.tenantForRecord?.('/sessions', sessionId))?.workspaceId ?? '').trim()
    }
    this.rememberSessionWorkspace(sessionId, workspaceId)
    const root = join(
      this.onlineWorkspacesRoot(),
      `workspace-${encodeURIComponent(workspaceId || '_unassigned')}`,
      'sessions',
      `session-${encodeURIComponent(sessionId)}`,
    )
    return this.ensureRoot(root)
  }

  async effectiveRootAsync() {
    if (!isOnlineRuntime()) return this.sessionProjectRoot() ?? this.defaultRoot
    const sessionId = currentSessionId()
    return sessionId ? this.onlineSessionRootAsync(sessionId) : this.onlineSystemRoot()
  }

  sessionProjectRoot() {
    const sessionId = currentSessionId()
    if (!sessionId) return null
    const sessions = this.ctx.get('sessions') as { peek?: (id: string) => { project?: { path?: string } } | undefined } | undefined
    const path = sessions?.peek?.(sessionId)?.project?.path
    return path ? resolve(path) : null
  }

  private workspaceIdForSession(sessionId: string) {
    let account:
      | {
          usesMysqlAccounts?(): boolean
          tenantForRecord?(
            collection: string,
            recordId: string,
          ): Promise<{ workspaceId?: string } | null>
          store?: {
            tenantForRecord?(
              collection: string,
              recordId: string,
            ): { workspaceId?: string } | null
          }
        }
      | undefined
    try {
      account = this.ctx.get('account') as typeof account
    } catch {
      account = undefined
    }
    const requested = currentRequestWorkspaceId().trim()
    if (requested) {
      this.rememberSessionWorkspace(sessionId, requested)
      return requested
    }
    // 会话归属不会变：异步路径（或带请求工作区的调用）解析过一次后，同步入口直接复用。
    const known = this.sessionWorkspaces.get(sessionId)
    if (known) return known
    // MySQL 控制面下归属只在云端，同步读本机 SQLite 只会拿到空表，不能回退。
    // SQLite 控制面下 AccountService 也有异步 tenantForRecord，但本机 store 就是权威，可以同步读。
    if (!account?.usesMysqlAccounts?.()) {
      const ownedWorkspaceId = String(
        account?.store?.tenantForRecord?.('/sessions', sessionId)?.workspaceId ?? '',
      ).trim()
      if (ownedWorkspaceId) {
        this.rememberSessionWorkspace(sessionId, ownedWorkspaceId)
        return ownedWorkspaceId
      }
    }
    if (!this.warnedUnassigned.has(sessionId)) {
      this.warnedUnassigned.add(sessionId)
      try {
        this.ctx.logger('fs').warn(
          'session %s has no resolved workspace; files fall back to _unassigned (call effectiveRootAsync first)',
          sessionId,
        )
      } catch {
        /* logger 不可用时不影响文件读写 */
      }
    }
    return ''
  }

  private readonly sessionWorkspaces = new Map<string, string>()
  private readonly warnedUnassigned = new Set<string>()

  private rememberSessionWorkspace(sessionId: string, workspaceId: string) {
    if (!sessionId || !workspaceId) return
    this.sessionWorkspaces.set(sessionId, workspaceId)
    this.warnedUnassigned.delete(sessionId)
  }

  private ensureRoot(root: string) {
    mkdirSync(root, { recursive: true })
    return root
  }

  resolveIn(root: string, rel: string) {
    const input = String(rel)
    const full = isAbsolute(input) ? resolve(input) : resolve(root, input)
    const relToRoot = relative(root, full)
    if (relToRoot.startsWith('..') || (!isAbsolute(input) && normalize(input).startsWith('..'))) {
      throw new Error('path escapes workspace')
    }
    return full
  }

  async readIn(root: string, rel: string) {
    const path = this.resolveIn(root, rel)
    this.ctx.emit('fs/read', rel)
    return readFile(path, 'utf8')
  }

  async writeIn(root: string, rel: string, content: string) {
    const path = this.resolveIn(root, rel)
    await mkdir(dirname(path), { recursive: true })
    this.ctx.emit('fs/write', rel)
    await writeFile(path, content, 'utf8')
    return { ok: true, path: rel }
  }

  async listIn(root: string, rel = '.') {
    const path = this.resolveIn(root, rel)
    this.ctx.emit('fs/list', rel)
    return readdir(path)
  }

  resolve(rel: string) {
    return this.resolveIn(this.effectiveRoot(), rel)
  }

  async read(rel: string) {
    return this.readIn(await this.effectiveRootAsync(), rel)
  }

  async write(rel: string, content: string) {
    return this.writeIn(await this.effectiveRootAsync(), rel, content)
  }

  async list(rel = '.') {
    return this.listIn(await this.effectiveRootAsync(), rel)
  }

  /** 稳定工作区（defaultRoot，不随 Session 绑定漂移）：供 DB 集合等需要固定落盘的场景使用。 */
  get workspace(): WorkspaceFs {
    const root = this.defaultRoot
    return {
      resolve: (rel: string) => this.resolveIn(root, rel),
      read: (rel: string) => this.readIn(root, rel),
      write: (rel: string, content: string) => this.writeIn(root, rel, content),
      list: (rel?: string) => this.listIn(root, rel ?? '.'),
    }
  }
}

export type WorkspaceFs = {
  resolve: (rel: string) => string
  read: (rel: string) => Promise<string>
  write: (rel: string, content: string) => Promise<unknown>
  list: (rel?: string) => Promise<string[]>
}

export const name = 'fs'
export const inject = ['tools']

export function apply(ctx: Context, config: { root?: string } = {}) {
  const root = config.root ?? process.env.CORDIS_WORKSPACE ?? join(process.cwd(), '.workspace')
  const fs = new FsService(ctx, root)
  void mkdir(root, { recursive: true })
  ctx.tools.register({
    name: 'fs_read',
    description: '读取工作区内文件（若 Session 已绑定项目路径，则为该目录）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: (args) => fs.read(String(args.path)),
  })
  ctx.tools.register({
    name: 'fs_write',
    description: '写入工作区内文件（若 Session 已绑定项目路径，则为该目录）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    execute: (args) => fs.write(String(args.path), String(args.content ?? '')),
  })
  ctx.tools.register({
    name: 'fs_list',
    description: '列出工作区目录（若 Session 已绑定项目路径，则为该目录）',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: (args) => fs.list(String(args.path || '.')),
  })
  ctx.tools.register({
    name: 'str_replace_editor',
    description: STR_REPLACE_EDITOR_DESCRIPTION,
    parameters: { ...STR_REPLACE_EDITOR_PARAMETERS },
    execute: (args) => runStrReplaceEditor(fs, args),
  })

  ctx.inject(['systemPrompt', 'sessions'], (inner) => {
    inner.systemPrompt.register('session.project', () => {
      const sessionId = currentSessionId()
      if (!sessionId) return ''
      if (isOnlineRuntime()) {
        return `当前 Session 使用云端受控工作区：${fs.onlineSessionRoot(sessionId)}。bash / 文件工具只能读写该目录。`
      }
      const project = inner.sessions.peek(sessionId)?.project
      if (!project?.path) return ''
      return `当前 Session 绑定 host 工作区「${project.name}」：${project.path}。bash / 文件工具直接读写该目录（对齐 dsh workspace cwd）。`
    })
  })
}
