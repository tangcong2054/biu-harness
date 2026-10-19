export const PAGE_BLOCK_IDLE_MIN_PX = 200
export const PAGE_BLOCK_IDLE_ROOT_MARGIN = '160px'

type MountFn = () => void

let pending: MountFn[] = []
let timer: ReturnType<typeof setTimeout> | undefined

export function resetPageBlockIdleQueue() {
  pending = []
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function flush() {
  timer = undefined
  const next = pending.shift()
  if (!next) return
  next()
  if (pending.length) timer = setTimeout(flush, 0)
}

/** 每个 macrotask 最多挂载一个插件 View，避免长页面在同一帧形成长任务。 */
export function schedulePageBlockMount(fn: MountFn) {
  pending.push(fn)
  if (timer !== undefined) return
  timer = setTimeout(flush, 0)
}

export function pageBlockIdleQueueSize() {
  return pending.length
}
