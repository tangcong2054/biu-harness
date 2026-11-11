/** @vitest-environment node */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import { test, vi } from 'vitest'
import * as http from '@biu/host-http'
import { currentAccountId, DATA_DIR_NAME } from '@biu/host-plugin-loader/data-dir'
import { artifactsDir, MAX_ATTACHMENT_BYTES } from '@biu/host-sessions/artifacts'
import type { UserMessageFile } from '@biu/type-session'
import { apply } from './index.ts'

const SESSION = 'attachment-session'
const OTHER_SESSION = 'other-session'
const HIDDEN_SESSION = 'hidden-session'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZusAAAAASUVORK5CYII=', 'base64')
const EDITOR = { authorization: 'Bearer editor-token', 'x-biu-workspace-id': 'workspace-a' }
const READER = { authorization: 'Bearer reader-token', 'x-biu-workspace-id': 'workspace-a' }

type SendOptions = {
  images?: UserMessageFile[]
  files?: UserMessageFile[]
  clientMessageId?: string
  extraTools?: string[]
  wait?: boolean
}
type Delivery = { kind: 'send' | 'inject'; sessionId: string; text: string; options: SendOptions }

class PromptStub extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  register() {}
}

class SessionsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
  peek(id?: string) {
    return [SESSION, OTHER_SESSION, HIDDEN_SESSION].includes(id ?? '')
      ? { id, config: {}, events: [] }
      : null
  }
  async get(id: string) { return this.peek(id) }
  async inWorkspaceAsync(id: string) { return id !== HIDDEN_SESSION }
}

class AgentsStub extends Service {
  deliveries: Delivery[] = []
  attempted: SendOptions[] = []
  createCalls = 0
  failAt: 'create' | 'send' | 'inject' | undefined
  constructor(ctx: Context) { super(ctx, 'agents') }
  configure() {}
  isBusy() { return false }
  listInbox() { return [] }
  async create(sessionId: string) {
    this.createCalls++
    if (this.failAt === 'create') throw new Error('agent creation failed')
    return {
      sessionId,
      send: async (text: string, options: SendOptions) => {
        this.attempted.push(structuredClone(options))
        if (this.failAt === 'send') throw new Error('agent send failed before enqueue')
        this.deliveries.push({ kind: 'send', sessionId, text, options: structuredClone(options) })
        return { text: 'accepted', steps: [] }
      },
      inject: (text: string, options: SendOptions) => {
        this.attempted.push(structuredClone(options))
        if (this.failAt === 'inject') throw new Error('agent inject failed before enqueue')
        this.deliveries.push({ kind: 'inject', sessionId, text, options: structuredClone(options) })
      },
    }
  }
}

class ToolsStub extends Service {
  registered = new Set<string>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(spec: { name: string }) { this.registered.add(spec.name) }
  setMode() {}
  setPinnedExtras() {}
  names() { return [] }
  catalog() { return [] }
}

class HubStub extends Service {
  constructor(ctx: Context) { super(ctx, 'hub') }
  register() {}
}

class AccountStub extends Service {
  hasLease = false
  constructor(ctx: Context) { super(ctx, 'account') }
  store = {
    accountByToken: (token: string) => token === 'editor-token' ? { id: 'editor' } : token === 'reader-token' ? { id: 'reader' } : null,
    isMember: (accountId: string, workspaceId: string) => ['editor', 'reader'].includes(accountId) && workspaceId === 'workspace-a',
    activeWorkspaceId: () => 'workspace-a',
    hasExecutionLease: () => this.hasLease,
  }
}

class DatabaseStub extends Service {
  checks: Array<{ path: string; action: string; accountId: string }> = []
  constructor(ctx: Context) { super(ctx, 'database') }
  async requirePath(path: string, action: string) {
    this.checks.push({ path, action, accountId: currentAccountId() })
    if (currentAccountId() !== 'editor') throw new Error('permission denied')
  }
}

type Fixture = { origin: string; home: string; agents: AgentsStub; account: AccountStub; database: DatabaseStub; tools: ToolsStub }

async function withSessionFiles(run: (fixture: Fixture) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'biu-session-files-http-'))
  vi.stubEnv('BIU_HOME', home)
  vi.stubEnv('BIU_ONLINE', '1')
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'CHAT_MODEL']) vi.stubEnv(key, '')
  const ctx = new Context()
  let close: (() => unknown) | undefined
  try {
    await ctx.plugin(PromptStub)
    await ctx.plugin(SessionsStub)
    await ctx.plugin(AgentsStub)
    await ctx.plugin(ToolsStub)
    await ctx.plugin(HubStub)
    await ctx.plugin(AccountStub)
    await ctx.plugin(DatabaseStub)
    const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
    const fiber = await ctx.plugin(http, { port: 0, host: '127.0.0.1', sharePort: 0 })
    close = () => fiber.dispose()
    apply(ctx)
    await run({
      origin: `http://127.0.0.1:${await ready}`,
      home,
      agents: ctx.get('agents') as unknown as AgentsStub,
      account: ctx.get('account') as unknown as AccountStub,
      database: ctx.get('database') as unknown as DatabaseStub,
      tools: ctx.get('tools') as unknown as ToolsStub,
    })
  } finally {
    await close?.()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}

async function upload(origin: string, name: string, body: Buffer | string, sessionId = SESSION, headers: Record<string, string> = EDITOR) {
  return fetch(`${origin}/api/sessions/${sessionId}/files/${encodeURIComponent(name)}`, {
    method: 'PUT', headers, body: typeof body === 'string' ? body : Uint8Array.from(body),
  })
}

function unfinishedUpload(origin: string, headers: Record<string, string>, write?: (socket: Socket) => Promise<void>) {
  const url = new URL(origin)
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    const chunks: Buffer[] = []
    let ended = false
    let received = false
    const fail = (error: Error) => { reject(error); socket.destroy() }
    let timer = setTimeout(() => fail(new Error('upload timed out')), 10000)
    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      if (!received) {
        received = true
        clearTimeout(timer)
        timer = setTimeout(() => fail(new Error('server did not close the rejected upload')), 2000)
      }
    })
    socket.once('end', () => { ended = true })
    socket.once('error', fail)
    socket.once('close', () => {
      clearTimeout(timer)
      if (!ended) reject(new Error('connection closed without a complete response'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    socket.once('connect', () => {
      socket.write([
        `PUT /api/sessions/${SESSION}/files/unfinished.bin HTTP/1.1`, `Host: ${url.host}`,
        'Connection: keep-alive', ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', '',
      ].join('\r\n'))
      void write?.(socket).catch(fail)
    })
  })
}

function assertClosedUpload(response: string, status: number, home: string) {
  assert.match(response, new RegExp(`^HTTP/1\\.1 ${status} `))
  assert.match(response, /\r\nconnection: close\r\n/i)
  const payload = response.slice(response.indexOf('\r\n\r\n') + 4)
  const chunk = /^([a-f\d]+)\r\n(.*)\r\n0\r\n\r\n$/s.exec(payload)
  assert.ok(chunk, response)
  assert.equal(parseInt(chunk[1]!, 16), Buffer.byteLength(chunk[2]!))
  assert.equal(typeof JSON.parse(chunk[2]!).error, 'string')
  assert.equal(response.includes(home), false)
}

async function uploaded(origin: string, name: string, body: Buffer | string, sessionId = SESSION) {
  const response = await upload(origin, name, body, sessionId)
  const file = await response.json() as UserMessageFile
  assert.equal(response.status, 201, JSON.stringify(file))
  assert.match(file.id, /^[a-f0-9-]{36}(?:\.[a-z0-9]{1,10})?$/)
  assert.equal(file.url, `/api/sessions/${sessionId}/artifacts/${file.id}`)
  assert.equal(file.size, Buffer.byteLength(body))
  return file
}

async function message(origin: string, payload: unknown, sessionId = SESSION, headers: Record<string, string> = EDITOR) {
  return fetch(`${origin}/api/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
}

async function assertError(response: Response, status: number, home: string) {
  assert.equal(response.status, status)
  const body = await response.text()
  assert.equal(typeof JSON.parse(body).error, 'string')
  assert.equal(body.includes(home), false)
  assert.equal(body.includes(process.cwd()), false)
}

test('real chat routes upload, send image/file references, and download from BIU_HOME rather than cwd', async () => {
  await withSessionFiles(async ({ origin, home, agents, database, tools }) => {
    assert.notEqual(home, process.cwd())
    const image = await uploaded(origin, '截图.png', PNG)
    const text = await uploaded(origin, 'notes.txt', 'attachment contents')
    assert.equal(image.mime, 'image/png')
    assert.equal(text.mime, 'application/octet-stream')
    const response = await message(origin, { text: 'review', files: [image.id, text.id], clientMessageId: 'message-1' })
    assert.equal(response.status, 200, await response.text())
    assert.equal(agents.deliveries.length, 1)
    const delivery = agents.deliveries[0]!
    assert.equal(delivery.text, 'review')
    assert.equal(delivery.sessionId, SESSION)
    assert.deepEqual(delivery.options.images, [image])
    assert.deepEqual(delivery.options.files, [text])
    assert.equal(delivery.options.clientMessageId, 'message-1')
    assert.equal(delivery.options.wait, false)
    assert.ok(delivery.options.extraTools?.includes('session_file_read'))
    assert.ok(tools.registered.has('session_file_read'))
    assert.equal(JSON.stringify(delivery).includes('base64'), false)
    assert.equal(JSON.stringify(delivery).includes(PNG.toString('base64')), false)
    assert.ok(database.checks.every((check) => check.path === `/sessions/${SESSION}` && check.action === 'resource:update' && check.accountId === 'editor'))
    for (const [file, data] of [[image, PNG], [text, Buffer.from('attachment contents')]] as const) {
      assert.deepEqual(await readFile(join(artifactsDir(SESSION, home), file.id)), data)
      assert.equal(existsSync(join(process.cwd(), DATA_DIR_NAME, 'artifacts', SESSION, file.id)), false)
      const downloaded = await fetch(`${origin}${file.url}`, { headers: READER })
      assert.equal(downloaded.status, 200)
      assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), data)
    }
    const inline = await fetch(`${origin}${image.url}`, { headers: EDITOR })
    assert.equal(inline.headers.get('content-type'), 'image/png')
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline;/)
    await inline.arrayBuffer()
  })
})

test('attachment routes require authentication, write authorization, and a visible session', async () => {
  await withSessionFiles(async ({ origin, home, agents, database }) => {
    const file = await uploaded(origin, 'safe.txt', 'safe')
    await assertError(await upload(origin, 'anonymous.txt', 'x', SESSION, {}), 401, home)
    await assertError(await message(origin, { files: [file.id] }, SESSION, {}), 401, home)
    await assertError(await fetch(`${origin}${file.url}`), 401, home)
    await assertError(await upload(origin, 'readonly.txt', 'x', SESSION, READER), 403, home)
    await assertError(await message(origin, { files: [file.id] }, SESSION, READER), 403, home)
    for (const id of [HIDDEN_SESSION, 'missing-session']) {
      await assertError(await upload(origin, 'hidden.txt', 'x', id), 404, home)
      await assertError(await message(origin, { files: [file.id] }, id), 404, home)
      await assertError(await fetch(`${origin}/api/sessions/${id}/artifacts/${file.id}`, { headers: EDITOR }), 404, home)
      assert.equal(existsSync(join(home, DATA_DIR_NAME, 'artifacts', id)), false)
    }
    assert.equal(agents.deliveries.length, 0)
    assert.ok(database.checks.some((check) => check.accountId === 'reader'))
  })
})

test('cross-session, unknown, URL, and path attachment references never reach agents', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const file = await uploaded(origin, 'one.txt', 'owned')
    const elsewhere = await uploaded(origin, 'two.txt', 'other', OTHER_SESSION)
    for (const id of [elsewhere.id, `${randomUUID()}.txt`]) {
      await assertError(await message(origin, { files: [id] }), 404, home)
    }
    for (const id of [
      file.url,
      `https://example.test${file.url}`,
      `file://${home}/private.txt`,
      `../${OTHER_SESSION}/${elsewhere.id}`,
      `/etc/passwd`,
      `%2e%2e%2f${file.id}`,
      `_meta/${file.id}.json`,
    ]) {
      await assertError(await message(origin, { files: [id] }), 400, home)
    }
    for (const url of ['https://example.test/image.png', `file://${home}/private.png`, file.url]) {
      await assertError(await message(origin, { images: [{ name: 'image.png', mime: 'image/png', url }] }), 400, home)
    }
    await assertError(await fetch(`${origin}/api/sessions/${OTHER_SESSION}/artifacts/${file.id}`, { headers: EDITOR }), 404, home)
    for (const name of ['..%2Fprivate.txt', `${file.id}%2F..`, `_meta%2F${file.id}.json`]) {
      await assertError(await fetch(`${origin}/api/sessions/${SESSION}/artifacts/${name}`, { headers: EDITOR }), 404, home)
    }
    assert.equal(agents.deliveries.length, 0)
  })
})

test('six mixed attachments are accepted and seven are rejected before agent dispatch', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const files: UserMessageFile[] = [await uploaded(origin, 'first.png', PNG)]
    for (let index = 1; index < 7; index++) files.push(await uploaded(origin, `${index}.txt`, `${index}`))
    const accepted = await message(origin, { files: files.slice(0, 6).map((file) => file.id) })
    assert.equal(accepted.status, 200, await accepted.text())
    assert.equal(agents.deliveries[0]!.options.files?.length, 5)
    assert.equal(agents.deliveries[0]!.options.images?.length, 1)
    await assertError(await message(origin, { files: files.map((file) => file.id) }), 400, home)
    await assertError(await message(origin, {
      files: files.slice(0, 6).map((file) => file.id),
      images: [{ name: 'legacy.png', url: `data:image/png;base64,${PNG.toString('base64')}` }],
    }), 400, home)
    assert.equal(agents.deliveries.length, 1)
  })
})

test('legacy image batches reject an invalid second image without persisting the valid first image', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const first = { name: 'first.png', url: `data:image/png;base64,${PNG.toString('base64')}` }
    for (const second of [
      { name: 'remote.png', url: 'https://example.test/image.png' },
      { name: 'invalid.png', url: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}` },
    ]) {
      await assertError(await message(origin, { images: [first, second] }), 400, home)
      assert.equal(existsSync(join(home, DATA_DIR_NAME, 'artifacts', SESSION)), false)
      assert.equal(agents.createCalls, 0)
      assert.equal(agents.deliveries.length, 0)
    }
  })
})

test('invalid client message IDs reject legacy images before creating files or agents', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const images = [{ name: 'legacy.png', url: `data:image/png;base64,${PNG.toString('base64')}` }]
    for (const clientMessageId of ['', 'invalid/id', 'a'.repeat(129), 123, null]) {
      await assertError(await message(origin, { images, clientMessageId }), 400, home)
      assert.equal(existsSync(join(home, DATA_DIR_NAME, 'artifacts', SESSION)), false)
      assert.equal(agents.createCalls, 0)
      assert.equal(agents.deliveries.length, 0)
    }
  })
})

test('execution lease conflicts reject legacy images without creating files or agents', async () => {
  await withSessionFiles(async ({ origin, home, agents, account }) => {
    account.hasLease = true
    const images = [{ name: 'legacy.png', url: `data:image/png;base64,${PNG.toString('base64')}` }]
    await assertError(await message(origin, { images }), 409, home)
    assert.equal(existsSync(join(home, DATA_DIR_NAME, 'artifacts', SESSION)), false)
    assert.equal(agents.createCalls, 0)
    assert.equal(agents.deliveries.length, 0)
    account.hasLease = false
    const accepted = await message(origin, { images })
    assert.equal(accepted.status, 200, await accepted.text())
    assert.equal(agents.deliveries.length, 1)
  })
})

test.each(['create', 'send', 'inject'] as const)('failed agent %s before enqueue leaves no new legacy files and preserves existing attachments', async (phase) => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const existing = await uploaded(origin, 'existing.txt', 'keep this attachment')
    const dir = artifactsDir(SESSION, home)
    const before = (await readdir(dir, { recursive: true })).sort()
    agents.failAt = phase
    await assertError(await message(origin, {
      kind: phase === 'inject' ? 'inject' : undefined,
      images: [{ name: 'legacy.png', url: `data:image/png;base64,${PNG.toString('base64')}` }],
      files: [existing.id],
    }), 500, home)
    assert.equal(agents.createCalls, 1)
    assert.equal(agents.deliveries.length, 0)
    assert.equal(agents.attempted.length, phase === 'create' ? 0 : 1)
    if (phase !== 'create') {
      const attempted = agents.attempted[0]!
      assert.deepEqual(attempted.files, [existing])
      assert.equal(attempted.images?.length, 1)
      const file = attempted.images![0]!
      assert.equal(existsSync(join(dir, file.id)), false)
      assert.equal(existsSync(join(dir, '_meta', `${file.id}.json`)), false)
    }
    assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before)
    assert.equal(await readFile(join(dir, existing.id), 'utf8'), 'keep this attachment')
  })
})

test('legacy image data URLs are persisted and inject receives only stable references', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const raw = `data:image/png;base64,${PNG.toString('base64')}`
    const response = await message(origin, {
      kind: 'inject', text: 'legacy image', images: [{ name: 'legacy.png', mime: 'image/png', url: raw }], clientMessageId: 'legacy-1',
    })
    assert.equal(response.status, 200, await response.text())
    const delivery = agents.deliveries[0]!
    assert.equal(delivery.kind, 'inject')
    assert.equal(delivery.options.clientMessageId, 'legacy-1')
    const file = delivery.options.images?.[0]
    assert.ok(file)
    assert.equal(file.mime, 'image/png')
    assert.equal(file.size, PNG.length)
    assert.equal(file.url, `/api/sessions/${SESSION}/artifacts/${file.id}`)
    assert.equal(JSON.stringify(delivery).includes('base64'), false)
    assert.deepEqual(await readFile(join(artifactsDir(SESSION, home), file.id)), PNG)
    const download = await fetch(`${origin}${file.url}`, { headers: EDITOR })
    assert.equal(download.status, 200)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG)
  })
})

test('HTML and SVG downloads remain non-executable attachments with nosniff and sandbox', async () => {
  await withSessionFiles(async ({ origin, agents }) => {
    for (const [name, content, mime] of [
      ['active.html', '<script>window.bad=true</script>', 'text/html'],
      ['active.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="window.bad=true"/>', 'image/svg+xml'],
    ] as const) {
      const response = await upload(origin, name, content, SESSION, { ...EDITOR, 'content-type': mime })
      assert.equal(response.status, 201)
      const file = await response.json() as UserMessageFile
      assert.equal(file.mime, 'application/octet-stream')
      const sent = await message(origin, { files: [file.id] })
      assert.equal(sent.status, 200, await sent.text())
      assert.equal(agents.deliveries.at(-1)!.options.images, undefined)
      assert.deepEqual(agents.deliveries.at(-1)!.options.files, [file])
      const download = await fetch(`${origin}${file.url}`, { headers: EDITOR })
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('content-type'), 'application/octet-stream')
      assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/)
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
      assert.match(download.headers.get('content-security-policy') ?? '', /sandbox/)
      assert.equal(download.headers.get('cache-control'), 'private, no-store')
      assert.equal(await download.text(), content)
    }
  })
})

test('rejected keep-alive uploads close without EOF for authentication, authorization, and declared size', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    for (const [headers, status] of [
      [{ 'transfer-encoding': 'chunked' }, 401],
      [{ ...READER, 'transfer-encoding': 'chunked' }, 403],
      [{ ...EDITOR, 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }, 413],
    ] as const) {
      assertClosedUpload(await unfinishedUpload(origin, headers), status, home)
      assert.equal(existsSync(join(home, DATA_DIR_NAME, 'artifacts', SESSION)), false)
    }
    assert.equal(agents.deliveries.length, 0)
  })
})

test('oversized keep-alive chunked uploads send complete 413 and close without EOF or partial files', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const response = await unfinishedUpload(origin, { ...EDITOR, 'transfer-encoding': 'chunked' }, async (socket) => {
      const chunk = Buffer.alloc(1024 * 1024, 97)
      for (let sent = 0; sent < MAX_ATTACHMENT_BYTES; sent += chunk.length) {
        socket.write(`${chunk.length.toString(16)}\r\n`)
        if (!socket.write(chunk)) await once(socket, 'drain')
        socket.write('\r\n')
      }
      socket.write('1\r\na\r\n')
    })
    assertClosedUpload(response, 413, home)
    const dir = artifactsDir(SESSION, home)
    assert.deepEqual((await readdir(dir)).filter((name) => name !== '_meta'), [])
    assert.deepEqual(await readdir(join(dir, '_meta')), [])
    assert.equal(agents.deliveries.length, 0)
    await uploaded(origin, 'after-rejection.txt', 'still usable')
  })
}, 20000)

test('chunked upload over 20 MiB returns 413 before EOF and leaves no partial files', async () => {
  await withSessionFiles(async ({ origin, home, agents }) => {
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request(`${origin}/api/sessions/${SESSION}/files/too-large.bin`, {
        method: 'PUT', headers: { ...EDITOR, 'transfer-encoding': 'chunked' }, agent: false,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.once('error', reject)
        res.once('end', () => {
          req.end()
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      req.once('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('upload timed out')))
      void (async () => {
        const chunk = Buffer.alloc(1024 * 1024, 97)
        for (let sent = 0; sent < MAX_ATTACHMENT_BYTES; sent += chunk.length) {
          if (!req.write(chunk)) await once(req, 'drain')
        }
        req.write(Buffer.from([97]))
      })().catch(reject)
    })
    assert.equal(response.status, 413)
    assert.equal(typeof JSON.parse(response.body).error, 'string')
    assert.equal(response.body.includes(home), false)
    const dir = artifactsDir(SESSION, home)
    assert.deepEqual((await readdir(dir)).filter((name) => name !== '_meta'), [])
    assert.deepEqual(await readdir(join(dir, '_meta')), [])
    assert.equal(agents.deliveries.length, 0)
    const after = await uploaded(origin, 'after.txt', 'still usable')
    const download = await fetch(`${origin}${after.url}`, { headers: EDITOR })
    assert.equal(download.status, 200)
    assert.equal(await download.text(), 'still usable')
  })
}, 20000)
