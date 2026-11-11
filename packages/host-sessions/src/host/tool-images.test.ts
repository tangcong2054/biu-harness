import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { liftToolImages } from './tool-images.ts'
import { artifactsDir } from './artifacts.ts'
import type { LlmMessage } from '@biu/host-llm'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const DATA_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`

test('liftToolImages turns bash artifacts into image_url blocks', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'biu-lift-'))
  const dir = artifactsDir('sess-1', baseDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'shot.png'), TINY_PNG)

  const messages: LlmMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: '1',
      content: JSON.stringify({
        stdout: 'wrote shot.png',
        artifacts: [{ name: 'shot.png', mime: 'image/png', url: '/api/sessions/sess-1/artifacts/shot.png' }],
      }),
    },
  ]
  const lifted = await liftToolImages(messages, 'sess-1', { baseDir })
  const parts = lifted[1]?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
  assert.equal(parts[0]?.type, 'text')
  assert.equal(parts[1]?.type, 'image_url')
  assert.equal(parts[1]?.image_url?.url, DATA_URL)
})

test('liftToolImages reads web_fetch local image files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'biu-lift-web-'))
  const path = join(dir, 'hero.png')
  await writeFile(path, TINY_PNG)
  const messages: LlmMessage[] = [
    {
      role: 'tool',
      tool_call_id: '2',
      content: JSON.stringify({
        file: { path, mime: 'image/png', bytes: TINY_PNG.length },
        text: `saved image → ${path}`,
      }),
    },
  ]
  const lifted = await liftToolImages(messages, 'sess-web')
  const parts = lifted[0]?.content as Array<{ type: string; image_url?: { url: string } }>
  assert.equal(parts[1]?.image_url?.url, DATA_URL)
})

test('liftToolImages materializes same-session user attachments and preserves historical data URLs without mutation', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'biu-user-image-'))
  const id = '11111111-1111-4111-8111-111111111111.png'
  const dir = artifactsDir('sess-user', baseDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, id), TINY_PNG)
  const messages: LlmMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: `/api/sessions/sess-user/artifacts/${id}`, detail: 'high' } },
    { type: 'image_url', image_url: { url: DATA_URL } },
  ] }]
  const before = JSON.stringify(messages)
  const lifted = await liftToolImages(messages, 'sess-user', { baseDir })
  assert.deepEqual(lifted[0]?.content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: DATA_URL, detail: 'high' } },
    { type: 'image_url', image_url: { url: DATA_URL } },
  ])
  assert.equal(JSON.stringify(messages), before)
})

test('liftToolImages rejects cross-session, external, malformed and missing user image references', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'biu-user-image-bad-'))
  const id = '11111111-1111-4111-8111-111111111111.png'
  const urls = [
    `/api/sessions/other/artifacts/${id}`,
    `https://example.com/api/sessions/sess/artifacts/${id}`,
    `http://127.0.0.1/private.png`,
    'file:///etc/passwd',
    '/etc/private.png',
    `/api/sessions/sess/artifacts/${id}?download=1`,
    `/API/sessions/sess/artifacts/${id}`,
    `/api/sessions/sess/ARTIFACTS/${id}`,
    '/api/sessions/sess/artifacts/%2e%2e%2fprivate.png',
    '/api/sessions/sess/artifacts/shot.png',
    `/api/sessions/sess/artifacts/${id}`,
  ]
  const messages: LlmMessage[] = [{ role: 'user', content: urls.map((url) => ({ type: 'image_url', image_url: { url } })) }]
  const lifted = await liftToolImages(messages, 'sess', { baseDir })
  const content = lifted[0]?.content
  assert.ok(Array.isArray(content))
  assert.equal(content.length, urls.length)
  for (const part of content) {
    assert.equal(part.type, 'text')
    if (part.type === 'text') assert.match(part.text, /图片附件不可用/)
  }
  const withoutSession = await liftToolImages(messages, '', { baseDir })
  assert.ok(Array.isArray(withoutSession[0]?.content))
  assert.equal(withoutSession[0].content.every((part) => part.type === 'text'), true)
})

test('liftToolImages accepts user images up to 20MiB and reports larger images as unavailable', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'biu-user-image-size-'))
  const dir = artifactsDir('sess-size', baseDir)
  await mkdir(dir, { recursive: true })
  const ids = ['11111111-1111-4111-8111-111111111111.png', '22222222-2222-4222-8222-222222222222.png']
  await writeFile(join(dir, ids[0]!), Buffer.alloc(20 * 1024 * 1024, 1))
  await writeFile(join(dir, ids[1]!), Buffer.alloc(20 * 1024 * 1024 + 1, 1))
  const messages: LlmMessage[] = [{ role: 'user', content: ids.map((id) => ({
    type: 'image_url', image_url: { url: `/api/sessions/sess-size/artifacts/${id}` },
  })) }]
  const lifted = await liftToolImages(messages, 'sess-size', { baseDir })
  const content = lifted[0]?.content
  assert.ok(Array.isArray(content))
  assert.equal(content[0]?.type, 'image_url')
  assert.equal(content[1]?.type, 'text')
  if (content[1]?.type === 'text') assert.match(content[1].text, /20MiB/)
})

test('liftToolImages leaves plain tool text alone', async () => {
  const messages: LlmMessage[] = [{ role: 'tool', tool_call_id: '3', content: 'pong' }]
  const lifted = await liftToolImages(messages, 'sess')
  assert.equal(lifted[0]?.content, 'pong')
})

test('liftToolImages ignores image paths that are only mentioned in text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'biu-lift-skip-'))
  const path = join(dir, 'hero.png')
  await writeFile(path, TINY_PNG)
  const messages: LlmMessage[] = [
    {
      role: 'tool',
      tool_call_id: '4',
      content: JSON.stringify({
        stdout: `wrote ${path}`,
        images: ['https://cdn.example.com/hero.png'],
        text: 'page has images',
      }),
    },
  ]
  const lifted = await liftToolImages(messages, 'sess-skip')
  assert.equal(lifted[0]?.content, messages[0]?.content)
})
