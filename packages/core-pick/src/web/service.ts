import { useSyncExternalStore } from 'react'
import { Service, type Context } from 'cordis'
import { pickKey, dedupePicks, type PickRef } from './types.ts'

export type PickHover = { top: number; left: number; width: number; height: number }
export type PickDraft = { text: string; send?: boolean }

const PICK_CHANNEL = 'biu:pick:v1'

type PickSyncMessage =
  | { type: 'hello'; source: string }
  | { type: 'request-mode'; source: string; picking: boolean }
  | { type: 'mode'; source: string; picking: boolean; route: string }
  | { type: 'picked'; source: string; refs: PickRef[]; attach?: boolean; draft?: PickDraft }

let boundPick: PickService | undefined

export function getPick() {
  return boundPick
}

export class PickService extends Service {
  picking = false
  refs: PickRef[] = []
  hover: PickHover | null = null
  marquee: PickHover | null = null
  marqueeHits: PickHover[] = []
  draft: PickDraft | null = null
  /**
   * 当前 refs 属于哪个会话。null 表示还没归属（例如冷启动、还没选中会话时在页面里按了 Ctrl/Cmd+L）。
   * refs 本身是全局一份；输入栏草稿按会话保存，靠这个字段区分「同一会话重挂」和「换了会话」。
   */
  sessionOwner: string | null = null
  private seq = 0
  private listeners = new Set<() => void>()
  private readonly source = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  private readonly popout =
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('popout') === 'page-block'
  private channel: BroadcastChannel | null = null
  private pickRoute = typeof window === 'undefined' ? '/' : window.location.pathname

  constructor(ctx: Context) {
    super(ctx, 'pick')
    boundPick = this
    ctx.effect(() => {
      if (typeof window === 'undefined') return
      const onClosed = () => this.exit()
      window.addEventListener('biu:overlay-closed', onClosed)
      const Channel = window.BroadcastChannel
      if (Channel) {
        this.channel = new Channel(PICK_CHANNEL)
        this.channel.onmessage = (event) => this.receive(event.data)
        this.publish({ type: 'hello', source: this.source })
      }
      return () => {
        window.removeEventListener('biu:overlay-closed', onClosed)
        this.channel?.close()
        this.channel = null
        if (boundPick === this) boundPick = undefined
      }
    })
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  version = () => this.seq

  route() {
    return this.pickRoute
  }

  enter() {
    this.applyMode(true)
    this.publishMode(true)
  }

  exit() {
    this.applyMode(false)
    this.publishMode(false)
  }

  toggle() {
    if (this.picking) this.exit()
    else this.enter()
  }

  add(ref: PickRef) {
    this.addMany([ref])
  }

  addMany(refs: PickRef[]) {
    if (!refs.length) {
      this.hover = null
      this.marquee = null
      this.marqueeHits = []
      this.bump()
      return
    }
    this.applyRefs(refs)
    if (this.popout) {
      this.publish({ type: 'picked', source: this.source, refs })
      return
    }
    // 选取模式下点一次对象就打开聊天窗；关窗后 picking=false，草稿同步不会再弹窗。
    if (this.picking && typeof window !== 'undefined') this.emitAttached()
  }

  private applyRefs(refs: PickRef[]) {
    this.refs = dedupePicks([...this.refs, ...refs])
    this.hover = null
    this.marquee = null
    this.marqueeHits = []
    this.bump()
  }

  /** 把选区交给对话框；不依赖选取模式。可带一句指令，composer 灌进输入框并可直接发送。 */
  attach(refs: PickRef[], draft?: PickDraft) {
    if (this.popout) {
      const nextDraft = draft?.text.trim()
        ? { text: draft.text.trim(), send: Boolean(draft.send) }
        : undefined
      this.applyRefs(refs)
      this.publish({
        type: 'picked',
        source: this.source,
        refs,
        attach: true,
        ...(nextDraft ? { draft: nextDraft } : {}),
      })
      return
    }
    if (draft?.text.trim()) this.draft = { text: draft.text.trim(), send: Boolean(draft.send) }
    const picking = this.picking
    this.addMany(refs)
    if (!picking && typeof window !== 'undefined') this.emitAttached()
  }

  takeDraft() {
    const next = this.draft
    this.draft = null
    return next
  }

  private emitAttached() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new Event('biu:pick-attached'))
  }

  private emitMode() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('biu:pick-mode', { detail: { picking: this.picking } }))
  }

  private applyMode(picking: boolean) {
    if (this.picking === picking && !this.hover && !this.marquee) return
    this.picking = picking
    this.hover = null
    this.marquee = null
    this.marqueeHits = []
    this.bump()
    this.emitMode()
  }

  private publishMode(picking: boolean) {
    if (this.popout) {
      this.publish({ type: 'request-mode', source: this.source, picking })
      return
    }
    this.pickRoute = window.location.pathname
    this.publish({
      type: 'mode',
      source: this.source,
      picking,
      route: this.pickRoute,
    })
  }

  private publish(message: PickSyncMessage) {
    this.channel?.postMessage(message)
  }

  private receive(value: unknown) {
    if (!value || typeof value !== 'object') return
    const message = value as Partial<PickSyncMessage>
    if (!message.type || message.source === this.source) return
    if (message.type === 'hello') {
      if (!this.popout) this.publishMode(this.picking)
      return
    }
    if (message.type === 'request-mode') {
      if (this.popout || typeof message.picking !== 'boolean') return
      this.applyMode(message.picking)
      this.publishMode(message.picking)
      return
    }
    if (message.type === 'mode') {
      if (!this.popout || typeof message.picking !== 'boolean') return
      if (typeof message.route === 'string' && message.route) this.pickRoute = message.route
      this.applyMode(message.picking)
      return
    }
    if (message.type !== 'picked' || this.popout || !Array.isArray(message.refs)) return
    if (message.attach) this.attach(message.refs, message.draft)
    else this.addMany(message.refs)
  }

  removeLast() {
    if (!this.refs.length) return
    this.refs = this.refs.slice(0, -1)
    this.bump()
  }

  remove(key: string) {
    const next = this.refs.filter((item) => pickKey(item) !== key)
    if (next.length === this.refs.length) return
    this.refs = next
    this.bump()
  }

  clear() {
    if (!this.refs.length) return
    this.refs = []
    this.bump()
  }

  /**
   * 输入栏绑定到某个会话时调用，返回现有 refs 能否留在这个会话里：
   * - 同一会话（重挂输入栏、开关悬浮窗）或尚未归属：可以保留，并归到该会话；
   * - 换了会话：不能保留，调用方应清空后只按新会话自己的草稿恢复；
   * - 没有会话（如当前会话被删）：清掉上一个会话留下的 refs，之后加入的 refs 等下一个会话认领。
   */
  claimSession(sessionId: string | null | undefined): boolean {
    const next = sessionId || null
    const prev = this.sessionOwner
    this.sessionOwner = next
    if (!next) {
      if (prev) this.clear()
      return false
    }
    return prev === null || prev === next
  }

  setHover(hover: PickHover | null) {
    const prev = this.hover
    if (prev === hover) return
    if (
      prev && hover
      && prev.top === hover.top && prev.left === hover.left
      && prev.width === hover.width && prev.height === hover.height
    ) return
    this.hover = hover
    this.bump()
  }

  setMarquee(marquee: PickHover | null, hits: PickHover[] = []) {
    this.marquee = marquee
    this.marqueeHits = marquee ? hits : []
    if (marquee) this.hover = null
    this.bump()
  }

  private bump() {
    this.seq += 1
    for (const fn of this.listeners) fn()
  }
}

export function usePickState(pick?: PickService) {
  useSyncExternalStore(
    (fn) => (pick ? pick.subscribe(fn) : () => {}),
    () => pick?.version() ?? 0,
    () => 0,
  )
  return {
    picking: pick?.picking ?? false,
    refs: pick?.refs ?? [],
    hover: pick?.hover ?? null,
    marquee: pick?.marquee ?? null,
    marqueeHits: pick?.marqueeHits ?? [],
  }
}
