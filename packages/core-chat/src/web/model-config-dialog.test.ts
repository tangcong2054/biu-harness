/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatConfig } from './config.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

function mockConfigFetch(options?: { acceptsApiKeys?: boolean; modelCatalog?: boolean; replayMode?: string; failSave?: boolean }) {
  const endpoints = ['deepseek', 'openai', 'anthropic'].map((id) => ({
    id,
    label: id,
    provider: id,
    protocol: id === 'anthropic' ? 'anthropic' : 'openai-compat',
    group: 'official',
    baseUrl: `https://${id}.example.test/v1`,
    defaultBaseUrl: `https://${id}.example.test/v1`,
    configured: false,
    hint: '',
    placeholder: 'test-key',
    builtin: true,
  }))
  let config = {
    endpointId: 'deepseek',
    provider: 'deepseek',
    model: 'first-model',
    configured: false,
    hint: '',
    acceptsApiKeys: options?.acceptsApiKeys ?? true,
    replayMode: options?.replayMode,
    endpoints,
    modelCatalog: options?.modelCatalog === false ? [] : [
      { id: 'first', endpointId: 'deepseek', provider: 'deepseek', model: 'first-model', label: 'First model', builtin: true },
      { id: 'second', endpointId: 'deepseek', provider: 'deepseek', model: 'second-model', label: 'Second model', builtin: true },
    ],
  }
  const posts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posts.push(body)
      if (options?.failSave) return { ok: false, status: 400, json: async () => ({ error: 'invalid' }) }
      config = { ...config, ...body }
    }
    return { ok: true, status: 200, json: async () => config }
  }))
  return posts
}

describe('replay strategy settings', () => {
  it('defaults to native replay and can save an explicit lean choice without API keys or models', async () => {
    const posts = mockConfigFetch({ acceptsApiKeys: false, modelCatalog: false })
    render(createElement(ChatConfig))
    const select = await screen.findByRole('combobox', { name: '回放策略' }) as HTMLSelectElement
    expect(select.value).toBe('native-replay')
    expect(screen.getByRole('option', { name: 'lean-replay · 精简回放' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'native-replay · 原生回放（默认）' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'openai' }))
    fireEvent.change(select, { target: { value: 'lean-replay' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts).toEqual([{ replayMode: 'lean-replay' }]))
    await screen.findByText('已保存')
    expect(select.value).toBe('lean-replay')
    expect((screen.getByRole('button', { name: '保存回放策略' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/保存后下一回合生效/)).toBeTruthy()
    expect(screen.getByText(/旧会话缺失原生状态/)).toBeTruthy()
  })

  it('dedicated replay save never submits or clears a draft API key', async () => {
    const posts = mockConfigFetch({ replayMode: 'lean-replay' })
    render(createElement(ChatConfig))
    const select = await screen.findByRole('combobox', { name: '回放策略' })
    const key = screen.getByTestId('key-deepseek') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'draft-must-stay-local' } })
    fireEvent.change(select, { target: { value: 'native-replay' } })
    fireEvent.click(screen.getByRole('button', { name: '保存回放策略' }))
    await screen.findByText('回放策略已保存，下一回合生效')
    expect(posts).toEqual([{ replayMode: 'native-replay' }])
    expect(key.value).toBe('draft-must-stay-local')
  })

  it('preserves an unsaved replay draft when changing the default model', async () => {
    const posts = mockConfigFetch({ replayMode: 'lean-replay' })
    render(createElement(ChatConfig))
    const select = await screen.findByRole('combobox', { name: '回放策略' }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'native-replay' } })
    fireEvent.click(screen.getByRole('button', { name: /Second model/ }))
    await screen.findByText('默认模型：Second model')
    expect(posts).toEqual([{ endpointId: 'deepseek', model: 'second-model' }])
    expect(select.value).toBe('native-replay')
    fireEvent.click(screen.getByRole('button', { name: '保存回放策略' }))
    await screen.findByText('回放策略已保存，下一回合生效')
    expect(posts[1]).toEqual({ replayMode: 'native-replay' })
  })

  it('loads native replay from the server and keeps failed saves editable', async () => {
    const posts = mockConfigFetch({ replayMode: 'native-replay', failSave: true })
    render(createElement(ChatConfig))
    const select = await screen.findByRole('combobox', { name: '回放策略' }) as HTMLSelectElement
    expect(select.value).toBe('native-replay')
    fireEvent.change(select, { target: { value: 'lean-replay' } })
    fireEvent.click(screen.getByRole('button', { name: '保存回放策略' }))
    await screen.findByText('保存失败：HTTP 400')
    expect(posts).toEqual([{ replayMode: 'lean-replay' }])
    expect(select.value).toBe('lean-replay')
    expect((screen.getByRole('button', { name: '保存回放策略' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
