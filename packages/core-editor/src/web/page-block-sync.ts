import { useCallback, useEffect, useRef } from 'react'
import { randomUUID } from './random-id.ts'

type SyncMessage =
  | { type: 'request'; source: string }
  | { type: 'state'; source: string; data: Record<string, unknown> }

function channelName(recordId: string) {
  return `biu:page-block:${recordId}`
}

export function usePageBlockSync(
  recordId: string,
  data: Record<string, unknown>,
  onRemote: (data: Record<string, unknown>) => void,
) {
  const sourceRef = useRef(randomUUID())
  const channelRef = useRef<BroadcastChannel | null>(null)
  const dataRef = useRef(data)
  const remoteRef = useRef(onRemote)
  dataRef.current = data
  remoteRef.current = onRemote

  useEffect(() => {
    if (!recordId || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(channelName(recordId))
    channelRef.current = channel
    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const message = event.data
      if (!message || message.source === sourceRef.current) return
      if (message.type === 'request') {
        channel.postMessage({ type: 'state', source: sourceRef.current, data: dataRef.current } satisfies SyncMessage)
        return
      }
      if (message.type === 'state' && message.data && typeof message.data === 'object') {
        remoteRef.current(message.data)
      }
    }
    channel.postMessage({ type: 'request', source: sourceRef.current } satisfies SyncMessage)
    return () => {
      if (channelRef.current === channel) channelRef.current = null
      channel.close()
    }
  }, [recordId])

  return useCallback((next: Record<string, unknown>) => {
    channelRef.current?.postMessage({ type: 'state', source: sourceRef.current, data: next } satisfies SyncMessage)
  }, [])
}
