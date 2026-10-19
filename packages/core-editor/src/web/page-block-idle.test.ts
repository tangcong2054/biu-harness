import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import {
  PAGE_BLOCK_IDLE_MIN_PX,
  PAGE_BLOCK_IDLE_ROOT_MARGIN,
  pageBlockIdleQueueSize,
  resetPageBlockIdleQueue,
  schedulePageBlockMount,
} from './page-block-idle.ts'

afterEach(() => {
  resetPageBlockIdleQueue()
  vi.unstubAllGlobals()
})

test('page block idle mounts at most one plugin view per macrotask', () => {
  const timers: Array<() => void> = []
  vi.stubGlobal('setTimeout', (callback: () => void) => {
    timers.push(callback)
    return timers.length
  })
  vi.stubGlobal('clearTimeout', (id: number) => {
    timers[id - 1] = () => undefined
  })
  const seen: number[] = []
  schedulePageBlockMount(() => seen.push(1))
  schedulePageBlockMount(() => seen.push(2))
  schedulePageBlockMount(() => seen.push(3))
  assert.equal(pageBlockIdleQueueSize(), 3)

  timers.shift()!()
  assert.deepEqual(seen, [1])
  timers.shift()!()
  assert.deepEqual(seen, [1, 2])
  timers.shift()!()
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(pageBlockIdleQueueSize(), 0)
})

test('idle page block uses a stable shell and viewport prefetch margin', () => {
  assert.equal(PAGE_BLOCK_IDLE_MIN_PX, 200)
  assert.equal(PAGE_BLOCK_IDLE_ROOT_MARGIN, '160px')
})
