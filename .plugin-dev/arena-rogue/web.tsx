import { useEffect, useRef } from 'react'
import { ArenaGame } from './game.ts'
import { WEAPONS } from './weapons.ts'

export const name = 'arena-rogue'
export const inject = ['slots', 'uiActions']

type UiActionsApi = { register: (spec: Record<string, unknown>) => () => void }
let uiActions: UiActionsApi | undefined

function ArenaApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const gameRef = useRef<ArenaGame | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const g = new ArenaGame()
    gameRef.current = g
    g.start()
    const disposeActions = uiActions?.register({
      plugin: name,
      instanceId: 'game',
      kind: 'canvas-game',
      label: 'Arena Rogue',
      surface: 'main',
      state: () => ({
        wave: g.wave,
        over: g.over,
        weapon: g.weapon,
        weaponName: WEAPONS[g.weapon]?.name,
        player: {
          hp: g.player.hp,
          maxHp: g.player.max,
          level: g.player.level,
          score: g.player.score,
          kills: g.player.kills,
        },
      }),
      actions: {
        read_state: {
          description: '读取当前游戏状态',
          risk: 'read',
          run: () => ({
            wave: g.wave,
            over: g.over,
            weapon: g.weapon,
            weaponName: WEAPONS[g.weapon]?.name,
            player: g.player,
          }),
        },
        restart: {
          description: '重新开始游戏',
          risk: 'submit',
          run: () => {
            g.start()
            return { restarted: true }
          },
        },
        select_weapon: {
          description: '选择武器序号',
          risk: 'write',
          inputSchema: {
            type: 'object',
            properties: { index: { type: 'number' } },
            required: ['index'],
          },
          run: ({ index }: { index?: unknown }) => {
            const next = Math.floor(Number(index))
            if (!Number.isInteger(next) || next < 1 || next > WEAPONS.length) {
              throw new Error(`武器序号必须在 1-${WEAPONS.length} 之间`)
            }
            g.weapon = next - 1
            return { weapon: next, name: WEAPONS[g.weapon]?.name }
          },
        },
      },
    })
    const parent = canvas.parentElement
    let raf = 0
    let last = performance.now()

    const fit = () => {
      const w = parent?.clientWidth || 1080
      const h = parent?.clientHeight || 720
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      g.w = w
      g.h = h
      g.dpr = dpr
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (parent) ro.observe(parent)

    const toWorld = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect()
      return { x: clientX - r.left - g.w / 2, y: clientY - r.top - g.h / 2 }
    }

    const onKey = (event: KeyboardEvent, down: boolean) => {
      const k = event.key.toLowerCase()
      if (down) {
        if (k === 'r' && g.over) g.start()
        if (k === 'q') g.weapon = (g.weapon + WEAPONS.length - 1) % WEAPONS.length
        if (k === 'e') g.weapon = (g.weapon + 1) % WEAPONS.length
        if (k >= '1' && k <= '9') g.weapon = Number(k) - 1
        if (k === '0') g.weapon = 9
        if (k === '-') g.weapon = 10
        if (k === '=') g.weapon = 11
        if (g.pick && k >= '1' && k <= '3') {
          g.pick[Number(k) - 1]?.apply()
          g.pick = null
        }
      }
      if (down) g.keys.add(k)
      else g.keys.delete(k)
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) event.preventDefault()
    }
    const down = (e: KeyboardEvent) => onKey(e, true)
    const up = (e: KeyboardEvent) => onKey(e, false)
    const move = (e: PointerEvent) => {
      const p = toWorld(e.clientX, e.clientY)
      g.mouse.x = p.x
      g.mouse.y = p.y
    }
    const press = (e: PointerEvent) => {
      canvas.focus()
      const p = toWorld(e.clientX, e.clientY)
      g.mouse.x = p.x
      g.mouse.y = p.y
      g.mouse.down = true
      g.clickPick(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top)
    }
    const release = () => {
      g.mouse.down = false
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)

    const loop = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000)
      last = now
      g.step(dt)
      const ctx = canvas.getContext('2d')
      if (ctx) g.draw(ctx)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      disposeActions?.()
    }
  }, [])

  return (
    <div
      data-testid="arena-rogue-root"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: '#07080c',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        data-testid="arena-rogue-canvas"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'block',
          width: '100%',
          height: '100%',
          outline: 'none',
          cursor: 'crosshair',
        }}
      />
    </div>
  )
}

export function apply(ctx: {
  uiActions: UiActionsApi
  slots: { place: (slot: string, Comp: unknown, opt: { key: string }) => void }
}) {
  uiActions = ctx.uiActions
  ctx.slots.place('plugin-store-extras', ArenaApp, { key: 'arena-rogue' })
}
