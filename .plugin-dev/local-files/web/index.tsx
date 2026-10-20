/**
 * 本地文件（local-files）：在 Biu 里像 VS Code 一样打开你电脑上的文件 / 文件夹。
 *   - 页面块 kind=local-file：斜杠插入，或直接把文件 / 文件夹拖进页面；块可切到右侧栏 / 全屏。
 *   - 会话右侧栏「本地文件」tab：本浏览器里打开过的所有本地根。
 *   - uiActions：agent 可列目录、读文件、打开文件；写文件为 destructive，每次需用户确认。
 * 文件内容只在浏览器里读写；只有点「保存快照到页面」才会把当前文件上传成页面附件。
 */
import { SnapshotRoot, baseName, type EntryKind } from './fs.ts'
import { formatBytes as formatSize } from './kinds.ts'
import { addMemoryRoot, rootById, subscribeRoots } from './roots.ts'
import { Icon, Workbench, pickFileRoots, pickFolderRoots, rootsFromDrop, type OpenRef } from './workbench.tsx'
import { PLUGIN_ID, ensureStyles, runtime, type UiActionsApi } from './runtime.ts'
import type { PickApi } from './selection.ts'

const React = globalThis.React
const { useCallback, useEffect, useState } = React

export const name = PLUGIN_ID
export const inject = ['pageEditor', 'slots', 'uiActions', 'pick']

const BLOCK_KIND = 'local-file'
const DEFAULT_HEIGHT = 460
const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024

type Snapshot = { href: string; name: string; path: string; size: number; savedAt: number }

type BlockData = {
  title?: string
  rootId?: string
  rootName?: string
  rootKind?: EntryKind
  path?: string
  height?: number
  snapshot?: Snapshot
}

type Presentation = {
  mode: 'inline' | 'sidebar' | 'maximized' | 'minimized'
  detached: boolean
  inline: () => void
  sidebar: () => void
  maximize: () => void
}

type BlockProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>, opts?: { replace?: boolean }) => void
  writable: boolean
  presentation?: Presentation
}

function blockHeight(data: BlockData) {
  const n = Number(data.height)
  return Number.isFinite(n) && n >= 200 ? Math.round(n) : DEFAULT_HEIGHT
}

function snapshotOf(data: BlockData): Snapshot | null {
  const snap = data.snapshot
  if (!snap || typeof snap !== 'object' || typeof snap.href !== 'string' || !snap.href.startsWith('/api/db/file/')) return null
  return snap
}

/** 新根 → 块 data。 */
async function blockDataFor(rootId: string): Promise<Record<string, unknown> | null> {
  const root = await rootById(rootId)
  if (!root) return null
  return {
    title: root.name,
    rootId: root.id,
    rootName: root.name,
    rootKind: root.kind,
    path: root.kind === 'file' ? root.name : '',
  }
}

async function uploadSnapshot(file: File, name: string) {
  const hint = `${Date.now()}-${name.replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'file'}`
  const res = await fetch(`/api/db/file/hash/${encodeURIComponent(hint)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; href?: string; name?: string }
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body.href || `/api/db/file/${encodeURIComponent(body.name || hint)}`
}

/** 别人的浏览器里没有本地根时，用页面快照（只读）兜底。 */
async function snapshotRootId(snap: Snapshot) {
  const id = `snap:${snap.href}`
  if (await rootById(id)) return id
  const res = await fetch(snap.href, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`快照读取失败：${res.status}`)
  const blob = await res.blob()
  const file = new File([blob], snap.name, { lastModified: snap.savedAt })
  addMemoryRoot(new SnapshotRoot(id, snap.name, 'file', [{ path: snap.name, file }]))
  return id
}

/* ---------------- 页面块 ---------------- */

function LocalFileBlock({ data: raw, update, writable, presentation }: BlockProps) {
  ensureStyles()
  const data = raw as BlockData
  const rootId = String(data.rootId ?? '')
  const snap = snapshotOf(data)
  const [status, setStatus] = useState<'loading' | 'live' | 'missing' | 'empty'>(rootId ? 'loading' : 'empty')
  const [snapId, setSnapId] = useState('')
  const [snapError, setSnapError] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<OpenRef | null>(null)
  const presented = Boolean(presentation && (presentation.mode === 'sidebar' || presentation.mode === 'maximized'))

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (!rootId) {
        setStatus('empty')
        return
      }
      const root = await rootById(rootId)
      if (!cancelled) setStatus(root ? 'live' : 'missing')
    }
    void check()
    const stop = subscribeRoots(() => void check())
    return () => {
      cancelled = true
      stop()
    }
  }, [rootId])

  useEffect(() => {
    if (status !== 'missing' || !snap) return
    let cancelled = false
    setSnapError('')
    snapshotRootId(snap)
      .then((id) => !cancelled && setSnapId(id))
      .catch((error) => !cancelled && setSnapError(error instanceof Error ? error.message : String(error)))
    return () => {
      cancelled = true
    }
  }, [status, snap?.href])

  const bind = useCallback(async (ids: string[]) => {
    if (!writable || !ids.length) return
    const next = await blockDataFor(ids[0])
    if (next) update({ ...next, height: data.height ?? DEFAULT_HEIGHT })
  }, [writable, update, data.height])

  const onActiveChange = useCallback((ref: OpenRef | null) => {
    setActive(ref)
    if (!writable || !ref || ref.rootId !== rootId || ref.path === data.path) return
    update({ path: ref.path })
  }, [writable, rootId, data.path, update])

  const saveSnapshot = useCallback(async () => {
    const root = await rootById(rootId)
    const path = active?.rootId === rootId ? active.path : String(data.path ?? '')
    if (!root || !path) {
      window.alert('先在左侧打开一个文件，再保存快照')
      return
    }
    const ok = window.confirm(
      `将把「${baseName(path)}」当前已保存的内容上传到服务器，作为页面附件。\n能看到这个页面的人都能查看这份快照（不会自动同步后续修改）。\n\n继续？`,
    )
    if (!ok) return
    setBusy(true)
    try {
      const file = await root.file(path)
      if (file.size > SNAPSHOT_MAX_BYTES) throw new Error(`文件 ${formatSize(file.size)}，超过快照上限 ${formatSize(SNAPSHOT_MAX_BYTES)}`)
      const href = await uploadSnapshot(file, baseName(path))
      update({ snapshot: { href, name: baseName(path), path, size: file.size, savedAt: Date.now() } satisfies Snapshot })
    } catch (error) {
      window.alert(`保存快照失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [rootId, active, data.path, update])

  const toolbar = (
    <>
      {status === 'live' && writable ? (
        <button
          type="button"
          className="lf-icon-btn"
          title={snap ? `更新页面快照（上次：${new Date(snap.savedAt).toLocaleString()}）` : '保存快照到页面（上传当前文件，让其他人也能看到）'}
          disabled={busy}
          style={snap ? { color: 'var(--lf-accent)' } : undefined}
          onClick={() => void saveSnapshot()}
        >
          <Icon id="save" />
        </button>
      ) : null}
      {snap && writable ? (
        <button type="button" className="lf-icon-btn" title="删除页面快照" onClick={() => window.confirm('删除这个块里的页面快照？') && update({ snapshot: null })}>
          <Icon id="trash" />
        </button>
      ) : null}
      {presentation ? (
        presentation.detached ? (
          <button type="button" className="lf-icon-btn" title="放回页面" onClick={() => presentation.inline()}>
            <Icon id="close" />
          </button>
        ) : (
          <>
            <button type="button" className="lf-icon-btn" title="在右侧栏打开" onClick={() => presentation.sidebar()}>
              <Icon id="sidebar" />
            </button>
            <button type="button" className="lf-icon-btn" title="全屏" onClick={() => presentation.maximize()}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
            </button>
          </>
        )
      ) : null}
    </>
  )

  const frame = (child: unknown) => (
    <div
      data-testid="local-file-block"
      style={{ width: '100%', height: presented ? '100%' : blockHeight(data), minHeight: presented ? 0 : undefined, display: 'flex' }}
    >
      {child as never}
    </div>
  )

  if (status === 'loading') return frame(<div className="lf-wb"><div className="lf-empty" style={{ flex: 1 }}>加载中…</div></div>)

  if (status === 'empty') {
    return frame(
      <Workbench rootIds={[]} allowAddRoots={writable} onRootsAdded={(ids) => void bind(ids)} label="本地文件（未选择）" flat={presented} />,
    )
  }

  if (status === 'missing') {
    if (snapId) {
      return frame(
        <Workbench
          rootIds={[snapId]}
          initial={{ rootId: snapId, path: snap!.name }}
          allowAddRoots={false}
          label={`页面快照：${snap!.name}`}
          flat={presented}
          explorerOpen={false}
          toolbar={
            <>
              <span className="lf-badge" title={`快照保存于 ${new Date(snap!.savedAt).toLocaleString()}`}>页面快照</span>
              {toolbar}
            </>
          }
        />,
      )
    }
    const what = data.rootKind === 'directory' ? '文件夹' : '文件'
    return frame(
      <div className={`lf-wb${presented ? ' is-flat' : ''}`}>
        <div className="lf-empty" style={{ flex: 1 }}>
          <h4>本地{what}「{data.rootName || '未命名'}」</h4>
          <div>它在添加者的电脑上，只能在添加它的那个浏览器里打开。</div>
          {snapError ? <div style={{ color: '#b91c1c' }}>{snapError}</div> : null}
          {writable ? (
            <>
              <div>如果这是你的文件，可以重新选择来关联：</div>
              <div className="lf-actions">
                <button type="button" className="lf-btn is-primary" onClick={() => void pickFolderRoots().then(bind)}>
                  <Icon id="folder" /> 选择文件夹
                </button>
                <button type="button" className="lf-btn" onClick={() => void pickFileRoots().then(bind)}>
                  <Icon id="file" /> 选择文件
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>,
    )
  }

  return frame(
    <Workbench
      rootIds={[rootId]}
      initial={data.path ? { rootId, path: String(data.path) } : null}
      allowAddRoots={false}
      onActiveChange={onActiveChange}
      label={`本地文件：${data.rootName ?? ''}`}
      flat={presented}
      explorerOpen={data.rootKind !== 'file'}
      toolbar={toolbar}
    />,
  )
}

function LocalFileMinimized({ data: raw }: BlockProps) {
  const data = raw as BlockData
  const path = String(data.path ?? '')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#4b5563' }}>
      <Icon id={data.rootKind === 'directory' ? 'folder' : 'file'} />
      <span>{data.rootName || '本地文件'}</span>
      {path && path !== data.rootName ? <span style={{ color: '#9ca3af' }}>/ {path}</span> : null}
    </div>
  )
}

/* ---------------- 会话右侧栏 ---------------- */

function SidebarPanel() {
  return (
    <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <Workbench rootIds="all" allowAddRoots surface="inspector" label="右侧栏本地文件" flat explorerOpen />
    </div>
  )
}

/* ---------------- 登记 ---------------- */

type Ctx = {
  pick: PickApi
  uiActions?: UiActionsApi
  pageEditor: { registerBlock: (spec: Record<string, unknown>) => void }
  slots: {
    place: (
      name: string,
      Component: (props: Record<string, unknown>) => unknown,
      options?: { key?: string; order?: number; props?: () => Record<string, unknown> },
    ) => unknown
  }
}

export function apply(ctx: Ctx) {
  runtime.pick = ctx.pick
  runtime.uiActions = ctx.uiActions
  ctx.pageEditor.registerBlock({
    kind: BLOCK_KIND,
    plugin: PLUGIN_ID,
    label: '本地文件',
    blockType: 'local-file',
    blockTypeLabel: '本地文件',
    hint: '像 VS Code 一样打开你电脑上的文件 / 文件夹；也可以直接把文件拖进页面',
    aliases: ['local', 'file', 'folder', 'vscode', 'editor', '本地', '文件', '文件夹', '编辑器', '代码'],
    defaults: () => ({ height: DEFAULT_HEIGHT }),
    // 只有「保存快照到页面」会产生附件引用。
    assets: (data: Record<string, unknown>) => {
      const snap = snapshotOf(data as BlockData)
      return snap ? [snap.href] : []
    },
    View: LocalFileBlock,
    MinimizedView: LocalFileMinimized,
    acceptDrop: {
      match: (dataTransfer: DataTransfer) => Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file'),
      // rootsFromDrop 在第一次 await 之前就同步取走了句柄 / 条目 / 文件。
      take: async (dataTransfer: DataTransfer) => {
        const ids = await rootsFromDrop(dataTransfer)
        const items = await Promise.all(ids.map((id) => blockDataFor(id)))
        return items.filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({ ...item, height: DEFAULT_HEIGHT }))
      },
    },
  })
  ctx.slots.place('inspector-panels', SidebarPanel as never, {
    key: PLUGIN_ID,
    order: 70,
    props: () => ({
      tabId: PLUGIN_ID,
      tabLabel: '本地文件',
      requiresSession: true,
      centerKinds: ['session'],
    }),
  })
}
