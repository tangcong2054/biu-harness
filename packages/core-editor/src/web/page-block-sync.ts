import { useCallback, useEffect, useRef } from 'react'
import { randomUUID } from './random-id.ts'

type SyncMessage =
  | { type: 'request'; source: string }
  | { type: 'state'; source: string; at: number; data: Record<string, unknown> }

/** 打开独立窗口前发出。原页面把当前块数据写入交接区，并广播给已经开着的窗口。 */
export const PAGE_BLOCK_HANDOFF_EVENT = 'biu:page-block-handoff'
/** 插件把还没写进块数据的画面补进交接包。detail: { recordId, patch }。 */
export const PAGE_BLOCK_CAPTURE_EVENT = 'biu:page-block-capture'

const HANDOFF_PREFIX = 'biu:page-block-live:'
const SYNC_PREFIX = 'biu:page-block:sync:'
const HANDOFF_TTL_MS = 30_000

type HandoffDetail = { recordId?: string }
type CaptureDetail = { recordId?: string; patch?: Record<string, unknown> }

function channelName(recordId: string) {
  return `biu:page-block:${recordId}`
}

function handoffKey(recordId: string) {
  return HANDOFF_PREFIX + recordId
}

function syncKey(recordId: string) {
  return SYNC_PREFIX + recordId
}

function writeSyncMirror(recordId: string, source: string, at: number, data: Record<string, unknown>) {
  if (!recordId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(syncKey(recordId), JSON.stringify({ at, source, data }))
  } catch {
    // 块数据太大时仍靠 BroadcastChannel。
  }
}

function isData(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 插件监听 PAGE_BLOCK_CAPTURE_EVENT，把当前画面补进这次交接。 */
export function capturePageBlockLive(recordId: string, data: Record<string, unknown>) {
  const detail: CaptureDetail = { recordId, patch: {} }
  window.dispatchEvent(new CustomEvent(PAGE_BLOCK_CAPTURE_EVENT, { detail }))
  const patch = detail.patch
  if (!isData(patch)) return data
  return { ...data, ...patch }
}

export function stashPageBlockHandoff(recordId: string, data: Record<string, unknown>) {
  const id = recordId.trim()
  if (!id || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(handoffKey(id), JSON.stringify({ at: Date.now(), data }))
  } catch {
    // 数据太大或存储被禁用时，新窗口退回数据库里的版本。
  }
}

export function readPageBlockHandoff(recordId: string): Record<string, unknown> | null {
  const id = recordId.trim()
  if (!id || typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(handoffKey(id))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { at?: number; data?: unknown }
    if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > HANDOFF_TTL_MS) return null
    if (!isData(parsed.data)) return null
    return parsed.data
  } catch {
    return null
  }
}

export function usePageBlockSync(
  recordId: string,
  data: Record<string, unknown>,
  onRemote: (data: Record<string, unknown>) => void,
  options?: { answerHandoff?: boolean },
) {
  const sourceRef = useRef(randomUUID())
  const channelRef = useRef<BroadcastChannel | null>(null)
  const dataRef = useRef(data)
  const renderedData = useRef(data)
  const remoteRef = useRef(onRemote)
  const answerRef = useRef(options?.answerHandoff === true)
  const seenRef = useRef('')
  const latestAtRef = useRef(0)
  if (renderedData.current !== data) {
    renderedData.current = data
    dataRef.current = data
  }
  remoteRef.current = onRemote
  answerRef.current = options?.answerHandoff === true

  const acceptRemote = (incoming: Record<string, unknown>, at: number) => {
    if (at < latestAtRef.current) return
    let sig = ''
    try {
      sig = JSON.stringify(incoming)
    } catch {
      return
    }
    if (!sig || sig === seenRef.current) {
      latestAtRef.current = at
      return
    }
    latestAtRef.current = at
    seenRef.current = sig
    dataRef.current = incoming
    remoteRef.current(incoming)
  }

  useEffect(() => {
    if (!recordId) return
    const onHandoff = (event: Event) => {
      if (!answerRef.current) return
      const id = String((event as CustomEvent<HandoffDetail>).detail?.recordId ?? '').trim()
      if (id !== recordId) return
      const next = capturePageBlockLive(recordId, dataRef.current)
      stashPageBlockHandoff(recordId, next)
      const at = Date.now()
      latestAtRef.current = at
      try {
        seenRef.current = JSON.stringify(next)
      } catch {
        seenRef.current = ''
      }
      channelRef.current?.postMessage({ type: 'state', source: sourceRef.current, at, data: next } satisfies SyncMessage)
      writeSyncMirror(recordId, sourceRef.current, at, next)
    }
    window.addEventListener(PAGE_BLOCK_HANDOFF_EVENT, onHandoff)
    return () => window.removeEventListener(PAGE_BLOCK_HANDOFF_EVENT, onHandoff)
  }, [recordId])

  useEffect(() => {
    if (!recordId || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(channelName(recordId))
    channelRef.current = channel
    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const message = event.data
      if (!message || message.source === sourceRef.current) return
      if (message.type === 'request') {
        if (!answerRef.current) return
        const next = capturePageBlockLive(recordId, dataRef.current)
        const at = Date.now()
        latestAtRef.current = at
        try {
          seenRef.current = JSON.stringify(next)
        } catch {
          seenRef.current = ''
        }
        channel.postMessage({ type: 'state', source: sourceRef.current, at, data: next } satisfies SyncMessage)
        writeSyncMirror(recordId, sourceRef.current, at, next)
        return
      }
      if (message.type === 'state' && isData(message.data)) {
        acceptRemote(message.data, typeof message.at === 'number' ? message.at : Date.now())
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== syncKey(recordId) || !event.newValue) return
      try {
        const parsed = JSON.parse(event.newValue) as { at?: number; source?: string; data?: unknown }
        if (!parsed || parsed.source === sourceRef.current || !isData(parsed.data)) return
        acceptRemote(parsed.data, typeof parsed.at === 'number' ? parsed.at : Date.now())
      } catch {
        // 坏数据忽略。
      }
    }
    window.addEventListener('storage', onStorage)
    channel.postMessage({ type: 'request', source: sourceRef.current } satisfies SyncMessage)
    return () => {
      window.removeEventListener('storage', onStorage)
      if (channelRef.current === channel) channelRef.current = null
      channel.close()
    }
  }, [recordId])

  return useCallback((next: Record<string, unknown>) => {
    const at = Date.now()
    latestAtRef.current = at
    dataRef.current = next
    try {
      seenRef.current = JSON.stringify(next)
    } catch {
      seenRef.current = ''
    }
    channelRef.current?.postMessage({ type: 'state', source: sourceRef.current, at, data: next } satisfies SyncMessage)
    writeSyncMirror(recordId, sourceRef.current, at, next)
  }, [recordId])
}
