import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('model config dialog stacking', () => {
  it('portals above the inspector and composer dock', () => {
    const src = readFileSync(resolve(import.meta.dirname, './model-config-dialog.tsx'), 'utf8')
    expect(src).toMatch(/createPortal/)
    expect(src).toMatch(/document\.body/)
    expect(src).toMatch(/z-\[240\]/)
    expect(src).not.toMatch(/z-30/)
  })

  it('hides delete for builtin custom endpoints in both sidebar and detail', () => {
    const host = readFileSync(resolve(import.meta.dirname, '../host/index.ts'), 'utf8')
    const config = readFileSync(resolve(import.meta.dirname, './config.tsx'), 'utf8')
    expect(host).toMatch(/builtin: raw\.builtin === true/)
    expect(host).toMatch(/builtin: ep\.builtin === true/)
    expect(config).toMatch(/!\(ep\.group === 'custom' && ep\.builtin === true\)/)
    expect(config).toMatch(/opts\?\.removable !== false && canRemoveConnection\(ep\)/)
    expect(config).toMatch(/if \(!canRemoveConnection\(endpoints\.find\(\(ep\) => ep\.id === id\)\)\) return/)
  })

  it('does not repeat thinking or effort knobs already on the composer', () => {
    const src = readFileSync(resolve(import.meta.dirname, './config.tsx'), 'utf8')
    expect(src).not.toMatch(/ModelModeControls/)
    expect(src).not.toMatch(/thinking:/)
    expect(src).not.toMatch(/reasoningEffort/)
  })
})
