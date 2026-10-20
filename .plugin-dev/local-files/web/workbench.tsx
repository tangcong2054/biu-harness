/**
 * 类 VS Code 的工作台：资源管理器 + 多标签 + 编辑器 / 预览 + 状态栏。
 * 页面块（页面内 / 右侧栏 / 全屏）和会话右侧栏共用这一套。
 */
import {
  IGNORED_NAMES,
  baseName,
  captureDrop,
  isAbort,
  parentPath,
  pickWithInput,
  supportsFilePicker,
  supportsHandles,
  type FsEntry,
  type FsRoot,
  type PermissionState,
} from './fs.ts'
import {
  addHandleRoot,
  addSnapshotRoot,
  allRoots,
  deleteDraft,
  forgetRoot,
  loadDraft,
  rootById,
  saveDraft,
  subscribeRoots,
} from './roots.ts'
import { MAX_EDIT_BYTES, PREVIEW_HEAD_BYTES, detectKind, formatBytes, languageLabel, looksBinary, type ViewKind } from './kinds.ts'
import { createCodeEditor, type CodeEditorHandle } from './code-editor.ts'
import { HtmlPreview, MarkdownPreview, MediaPreview, downloadBlob } from './preview.tsx'
import { PLUGIN_ID, dotColor, ensureStyles, runtime } from './runtime.ts'
import { fileQueryActions } from './query-actions.ts'
import { localFilePick, type FileSelection } from './selection.ts'

const React = globalThis.React
const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React

/* ---------------- 图标 ---------------- */

type IconId = 'folder' | 'file' | 'newFile' | 'newFolder' | 'refresh' | 'close' | 'trash' | 'save' | 'download' | 'sidebar' | 'eye' | 'unlock' | 'caretRight' | 'caretDown'

export function Icon({ id, size = 14 }: { id: IconId; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
  switch (id) {
    case 'folder':
      return <svg {...p}><path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h3l1.5 1.5H13c.7 0 1.25.55 1.25 1.25v6.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" /></svg>
    case 'file':
      return <svg {...p}><path d="M4 1.75h5l3.25 3.25v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1v-10.5c0-.55.45-1 1-1z" /><path d="M9 1.75V5h3.25" /></svg>
    case 'newFile':
      return <svg {...p}><path d="M8.5 1.75H4c-.55 0-1 .45-1 1v10.5c0 .55.45 1 1 1h7.25c.55 0 1-.45 1-1V5.5" /><path d="M12.5 1v4M10.5 3h4" /></svg>
    case 'newFolder':
      return <svg {...p}><path d="M14.25 8v3.75c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25v-7.5C1.75 3.55 2.3 3 3 3h3l1.5 1.5H9" /><path d="M12.5 1.5v4M10.5 3.5h4" /></svg>
    case 'refresh':
      return <svg {...p}><path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" /><path d="M13.25 2.5v3h-3" /></svg>
    case 'close':
      return <svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>
    case 'trash':
      return <svg {...p}><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 9c.04.55.5 1 1.05 1h4.2c.55 0 1.01-.45 1.05-1l.6-9" /></svg>
    case 'save':
      return <svg {...p}><path d="M2.75 2.75h8.5l2 2v8.5c0 .55-.45 1-1 1H3.75c-.55 0-1-.45-1-1z" /><path d="M5 2.75v3.5h5v-3.5M5 14.25v-4.5h6v4.5" /></svg>
    case 'download':
      return <svg {...p}><path d="M8 2v8M4.75 7 8 10.25 11.25 7M2.75 13.25h10.5" /></svg>
    case 'sidebar':
      return <svg {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" /><path d="M6 2.75v10.5" /></svg>
    case 'eye':
      return <svg {...p}><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.9" /></svg>
    case 'unlock':
      return <svg {...p}><rect x="3" y="7" width="10" height="7" rx="1.25" /><path d="M5.25 7V5a2.75 2.75 0 0 1 5.3-1" /></svg>
    case 'caretRight':
      return <svg {...p} width={10} height={10}><path d="M6 3.5 10.5 8 6 12.5" /></svg>
    case 'caretDown':
      return <svg {...p} width={10} height={10}><path d="M3.5 6 8 10.5 12.5 6" /></svg>
  }
}

/* ---------------- 状态 ---------------- */

export type OpenRef = { rootId: string; path: string }

type Tab = {
  key: string
  rootId: string
  path: string
  name: string
  loading: boolean
  error?: string
  kind?: ViewKind
  file?: File
  text?: string
  saved?: string
  modified?: number
  size?: number
  tooLarge?: boolean
  rev: number
  notice?: { tone: 'info' | 'warn' | 'error'; text: string }
  external?: boolean
  mdMode?: 'preview' | 'source'
}

const keyOf = (rootId: string, path: string) => `${rootId}\n${path}`
const isDirty = (tab: Tab) => tab.text !== undefined && tab.saved !== undefined && tab.text !== tab.saved
const isTextual = (kind?: ViewKind) => kind === 'text' || kind === 'markdown' || kind === 'html'

function errorText(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '浏览器未授予访问权限，请点「恢复访问」'
    if (error.name === 'NotFoundError') return '文件或文件夹不存在（可能已被移动或删除）'
    if (error.name === 'NoModificationAllowedError' || error.name === 'InvalidModificationError') return '文件被占用或不允许修改'
  }
  return error instanceof Error ? error.message : String(error)
}

function needsAccess(error: unknown) {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
}

function randomInstance() {
  return `wb-${Math.random().toString(36).slice(2, 10)}`
}

/* ---------------- 添加根 ---------------- */

/** 选择文件夹：支持句柄就拿可写句柄，否则退回 webkitdirectory 只读快照。 */
export async function pickFolderRoots(): Promise<string[]> {
  try {
    if (supportsHandles()) {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      return [await addHandleRoot(handle)]
    }
    return await Promise.all((await pickWithInput(true)).map((root) => addSnapshotRoot(root)))
  } catch (error) {
    if (isAbort(error)) return []
    throw error
  }
}

export async function pickFileRoots(): Promise<string[]> {
  try {
    if (supportsFilePicker()) {
      const handles = await (window as any).showOpenFilePicker({ multiple: true })
      const ids: string[] = []
      for (const handle of handles) ids.push(await addHandleRoot(handle))
      return ids
    }
    return await Promise.all((await pickWithInput(false)).map((root) => addSnapshotRoot(root)))
  } catch (error) {
    if (isAbort(error)) return []
    throw error
  }
}

export async function rootsFromDrop(dataTransfer: DataTransfer): Promise<string[]> {
  const sources = await captureDrop(dataTransfer)
  const ids: string[] = []
  for (const source of sources) {
    ids.push(source.type === 'handle' ? await addHandleRoot(source.handle) : await addSnapshotRoot(source.root))
  }
  return ids
}

/* ---------------- 文本面板（每个标签一个 CodeMirror，切换不丢撤销历史） ---------------- */

function TextPane({
  tab,
  hidden,
  onChange,
  onSave,
  onCursor,
  onAttach,
}: {
  tab: Tab
  hidden: boolean
  onChange: (key: string, text: string) => void
  onSave: (key: string) => void
  onCursor: (line: number, col: number) => void
  onAttach: (key: string, selection: FileSelection | null) => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const editor = useRef<CodeEditorHandle | null>(null)
  const latest = useRef({ onChange, onSave, onCursor, onAttach, key: tab.key })
  latest.current = { onChange, onSave, onCursor, onAttach, key: tab.key }

  useLayoutEffect(() => {
    if (!host.current) return
    const handle = createCodeEditor(host.current, {
      doc: tab.text ?? '',
      name: tab.name,
      readOnly: Boolean(tab.tooLarge),
      onChange: (text) => latest.current.onChange(latest.current.key, text),
      onSave: () => latest.current.onSave(latest.current.key),
      onCursor: (line, col) => latest.current.onCursor(line, col),
      onAttach: (selection) => latest.current.onAttach(latest.current.key, selection),
    })
    editor.current = handle
    return () => {
      handle.destroy()
      editor.current = null
    }
  }, [])

  // 重新加载 / 丢弃修改 / agent 写入后，rev 变化时把内容推回编辑器。
  useEffect(() => {
    editor.current?.setDoc(tab.text ?? '')
  }, [tab.rev])

  useEffect(() => {
    editor.current?.setReadOnly(Boolean(tab.tooLarge))
  }, [tab.tooLarge])

  useEffect(() => {
    if (!hidden) editor.current?.focus()
  }, [hidden])

  return <div ref={host} className="lf-cm" />
}

/* ---------------- 工作台 ---------------- */

export type WorkbenchProps = {
  /** 'all'：本浏览器里所有根（右侧栏）；数组：只显示这些根（页面块）。 */
  rootIds: string[] | 'all'
  initial?: OpenRef | null
  allowAddRoots?: boolean
  onRootsAdded?: (ids: string[]) => void
  onActiveChange?: (ref: OpenRef | null) => void
  surface?: 'main' | 'inspector'
  label: string
  flat?: boolean
  toolbar?: unknown
  explorerOpen?: boolean
}

export function Workbench(props: WorkbenchProps) {
  ensureStyles()
  const { rootIds, initial, allowAddRoots = true, onRootsAdded, onActiveChange, surface = 'main', label, flat, toolbar } = props
  const [roots, setRoots] = useState<FsRoot[]>([])
  const [rootsReady, setRootsReady] = useState(false)
  const [access, setAccess] = useState<Record<string, PermissionState>>({})
  const [children, setChildren] = useState<Record<string, FsEntry[] | { error: string }>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<{ rootId: string; path: string; kind: 'file' | 'directory' } | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeKey, setActiveKey] = useState<string>('')
  const [showIgnored, setShowIgnored] = useState(false)
  const [explorer, setExplorer] = useState(props.explorerOpen ?? true)
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [flash, setFlash] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null)
  const instanceId = useRef(randomInstance())
  const rootIdsKey = rootIds === 'all' ? 'all' : rootIds.join('|')

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const rootsRef = useRef(roots)
  rootsRef.current = roots
  const childrenRef = useRef(children)
  childrenRef.current = children
  const activeRef = useRef(activeKey)
  activeRef.current = activeKey
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const rootOf = useCallback((id: string) => rootsRef.current.find((root) => root.id === id), [])

  const patchTab = useCallback((key: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => {
    setTabs((cur) => cur.map((tab) => (tab.key === key ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab)))
  }, [])

  const say = useCallback((tone: 'info' | 'warn' | 'error', text: string) => {
    setFlash({ tone, text })
  }, [])

  useEffect(() => {
    if (!flash || flash.tone === 'error') return
    const timer = setTimeout(() => setFlash(null), 4000)
    return () => clearTimeout(timer)
  }, [flash])

  const attachSelection = useCallback((key: string, selection: FileSelection | null) => {
    if (!selection) {
      say('warn', '请先在文件编辑区选中文字，再按 Ctrl/⌘+L 加入对话')
      return
    }
    const tab = tabsRef.current.find((item) => item.key === key)
    const root = tab ? rootOf(tab.rootId) : undefined
    if (!tab || !root) return
    if (!runtime.pick) {
      say('error', '加入对话服务尚未就绪，请重新运行本地文件插件')
      return
    }
    try {
      runtime.pick.attach([localFilePick(selection, {
        rootId: root.id,
        rootName: root.name,
        path: tab.path,
        route: window.location.pathname,
        unsaved: isDirty(tab),
      })])
      say('info', `已加入对话：${tab.name} 第 ${selection.startLine}–${selection.endLine} 行（来源：本地文件插件）`)
    } catch (error) {
      say('error', errorText(error))
    }
  }, [rootOf, say])

  /* ---- 根 ---- */

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const next =
        rootIds === 'all'
          ? await allRoots()
          : (await Promise.all(rootIds.map((id) => rootById(id)))).filter((root): root is FsRoot => Boolean(root))
      if (cancelled) return
      setRoots(next)
      setRootsReady(true)
      const states: Record<string, PermissionState> = {}
      for (const root of next) states[root.id] = await root.permission(false)
      if (!cancelled) setAccess(states)
    }
    void load()
    const stop = subscribeRoots(() => void load())
    return () => {
      cancelled = true
      stop()
    }
  }, [rootIdsKey])

  const loadDir = useCallback(async (rootId: string, path: string) => {
    const root = rootOf(rootId)
    if (!root) return
    try {
      const list = await root.list(path)
      setChildren((cur) => ({ ...cur, [keyOf(rootId, path)]: list }))
    } catch (error) {
      if (needsAccess(error)) setAccess((cur) => ({ ...cur, [rootId]: 'prompt' }))
      setChildren((cur) => ({ ...cur, [keyOf(rootId, path)]: { error: errorText(error) } }))
    }
  }, [rootOf])

  // 新出现且已授权的根：自动展开第一层（只展开一次，用户收起后不再弹开）。
  const autoExpanded = useRef(new Set<string>())
  useEffect(() => {
    for (const root of roots) {
      const key = keyOf(root.id, '')
      if (access[root.id] !== 'granted') continue
      if (!childrenRef.current[key]) void loadDir(root.id, '')
      if (autoExpanded.current.has(key)) continue
      autoExpanded.current.add(key)
      setExpanded((cur) => (cur.has(key) ? cur : new Set(cur).add(key)))
    }
  }, [roots, access, loadDir])

  const restoreAccess = useCallback(async (root: FsRoot) => {
    // 一次弹窗同时拿读写；用户只给读也能继续浏览。
    let ok = await root.requestPermission(true)
    if (!ok) ok = await root.requestPermission(false)
    const state = await root.permission(false)
    setAccess((cur) => ({ ...cur, [root.id]: state }))
    if (ok) {
      setChildren((cur) => {
        const next = { ...cur }
        for (const key of Object.keys(next)) if (key.startsWith(`${root.id}\n`)) delete next[key]
        return next
      })
      void loadDir(root.id, '')
    } else {
      say('warn', `未获得「${root.name}」的访问权限`)
    }
  }, [loadDir, say])

  const addRoots = useCallback(async (pick: () => Promise<string[]>) => {
    try {
      const ids = await pick()
      if (ids.length) onRootsAdded?.(ids)
    } catch (error) {
      say('error', errorText(error))
    }
  }, [onRootsAdded, say])

  /* ---- 打开文件 ---- */

  const openFile = useCallback(async (rootId: string, path: string) => {
    const key = keyOf(rootId, path)
    setActiveKey(key)
    setSelected({ rootId, path, kind: 'file' })
    if (tabsRef.current.some((tab) => tab.key === key && !tab.error)) return
    const root = rootOf(rootId)
    const base: Tab = { key, rootId, path, name: baseName(path), loading: true, rev: 0 }
    setTabs((cur) => (cur.some((tab) => tab.key === key) ? cur.map((tab) => (tab.key === key ? base : tab)) : [...cur, base]))
    if (!root) {
      patchTab(key, { loading: false, error: '找不到这个本地根（可能已从本浏览器移除）' })
      return
    }
    try {
      const file = await root.file(path)
      const kind = await detectKind(file)
      if (!isTextual(kind)) {
        patchTab(key, { loading: false, kind, file, size: file.size, modified: file.lastModified })
        return
      }
      const tooLarge = file.size > MAX_EDIT_BYTES
      const text = tooLarge ? await file.slice(0, PREVIEW_HEAD_BYTES).text() : await file.text()
      let current = text
      let notice: Tab['notice']
      if (!tooLarge) {
        const draft = await loadDraft(rootId, path)
        if (draft && draft.text !== text) {
          current = draft.text
          notice =
            draft.baseModified === file.lastModified
              ? { tone: 'info', text: '已恢复上次未保存的修改' }
              : { tone: 'warn', text: '已恢复未保存的修改；注意：文件在此期间被外部修改过' }
        }
      } else {
        notice = { tone: 'warn', text: `文件较大（${formatBytes(file.size)}），只读显示前 ${formatBytes(PREVIEW_HEAD_BYTES)}` }
      }
      patchTab(key, {
        loading: false,
        kind,
        file,
        text: current,
        saved: text,
        size: file.size,
        modified: file.lastModified,
        tooLarge,
        notice,
        rev: 1,
        mdMode: kind === 'markdown' ? 'preview' : 'source',
      })
    } catch (error) {
      if (needsAccess(error)) setAccess((cur) => ({ ...cur, [rootId]: 'prompt' }))
      patchTab(key, { loading: false, error: errorText(error) })
    }
  }, [patchTab, rootOf])

  // 页面块记住的上次打开的文件；单文件根直接打开。
  const openedInitial = useRef(false)
  useEffect(() => {
    if (openedInitial.current || !roots.length) return
    const target = initial && roots.some((root) => root.id === initial.rootId) ? initial : null
    const single = roots.length === 1 && roots[0].kind === 'file' ? { rootId: roots[0].id, path: roots[0].name } : null
    const ref = target?.path ? target : single
    if (!ref) return
    if (access[ref.rootId] !== 'granted') return
    openedInitial.current = true
    void openFile(ref.rootId, ref.path)
  }, [roots, access, initial?.rootId, initial?.path, openFile])

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null
  useEffect(() => {
    onActiveChange?.(activeTab ? { rootId: activeTab.rootId, path: activeTab.path } : null)
  }, [activeTab?.key])

  const closeTab = useCallback((key: string) => {
    const tab = tabsRef.current.find((item) => item.key === key)
    if (tab && isDirty(tab) && !window.confirm(`「${tab.name}」有未保存的修改，确定关闭？（草稿会保留，下次打开可恢复）`)) return
    setTabs((cur) => {
      const index = cur.findIndex((item) => item.key === key)
      const next = cur.filter((item) => item.key !== key)
      if (activeRef.current === key) setActiveKey(next[Math.min(index, next.length - 1)]?.key ?? '')
      return next
    })
  }, [])

  /* ---- 编辑 / 保存 ---- */

  const onChange = useCallback((key: string, text: string) => {
    const tab = tabsRef.current.find((item) => item.key === key)
    if (!tab) return
    patchTab(key, { text })
    const timers = draftTimers.current
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        if (text === tab.saved) void deleteDraft(tab.rootId, tab.path)
        else void saveDraft(tab.rootId, tab.path, { text, baseModified: tab.modified ?? 0, savedAt: Date.now() })
      }, 600),
    )
  }, [patchTab])

  const saveTab = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((item) => item.key === key)
    if (!tab || tab.text === undefined || tab.tooLarge) return
    const root = rootOf(tab.rootId)
    if (!root) return
    const text = tab.text
    clearTimeout(draftTimers.current.get(key))
    try {
      if (root.mode === 'readwrite' && root.write) {
        await root.write(tab.path, text)
        const file = await root.file(tab.path)
        patchTab(key, { saved: text, file, modified: file.lastModified, size: file.size, external: false, notice: undefined })
        setAccess((cur) => ({ ...cur, [root.id]: 'granted' }))
        say('info', `已保存 ${tab.name}`)
      } else {
        downloadBlob(text, tab.name)
        patchTab(key, { saved: text })
        say('warn', '当前浏览器不能写回原文件，已下载为新文件（在 Chrome / Edge 中可直接保存）')
      }
      await deleteDraft(tab.rootId, tab.path)
    } catch (error) {
      say('error', `保存失败：${errorText(error)}`)
    }
  }, [patchTab, rootOf, say])

  const reloadTab = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((item) => item.key === key)
    const root = tab ? rootOf(tab.rootId) : undefined
    if (!tab || !root) return
    try {
      const file = await root.file(tab.path)
      if (!isTextual(tab.kind)) {
        patchTab(key, { file, size: file.size, modified: file.lastModified, external: false })
        return
      }
      const text = file.size > MAX_EDIT_BYTES ? await file.slice(0, PREVIEW_HEAD_BYTES).text() : await file.text()
      patchTab(key, (cur) => ({ file, text, saved: text, size: file.size, modified: file.lastModified, external: false, notice: undefined, rev: cur.rev + 1 }))
      await deleteDraft(tab.rootId, tab.path)
    } catch (error) {
      patchTab(key, { notice: { tone: 'error', text: errorText(error) } })
    }
  }, [patchTab, rootOf])

  // 外部修改感知：切回窗口或每 3 秒看一次当前标签的修改时间。
  useEffect(() => {
    let busy = false
    const check = async () => {
      if (busy || document.hidden) return
      const tab = tabsRef.current.find((item) => item.key === activeRef.current)
      const root = tab ? rootOf(tab.rootId) : undefined
      if (!tab || !root || root.source !== 'handle' || tab.loading || tab.error || tab.modified === undefined) return
      busy = true
      try {
        const file = await root.file(tab.path)
        if (file.lastModified === tab.modified) return
        if (isDirty(tab)) patchTab(tab.key, { external: true })
        else await reloadTab(tab.key)
      } catch {
        /* 被删或没权限时不打扰，下次操作会提示 */
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void check(), 3000)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [patchTab, reloadTab, rootOf])

  /* ---- 资源管理器操作 ---- */

  const toggleDir = useCallback((rootId: string, path: string) => {
    const key = keyOf(rootId, path)
    setSelected({ rootId, path, kind: 'directory' })
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        if (!childrenRef.current[key] || 'error' in (childrenRef.current[key] as object)) void loadDir(rootId, path)
      }
      return next
    })
  }, [loadDir])

  const refreshRoot = useCallback((rootId: string) => {
    for (const key of [...expanded]) {
      if (!key.startsWith(`${rootId}\n`)) continue
      void loadDir(rootId, key.slice(rootId.length + 1))
    }
    if (!expanded.has(keyOf(rootId, ''))) void loadDir(rootId, '')
  }, [expanded, loadDir])

  const targetDir = useCallback(() => {
    const first = rootsRef.current.find((root) => root.kind === 'directory' && root.mode === 'readwrite')
    if (selected) {
      const root = rootOf(selected.rootId)
      if (root?.kind === 'directory' && root.mode === 'readwrite') {
        return { root, dir: selected.kind === 'directory' ? selected.path : parentPath(selected.path) }
      }
    }
    return first ? { root: first, dir: '' } : null
  }, [rootOf, selected])

  const createEntry = useCallback(async (type: 'file' | 'directory') => {
    const target = targetDir()
    if (!target) {
      say('warn', '没有可写的文件夹（只读快照不能新建，请在 Chrome / Edge 中打开文件夹）')
      return
    }
    const name = window.prompt(type === 'file' ? '新文件名' : '新文件夹名', '')?.trim()
    if (!name) return
    try {
      const path =
        type === 'file' ? await target.root.createFile!(target.dir, name) : await target.root.createDir!(target.dir, name)
      const dirKey = keyOf(target.root.id, target.dir)
      setExpanded((cur) => new Set(cur).add(dirKey))
      await loadDir(target.root.id, target.dir)
      if (type === 'file') void openFile(target.root.id, path)
      else setSelected({ rootId: target.root.id, path, kind: 'directory' })
    } catch (error) {
      say('error', errorText(error))
    }
  }, [loadDir, openFile, say, targetDir])

  const removeEntry = useCallback(async (rootId: string, entry: FsEntry) => {
    const root = rootOf(rootId)
    if (!root?.remove) return
    const what = entry.kind === 'directory' ? `文件夹「${entry.name}」及其中所有内容` : `文件「${entry.name}」`
    if (!window.confirm(`确定从磁盘删除${what}？此操作不可撤销。`)) return
    try {
      await root.remove(entry.path)
      setTabs((cur) => cur.filter((tab) => !(tab.rootId === rootId && (tab.path === entry.path || tab.path.startsWith(`${entry.path}/`)))))
      await loadDir(rootId, parentPath(entry.path))
    } catch (error) {
      say('error', errorText(error))
    }
  }, [loadDir, rootOf, say])

  /* ---- 拖入工作台 ---- */

  const dragDepth = useRef(0)
  const onDragEnter = (event: DragEvent) => {
    if (!allowAddRoots || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragging(false)
  }
  const onDragOver = (event: DragEvent) => {
    if (!allowAddRoots || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onDrop = (event: DragEvent) => {
    dragDepth.current = 0
    setDragging(false)
    if (!allowAddRoots || !event.dataTransfer || !Array.from(event.dataTransfer.types ?? []).includes('Files')) return
    // 不让页面编辑器再处理一次（否则会在页面里多插一个块）。
    event.preventDefault()
    event.stopPropagation()
    const pending = rootsFromDrop(event.dataTransfer)
    void addRoots(() => pending)
  }

  /* ---- 给 agent 的 uiActions ---- */

  const api = useRef({ openFile, saveTab, reloadTab, loadDir })
  api.current = { openFile, saveTab, reloadTab, loadDir }

  useEffect(() => {
    const ui = runtime.uiActions
    if (!ui) return
    const describeRoot = (root: FsRoot) => ({
      rootId: root.id,
      name: root.name,
      kind: root.kind,
      mode: root.mode,
      source: root.source,
    })
    const requireRoot = (args: Record<string, unknown>) => {
      const id = String(args.rootId ?? '').trim() || rootsRef.current[0]?.id || ''
      const root = rootsRef.current.find((item) => item.id === id)
      if (!root) throw new Error(`找不到本地根：${id || '(空)'}。先调用 list_roots`)
      return root
    }
    const rootProp = { type: 'string', description: 'list_roots 返回的 rootId；只有一个根时可省略' }
    return ui.register({
      plugin: PLUGIN_ID,
      instanceId: instanceId.current,
      kind: 'workbench',
      label,
      surface,
      state: () => {
        const tab = tabsRef.current.find((item) => item.key === activeRef.current)
        return {
          roots: rootsRef.current.map(describeRoot),
          active: tab ? { rootId: tab.rootId, path: tab.path, dirty: isDirty(tab) } : null,
          openTabs: tabsRef.current.map((item) => ({ rootId: item.rootId, path: item.path, dirty: isDirty(item) })),
        }
      },
      actions: {
        ...fileQueryActions(requireRoot),
        list_roots: {
          description: '列出用户在本浏览器里打开的本地文件夹 / 文件（rootId、名称、是否可写）',
          risk: 'read',
          run: () => ({ roots: rootsRef.current.map(describeRoot) }),
        },
        list_dir: {
          description: '列出本地文件夹某个目录下的条目（path 为相对根的路径，空串表示根目录）',
          risk: 'read',
          inputSchema: { type: 'object', properties: { rootId: rootProp, path: { type: 'string' } } },
          run: async (args: Record<string, unknown>) => {
            const root = requireRoot(args)
            const entries = await root.list(String(args.path ?? ''))
            return { rootId: root.id, path: String(args.path ?? ''), entries: entries.slice(0, 500), truncated: entries.length > 500 }
          },
        },
        read_file: {
          description: '读取本地文本文件内容（默认最多 100KB，maxBytes 最大 1MB）。若该文件在编辑器里有未保存修改会一并返回 unsavedText',
          risk: 'read',
          inputSchema: {
            type: 'object',
            properties: { rootId: rootProp, path: { type: 'string' }, maxBytes: { type: 'number' } },
            required: ['path'],
          },
          run: async (args: Record<string, unknown>) => {
            const root = requireRoot(args)
            const path = String(args.path ?? '')
            const file = await root.file(path)
            if (await looksBinary(file)) throw new Error(`二进制文件不能按文本读取：${path}（${formatBytes(file.size)}）`)
            const limit = Math.min(1024 * 1024, Math.max(1024, Number(args.maxBytes) || 100 * 1024))
            const text = await file.slice(0, limit).text()
            const tab = tabsRef.current.find((item) => item.key === keyOf(root.id, path))
            return {
              rootId: root.id,
              path,
              size: file.size,
              modified: file.lastModified,
              truncated: file.size > limit,
              text,
              ...(tab && isDirty(tab) ? { unsavedText: tab.text?.slice(0, limit) } : {}),
            }
          },
        },
        open_file: {
          description: '在工作台里打开某个本地文件（新标签）',
          risk: 'navigate',
          inputSchema: { type: 'object', properties: { rootId: rootProp, path: { type: 'string' } }, required: ['path'] },
          run: async (args: Record<string, unknown>) => {
            const root = requireRoot(args)
            await api.current.openFile(root.id, String(args.path ?? ''))
            return { rootId: root.id, path: String(args.path ?? ''), opened: true }
          },
        },
        write_file: {
          description: '把 content 写入用户电脑上的本地文件（覆盖；文件不存在则在已有目录下新建）。只对可写根有效，每次都需要用户确认',
          risk: 'destructive',
          inputSchema: {
            type: 'object',
            properties: { rootId: rootProp, path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
          run: async (args: Record<string, unknown>) => {
            const root = requireRoot(args)
            if (root.mode !== 'readwrite' || !root.write) throw new Error(`「${root.name}」是只读快照，不能写回（需要在 Chrome / Edge 中打开文件夹）`)
            const path = String(args.path ?? '')
            const content = String(args.content ?? '')
            const key = keyOf(root.id, path)
            const tab = tabsRef.current.find((item) => item.key === key)
            if (tab && isDirty(tab)) throw new Error(`「${tab.name}」在编辑器里有未保存的修改，先让用户保存或丢弃`)
            await root.write(path, content)
            if (tab) await api.current.reloadTab(key)
            void api.current.loadDir(root.id, parentPath(path))
            return { rootId: root.id, path, bytes: new Blob([content]).size, written: true }
          },
        },
        save_active: {
          description: '保存当前标签（等同 Ctrl+S）',
          risk: 'write',
          run: async () => {
            if (!activeRef.current) throw new Error('没有打开的文件')
            await api.current.saveTab(activeRef.current)
            return { saved: true }
          },
        },
      },
    })
  }, [label, surface])

  /* ---- 渲染 ---- */

  const renderEntries = (root: FsRoot, dir: string, depth: number): unknown => {
    const list = children[keyOf(root.id, dir)]
    if (!list) return <div className="lf-row" style={{ paddingLeft: 10 + depth * 12, color: 'var(--lf-muted)' }}>加载中…</div>
    if ('error' in list) return <div className="lf-row" style={{ paddingLeft: 10 + depth * 12, color: '#b91c1c' }} title={list.error}>{list.error}</div>
    const visible = showIgnored ? list : list.filter((entry) => !IGNORED_NAMES.has(entry.name))
    if (!visible.length) return <div className="lf-row" style={{ paddingLeft: 10 + depth * 12, color: 'var(--lf-muted)' }}>（空）</div>
    return visible.map((entry) => {
      const key = keyOf(root.id, entry.path)
      const open = expanded.has(key)
      const isSel = selected?.rootId === root.id && selected.path === entry.path
      const isOpenTab = activeKey === key
      return (
        <div key={key}>
          <div
            className={`lf-row${isSel || isOpenTab ? ' is-active' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            title={entry.path}
            onClick={() => (entry.kind === 'directory' ? toggleDir(root.id, entry.path) : void openFile(root.id, entry.path))}
          >
            <span className="lf-caret">{entry.kind === 'directory' ? <Icon id={open ? 'caretDown' : 'caretRight'} /> : null}</span>
            {entry.kind === 'directory' ? <Icon id="folder" size={13} /> : <span className="lf-dot" style={{ background: dotColor(entry.name) }} />}
            <span className="lf-name">{entry.name}</span>
            {root.mode === 'readwrite' && root.remove ? (
              <span className="lf-ops">
                <button
                  type="button"
                  className="lf-icon-btn"
                  title="删除"
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    void removeEntry(root.id, entry)
                  }}
                >
                  <Icon id="trash" size={12} />
                </button>
              </span>
            ) : null}
          </div>
          {entry.kind === 'directory' && open ? renderEntries(root, entry.path, depth + 1) : null}
        </div>
      )
    })
  }

  const renderRoot = (root: FsRoot) => {
    const key = keyOf(root.id, '')
    const open = expanded.has(key)
    const state = access[root.id]
    const locked = state && state !== 'granted'
    return (
      <div key={root.id}>
        <div
          className="lf-row lf-root"
          style={{ paddingLeft: 4 }}
          title={root.source === 'handle' ? '可读写：保存会直接写回你电脑上的原文件' : '只读快照：保存会下载为新文件'}
          onClick={() => {
            if (locked) void restoreAccess(root)
            else if (root.kind === 'file') void openFile(root.id, root.name)
            else toggleDir(root.id, '')
          }}
        >
          <span className="lf-caret">{root.kind === 'directory' ? <Icon id={open && !locked ? 'caretDown' : 'caretRight'} /> : null}</span>
          {root.kind === 'directory' ? <Icon id="folder" size={13} /> : <span className="lf-dot" style={{ background: dotColor(root.name) }} />}
          <span className="lf-name">{root.name}</span>
          {locked ? (
            <span className="lf-badge is-warn">点击恢复访问</span>
          ) : (
            <span className={`lf-badge${root.mode === 'readwrite' ? ' is-rw' : ''}`}>{root.mode === 'readwrite' ? '可读写' : '只读'}</span>
          )}
          <span className="lf-ops">
            {root.kind === 'directory' && !locked ? (
              <button
                type="button"
                className="lf-icon-btn"
                title="刷新"
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  refreshRoot(root.id)
                }}
              >
                <Icon id="refresh" size={12} />
              </button>
            ) : null}
            {rootIds === 'all' ? (
              <button
                type="button"
                className="lf-icon-btn"
                title="从列表移除（不会删除磁盘文件）"
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  setTabs((cur) => cur.filter((tab) => tab.rootId !== root.id))
                  void forgetRoot(root.id)
                }}
              >
                <Icon id="close" size={12} />
              </button>
            ) : null}
          </span>
        </div>
        {root.kind === 'directory' && open && !locked ? renderEntries(root, '', 1) : null}
      </div>
    )
  }

  const addButtons = (primary: boolean) => (
    <>
      <button type="button" className={`lf-btn${primary ? ' is-primary' : ''}`} onClick={() => void addRoots(pickFolderRoots)}>
        <Icon id="folder" /> 打开文件夹
      </button>
      <button type="button" className="lf-btn" onClick={() => void addRoots(pickFileRoots)}>
        <Icon id="file" /> 打开文件
      </button>
    </>
  )

  const capability = supportsHandles()
    ? '可直接读写你电脑上的文件，文件内容不会上传到服务器。'
    : '当前浏览器只支持只读打开（保存会下载为新文件）；在 Chrome / Edge 中可直接写回原文件。'

  if (rootsReady && !roots.length) {
    return (
      <div
        className={`lf-wb${flat ? ' is-flat' : ''}`}
        data-testid="local-files-workbench"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="lf-empty" style={{ flex: 1 }}>
          <h4>打开本地文件</h4>
          <div>选择文件夹或文件，或直接把它们拖到这里。</div>
          {allowAddRoots ? <div className="lf-actions">{addButtons(true)}</div> : null}
          <div style={{ fontSize: 11.5 }}>{capability}</div>
        </div>
        {dragging ? <div className="lf-drop">松开即可打开</div> : null}
      </div>
    )
  }

  const activeRoot = activeTab ? roots.find((root) => root.id === activeTab.rootId) : undefined
  const banner = flash ?? activeTab?.notice ?? null

  return (
    <div
      className={`lf-wb${flat ? ' is-flat' : ''}`}
      data-testid="local-files-workbench"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {explorer ? (
        <aside className="lf-side">
          <div className="lf-side-head">
            <span className="lf-grow">资源管理器</span>
            <button type="button" className="lf-icon-btn" title="新建文件" onClick={() => void createEntry('file')}>
              <Icon id="newFile" />
            </button>
            <button type="button" className="lf-icon-btn" title="新建文件夹" onClick={() => void createEntry('directory')}>
              <Icon id="newFolder" />
            </button>
            <button
              type="button"
              className="lf-icon-btn"
              title={showIgnored ? '隐藏 node_modules / .git 等' : '显示 node_modules / .git 等'}
              style={showIgnored ? { color: 'var(--lf-accent)' } : undefined}
              onClick={() => setShowIgnored((value) => !value)}
            >
              <Icon id="eye" />
            </button>
            {allowAddRoots ? (
              <>
                <button type="button" className="lf-icon-btn" title="打开文件夹" onClick={() => void addRoots(pickFolderRoots)}>
                  <Icon id="folder" />
                </button>
                <button type="button" className="lf-icon-btn" title="打开文件" onClick={() => void addRoots(pickFileRoots)}>
                  <Icon id="file" />
                </button>
              </>
            ) : null}
          </div>
          <div className="lf-tree" role="tree">
            {roots.map(renderRoot)}
          </div>
        </aside>
      ) : null}
      <section className="lf-main">
        <div className="lf-tabs">
          <div className="lf-tools">
            <button type="button" className="lf-icon-btn" title={explorer ? '收起资源管理器' : '展开资源管理器'} onClick={() => setExplorer((value) => !value)}>
              <Icon id="sidebar" />
            </button>
          </div>
          <div className="lf-tab-list" role="tablist">
            {tabs.map((tab) => (
              <div
                key={tab.key}
                role="tab"
                aria-selected={tab.key === activeKey}
                className={`lf-tab${tab.key === activeKey ? ' is-active' : ''}`}
                title={`${roots.find((root) => root.id === tab.rootId)?.name ?? ''}/${tab.path}`}
                onClick={() => setActiveKey(tab.key)}
                onAuxClick={(event: MouseEvent) => {
                  if (event.button === 1) closeTab(tab.key)
                }}
              >
                <span className="lf-dot" style={{ background: dotColor(tab.name) }} />
                <span className="lf-name">{tab.name}</span>
                {isDirty(tab) ? <span className="lf-dirty" title="未保存" /> : null}
                <button
                  type="button"
                  className="lf-icon-btn"
                  title="关闭"
                  style={{ width: 18, height: 18 }}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    closeTab(tab.key)
                  }}
                >
                  <Icon id="close" size={11} />
                </button>
              </div>
            ))}
          </div>
          <div className="lf-tools">
            {activeTab && activeTab.kind === 'markdown' ? (
              <span className="lf-seg">
                <button type="button" className={activeTab.mdMode !== 'source' ? 'is-on' : ''} onClick={() => patchTab(activeTab.key, { mdMode: 'preview' })}>预览</button>
                <button type="button" className={activeTab.mdMode === 'source' ? 'is-on' : ''} onClick={() => patchTab(activeTab.key, { mdMode: 'source' })}>编辑</button>
              </span>
            ) : null}
            {activeTab && activeTab.kind === 'html' ? (
              <span className="lf-seg">
                <button type="button" className={activeTab.mdMode === 'preview' ? 'is-on' : ''} onClick={() => patchTab(activeTab.key, { mdMode: 'preview' })}>预览</button>
                <button type="button" className={activeTab.mdMode !== 'preview' ? 'is-on' : ''} onClick={() => patchTab(activeTab.key, { mdMode: 'source' })}>编辑</button>
              </span>
            ) : null}
            {activeTab && isTextual(activeTab.kind) && !activeTab.tooLarge ? (
              <button
                type="button"
                className="lf-icon-btn"
                title={activeRoot?.mode === 'readwrite' ? '保存（Ctrl/⌘+S）' : '下载为新文件（Ctrl/⌘+S）'}
                disabled={!isDirty(activeTab) && activeRoot?.mode === 'readwrite'}
                onClick={() => void saveTab(activeTab.key)}
              >
                <Icon id={activeRoot?.mode === 'readwrite' ? 'save' : 'download'} />
              </button>
            ) : null}
            {activeTab?.file ? (
              <button type="button" className="lf-icon-btn" title="下载" onClick={() => downloadBlob(activeTab.file!, activeTab.name)}>
                <Icon id="download" />
              </button>
            ) : null}
            {toolbar as never}
          </div>
        </div>
        {activeTab?.external ? (
          <div className="lf-banner">
            <span className="lf-grow">「{activeTab.name}」已在外部被修改，而这里有未保存的修改。</span>
            <button type="button" className="lf-link" onClick={() => void reloadTab(activeTab.key)}>重新加载（丢弃我的修改）</button>
            <button type="button" className="lf-link" onClick={() => patchTab(activeTab.key, (tab) => ({ external: false, modified: tab.file?.lastModified }))}>保留我的修改</button>
          </div>
        ) : null}
        {banner ? (
          <div className={`lf-banner${banner.tone === 'info' ? ' is-info' : banner.tone === 'error' ? ' is-error' : ''}`}>
            <span className="lf-grow">{banner.text}</span>
            {activeTab?.notice === banner && activeTab && isDirty(activeTab) ? (
              <button type="button" className="lf-link" onClick={() => void reloadTab(activeTab.key)}>丢弃修改</button>
            ) : null}
            <button
              type="button"
              className="lf-icon-btn"
              title="关闭提示"
              onClick={() => {
                if (flash) setFlash(null)
                else if (activeTab) patchTab(activeTab.key, { notice: undefined })
              }}
            >
              <Icon id="close" size={11} />
            </button>
          </div>
        ) : null}
        <div className="lf-content">
          {!activeTab ? (
            <div className="lf-empty">
              <div>从左侧资源管理器选择文件打开</div>
              <div style={{ fontSize: 11.5 }}>{capability}</div>
            </div>
          ) : null}
          {tabs.map((tab) => {
            const hidden = tab.key !== activeKey
            if (hidden && !isTextual(tab.kind)) return null
            let body: unknown = null
            if (tab.loading) body = <div className="lf-empty">加载中…</div>
            else if (tab.error) body = <div className="lf-empty" style={{ color: '#b91c1c' }}>{tab.error}</div>
            else if (isTextual(tab.kind)) {
              const showPreview = tab.mdMode === 'preview' && (tab.kind === 'markdown' || tab.kind === 'html')
              body = (
                <>
                  <div className="lf-pane" hidden={showPreview}>
                    <TextPane tab={tab} hidden={hidden || showPreview} onChange={onChange} onSave={(key) => void saveTab(key)} onCursor={(line, col) => setCursor({ line, col })} onAttach={attachSelection} />
                  </div>
                  {showPreview ? (
                    <div className="lf-pane">
                      {tab.kind === 'markdown' ? <MarkdownPreview text={tab.text ?? ''} title={tab.name} /> : <HtmlPreview text={tab.text ?? ''} title={tab.name} />}
                    </div>
                  ) : null}
                </>
              )
            } else if (tab.kind === 'binary') {
              body = (
                <div className="lf-info">
                  <div><b>{tab.name}</b></div>
                  <div>二进制文件 · {formatBytes(tab.size ?? 0)}</div>
                  <div>不支持在这里预览，可以下载后用本机程序打开。</div>
                  <button type="button" className="lf-btn" style={{ marginTop: 8 }} onClick={() => tab.file && downloadBlob(tab.file, tab.name)}>
                    <Icon id="download" /> 下载
                  </button>
                </div>
              )
            } else if (tab.file && tab.kind) body = <MediaPreview file={tab.file} name={tab.name} kind={tab.kind} />
            return (
              <div key={tab.key} className="lf-pane" hidden={hidden}>
                {body}
              </div>
            )
          })}
        </div>
        <div className="lf-status">
          <span className="lf-grow">
            {activeTab ? `${activeRoot?.name ?? ''}/${activeTab.path}` : roots.length ? `${roots.length} 个本地根` : ''}
          </span>
          {activeTab && isTextual(activeTab.kind) && cursor ? <span>行 {cursor.line}，列 {cursor.col}</span> : null}
          {activeTab ? <span>{isTextual(activeTab.kind) ? languageLabel(activeTab.name) : formatBytes(activeTab.size ?? 0)}</span> : null}
          {activeTab && isTextual(activeTab.kind) ? <span title="在编辑模式中选中文字后按 Ctrl/⌘+L，携带文件路径和插件来源加入对话">Ctrl/⌘+L 加入对话</span> : null}
          {activeTab && isTextual(activeTab.kind) ? <span>UTF-8</span> : null}
          {activeRoot ? <span>{activeRoot.mode === 'readwrite' ? '可读写' : '只读快照'}</span> : null}
          {activeTab && isTextual(activeTab.kind) ? <span>{isDirty(activeTab) ? '未保存' : '已保存'}</span> : null}
        </div>
      </section>
      {dragging ? <div className="lf-drop">松开即可添加到资源管理器</div> : null}
    </div>
  )
}
