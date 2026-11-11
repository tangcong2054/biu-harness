import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { Agent, createServer, request, type ClientRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import { WebSocket } from 'ws'
import * as http from './index.ts'
import { deliverTenantEvent } from './index.ts'
import { currentAccountId } from '@biu/host-plugin-loader/data-dir'

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'))
        return
      }
      const port = addr.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
    server.on('error', reject)
  })
}

async function withBodyServer(run: (ctx: Context, origin: string) => Promise<void>, bodyLimitBytes?: number) {
  const ctx = new Context()
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
  const fiber = await ctx.plugin(http, { port: 0, host: '127.0.0.1', sharePort: 0, bodyLimitBytes })
  try {
    await run(ctx, `http://127.0.0.1:${await ready}`)
  } finally {
    await fiber.dispose()
  }
}

function postBody(url: string, headers: Record<string, string>, write: (req: ClientRequest) => void) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => {
        req.end()
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.once('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')))
    write(req)
  })
}

function unfinishedRequest(origin: string, path: string, headers: Record<string, string>, body = '') {
  const url = new URL(origin)
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    const chunks: Buffer[] = []
    let ended = false
    const timer = setTimeout(() => {
      reject(new Error('server did not close the unfinished request'))
      socket.destroy()
    }, 2000)
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('end', () => { ended = true })
    socket.once('error', reject)
    socket.once('close', () => {
      clearTimeout(timer)
      if (!ended) reject(new Error('connection closed without a complete response'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    socket.once('connect', () => {
      socket.write([
        `POST ${path} HTTP/1.1`, `Host: ${url.host}`, 'Connection: keep-alive',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', body,
      ].join('\r\n'))
    })
  })
}

function assertClosedResponse(response: string, status: number, body: unknown) {
  assert.match(response, new RegExp(`^HTTP/1\\.1 ${status} `))
  assert.match(response, /\r\nconnection: close\r\n/i)
  assert.ok(response.endsWith(`${JSON.stringify(body)}\r\n0\r\n\r\n`), response)
}

test('JSON and bytes default to 32 MiB and retain legacy image JSON payloads', async () => {
  await withBodyServer(async (ctx, origin) => {
    const limit = 32 * 1024 * 1024
    assert.equal((ctx.http as unknown as http.HttpService).config.bodyLimitBytes, limit)
    ctx.http.route('POST', '/json', async (route) => {
      const data = await route.json<{ image: string }>()
      route.send(200, { length: data.image.length })
    })
    ctx.http.route('POST', '/bytes', async (route) => route.send(200, { length: (await route.bytes()).length }))
    const image = `data:image/png;base64,${'a'.repeat(2 * 1024 * 1024)}`
    const response = await fetch(`${origin}/json`, { method: 'POST', body: JSON.stringify({ image }) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { length: image.length })
    for (const path of ['/json', '/bytes']) {
      const oversized = await postBody(`${origin}${path}`, { 'Content-Length': String(limit + 1) }, (req) => req.flushHeaders())
      assert.equal(oversized.status, 413)
      assert.deepEqual(oversized.body, { error: 'request body too large' })
    }
  })
})

test('JSON accepts empty bodies and exact UTF-8 byte limits with cached bytes', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/json', async (route) => {
      const data = await route.json()
      const bytes = await route.bytes()
      assert.strictEqual(await route.bytes(), bytes)
      route.send(200, { data, length: bytes.length })
    })
    const data = { value: `${'你'.repeat(16)}abcd` }
    const body = JSON.stringify(data)
    assert.equal(Buffer.byteLength(body), 64)
    for (const payload of ['', body]) {
      const response = await fetch(`${origin}/json`, { method: 'POST', body: payload })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { data: payload ? data : null, length: Buffer.byteLength(payload) })
    }
  }, 64)
})

test('invalid JSON is 400 even when a route catches the parse error', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/json', async (route) => route.send(200, await route.json()))
    ctx.http.route('POST', '/fallback', async (route) => route.send(200, await route.json().catch(() => ({ ok: true }))))
    for (const path of ['/json', '/fallback']) {
      const response = await fetch(`${origin}${path}`, { method: 'POST', body: '{"path":"/private/secret",invalid}' })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: 'invalid json' })
    }
  }, 64)
})

test('oversized content-length rejects JSON and bytes before receiving a body', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/json', async (route) => route.send(200, await route.json()))
    ctx.http.route('POST', '/bytes', async (route) => route.send(200, { length: (await route.bytes()).length }))
    for (const path of ['/json', '/bytes']) {
      const response = await postBody(`${origin}${path}`, { 'Content-Length': '65' }, (req) => req.flushHeaders())
      assert.equal(response.status, 413)
      assert.deepEqual(response.body, { error: 'request body too large' })
    }
  }, 64)
})

test('chunked JSON enforces accumulated bytes before EOF and cannot be changed to success by catch', async () => {
  await withBodyServer(async (ctx, origin) => {
    let caught = false
    ctx.http.route('POST', '/json', async (route) => route.send(200, await route.json()))
    ctx.http.route('POST', '/fallback', async (route) => {
      await route.json().catch(() => { caught = true })
      assert.equal(route.res.statusCode, 413)
      assert.equal(route.res.writableEnded, true)
      await route.bytes().catch(() => null)
      route.send(200, { ok: true })
    })
    for (const path of ['/json', '/fallback']) {
      const response = await postBody(`${origin}${path}`, { 'Transfer-Encoding': 'chunked' }, (req) => {
        req.write('"')
        req.write('你'.repeat(10))
        req.write('你'.repeat(10))
        req.write('abcd')
      })
      assert.equal(response.status, 413)
      assert.deepEqual(response.body, { error: 'request body too large' })
    }
    assert.equal(caught, true)
  }, 64)
})

test('bytes accepts the exact binary limit and rejects oversized chunked bodies', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/bytes', async (route) => {
      const bytes = await route.bytes().catch(() => Buffer.alloc(0))
      route.send(200, { data: bytes.toString('base64') })
    })
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index * 4))
    const accepted = await postBody(`${origin}/bytes`, { 'Transfer-Encoding': 'chunked' }, (req) => {
      req.write(bytes.subarray(0, 32))
      req.end(bytes.subarray(32))
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(accepted.body, { data: bytes.toString('base64') })
    const rejected = await postBody(`${origin}/bytes`, { 'Transfer-Encoding': 'chunked' }, (req) => {
      req.write(bytes.subarray(0, 32))
      req.write(bytes.subarray(32))
      req.write(Buffer.from([255]))
    })
    assert.equal(rejected.status, 413)
    assert.deepEqual(rejected.body, { error: 'request body too large' })
  }, 64)
})

test('oversized helper bodies close keep-alive connections without waiting for EOF', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/json', async (route) => route.send(200, await route.json()))
    ctx.http.route('POST', '/bytes', async (route) => route.send(200, { length: (await route.bytes()).length }))
    for (const path of ['/json', '/bytes']) {
      const declared = await unfinishedRequest(origin, path, { 'Content-Length': '65' })
      assertClosedResponse(declared, 413, { error: 'request body too large' })
      const chunked = await unfinishedRequest(origin, path, { 'Transfer-Encoding': 'chunked' }, `41\r\n${'x'.repeat(65)}\r\n`)
      assertClosedResponse(chunked, 413, { error: 'request body too large' })
    }
  }, 64)
})

test('raw request rejection closes keep-alive connections after delivering the error', async () => {
  await withBodyServer(async (ctx, origin) => {
    for (const status of [400, 401, 403, 404, 500]) {
      ctx.http.route('POST', `/reject-${status}`, (route) => route.send(status, { error: 'rejected' }))
      const response = await unfinishedRequest(origin, `/reject-${status}`, { 'Transfer-Encoding': 'chunked' }, '1\r\nx\r\n')
      assertClosedResponse(response, status, { error: 'rejected' })
    }
  })
})

test('completed request bodies retain keep-alive for successful and invalid JSON responses', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/json', async (route) => route.send(200, await route.json()))
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    let previousSocket: Socket | null = null
    try {
      for (const [payload, status] of [['{"ok":true}', 200], ['{broken', 400], ['""', 200]] as const) {
        await new Promise<void>((resolve, reject) => {
          const req = request(`${origin}/json`, { method: 'POST', agent, headers: { 'Content-Length': String(Buffer.byteLength(payload)) } }, (res) => {
            const socket = res.socket
            res.resume()
            res.once('error', reject)
            res.once('end', () => {
              try {
                assert.equal(res.statusCode, status)
                assert.equal(res.headers.connection, 'keep-alive')
                if (previousSocket) assert.strictEqual(socket, previousSocket)
                previousSocket = socket
                resolve()
              } catch (error) { reject(error) }
            })
          })
          req.once('error', reject)
          req.end(payload)
        })
      }
    } finally { agent.destroy() }
  }, 64)
})

test('raw request readers and streaming responses are not subject to helper limits', async () => {
  await withBodyServer(async (ctx, origin) => {
    ctx.http.route('POST', '/raw', async (route) => {
      let length = 0
      for await (const chunk of route.req) length += chunk.length
      route.res.writeHead(200, { 'content-type': 'text/event-stream' })
      route.res.write(`data: ${length}\n\n`)
      route.res.end()
    })
    const response = await fetch(`${origin}/raw`, { method: 'POST', body: Buffer.alloc(256) })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'data: 256\n\n')
  }, 64)
})

test('invalid body limits cannot disable request bounds', () => {
  for (const bodyLimitBytes of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => http.apply(new Context(), { bodyLimitBytes }), /positive safe integer/)
  }
})

test('port zero reports the actual bound port', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cordis-http-dynamic-'))
  const publicDir = join(base, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'index.html'), '<html>dynamic</html>')
  const ctx = new Context()
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
  const fiber = await ctx.plugin(http, { port: 0, host: '127.0.0.1', publicDir, sharePort: 0 })
  try {
    const port = await ready
    assert.ok(port > 0)
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /dynamic/)
  } finally {
    await fiber.dispose()
  }
})

test('sharing can reuse the authenticated workstation listener', async () => {
  const previous = process.env.SHARE_PORT
  const port = await freePort()
  const ctx = new Context()
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port: actual }) => resolve(actual)))
  const shareReady = new Promise<number>((resolve) => ctx.on('http/share-ready', ({ port: actual }) => resolve(actual)))
  const fiber = await ctx.plugin(http, { port, host: '127.0.0.1', sharePort: port })
  try {
    const [actual, share] = await Promise.all([ready, shareReady])
    assert.equal(actual, port)
    assert.equal(share, port)
    assert.equal(process.env.SHARE_PORT, String(port))
  } finally {
    await fiber.dispose()
    if (previous === undefined) delete process.env.SHARE_PORT
    else process.env.SHARE_PORT = previous
  }
})

test('occupied requested port falls back when enabled', async () => {
  const blocker = createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => resolve())
  })
  const address = blocker.address()
  assert.ok(address && typeof address !== 'string')
  const ctx = new Context()
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
  const fiber = await ctx.plugin(http, {
    port: address.port,
    host: '127.0.0.1',
    fallbackPort: true,
    sharePort: 0,
  })
  try {
    const port = await ready
    assert.notEqual(port, address.port)
    assert.ok(port > 0)
  } finally {
    await fiber.dispose()
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())))
  }
})

test('an occupied extra share port is not opened', async () => {
  const blocker = createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => resolve())
  })
  const address = blocker.address()
  assert.ok(address && typeof address !== 'string')
  const ctx = new Context()
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
  const fiber = await ctx.plugin(http, {
    port: 0,
    host: '127.0.0.1',
    fallbackPort: false,
    sharePort: address.port,
    shareHost: '127.0.0.1',
  })
  try {
    const port = await ready
    assert.notEqual(port, address.port)
    assert.ok(port > 0)
    const held = blocker.address()
    assert.ok(held && typeof held !== 'string' && held.port === address.port)
  } finally {
    await fiber.dispose()
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())))
  }
})

test('extra ws path does not abort the hub /ws handshake', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cordis-http-ws-'))
  const publicDir = join(base, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'index.html'), '<html></html>')
  const port = await freePort()
  const ctx = new Context()
  const ready = new Promise<void>((resolve) => {
    ctx.on('http/ready', () => resolve())
  })
  const fiber = await ctx.plugin(http, { port, host: '127.0.0.1', publicDir })
  await ready
  try {
    ctx.http.ws('/ws/plugin-extra', (socket) => {
      socket.send('pty')
    })

    const hub = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('message', (raw) => {
        resolve(String(raw))
        ws.close()
      })
      ws.on('error', reject)
    })
    assert.match(hub, /"type":"hello"/)

    const extra = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/plugin-extra`)
      ws.on('message', (raw) => {
        resolve(String(raw))
        ws.close()
      })
      ws.on('error', reject)
    })
    assert.equal(extra, 'pty')
  } finally {
    await fiber.dispose()
  }
})

test('share routes stay on the workstation port', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cordis-http-share-'))
  const publicDir = join(base, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'index.html'), '<html>app</html>')
  const port = await freePort()
  const unused = await freePort()
  const ctx = new Context()
  const ready = new Promise<void>((resolve) => {
    ctx.on('http/ready', () => resolve())
  })
  const fiber = await ctx.plugin(http, { port, host: '127.0.0.1', publicDir, sharePort: unused, shareHost: '127.0.0.1' })
  await ready
  ctx.http.route('GET', '/api/db/list', (route) => {
    route.send(200, { leaked: true })
  })
  ctx.http.route('GET', '/api/share/:token', (route) => {
    route.send(200, { token: route.params.token })
  })
  try {
    const share = await fetch(`http://127.0.0.1:${port}/api/share/abc`)
    assert.equal(share.status, 200)
    assert.equal((await share.json()).token, 'abc')
    const local = await fetch(`http://127.0.0.1:${port}/api/db/list`)
    assert.equal(local.status, 200)
    const extra = await fetch(`http://127.0.0.1:${unused}/api/share/abc`).catch((error: Error) => error)
    assert.ok(extra instanceof Error)
  } finally {
    await fiber.dispose()
  }
})

test('workspace sockets only receive their own tenant events', () => {
  const ada = { workspaceId: 'ws_a', accountId: 'ada' }
  assert.equal(deliverTenantEvent(ada, 'database', { workspaceId: 'ws_a' }), true)
  assert.equal(deliverTenantEvent(ada, 'database', { workspaceId: 'ws_a', accountId: 'bob' }), true)
  assert.equal(deliverTenantEvent(ada, 'database', { workspaceId: 'ws_b' }), false)
  assert.equal(deliverTenantEvent(ada, 'session', { workspaceId: 'ws_a', accountId: 'bob' }), false)
  assert.equal(deliverTenantEvent(ada, 'session', { workspaceId: 'ws_a', accountId: 'ada' }), true)
  assert.equal(deliverTenantEvent(ada, 'session'), false)
  assert.equal(deliverTenantEvent({}, 'database', { workspaceId: 'ws_b' }), true)
  assert.equal(deliverTenantEvent(ada, 'clock', { workspaceId: 'ws_b' }), true)
})

test('online HTTP and WebSocket enforce account and workspace boundaries', async () => {
  const previous = process.env.BIU_ONLINE
  process.env.BIU_ONLINE = '1'
  const base = await mkdtemp(join(tmpdir(), 'cordis-http-tenant-'))
  const publicDir = join(base, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'index.html'), '<html></html>')
  const memberships = new Set(['ada:ws-a', 'bob:ws-b'])
  const validTokens = new Set(['ada-token', 'bob-token'])
  const ctx = new Context()
  class FakeAccount extends Service {
    store = {
      accountByToken: (token: string) =>
        validTokens.has(token) ? token === 'ada-token' ? { id: 'ada' } : { id: 'bob' } : null,
      isMember: (accountId: string, workspaceId: string) => memberships.has(`${accountId}:${workspaceId}`),
      activeWorkspaceId: () => (currentAccountId() === 'ada' ? 'ws-a' : null),
      tenantForRecord: (_collection: string, recordId: string) =>
        recordId === 'session-a' ? { workspaceId: 'ws-a', accountId: 'ada' } : null,
    }
    constructor(inner: Context) {
      super(inner, 'account')
    }
  }
  const ready = new Promise<number>((resolve) => ctx.on('http/ready', ({ port }) => resolve(port)))
  await ctx.plugin(FakeAccount)
  const fiber = await ctx.plugin(http, { port: 0, host: '127.0.0.1', publicDir, sharePort: 0 })
  const port = await ready
  ctx.http.route('GET', '/api/db/list', (route) => route.send(200, { ok: true }))
  ctx.http.route('GET', '/api/account/me', (route) => route.send(200, { id: 'ada' }))
  ctx.http.ws('/ws/plugin-extra', (socket) => socket.send('secured'))
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/db/list`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/db/list`, { headers: { Authorization: 'Bearer ada-token' } })).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/db/list`, { headers: { Authorization: 'Bearer bob-token' } })).status, 400)
    // 浏览器缓存着已删除 / 无权访问的 workspaceId 时，回退到账号活动空间，
    // 否则工作区列表接口本身也会 403，用户无法切回有效空间。
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/db/list`, {
          headers: { Authorization: 'Bearer ada-token', 'X-Biu-Workspace-Id': 'ws-b' },
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/account/me`, {
          headers: { Authorization: 'Bearer ada-token', 'X-Biu-Workspace-Id': 'ws-missing' },
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/db/list`, {
          headers: { Authorization: 'Bearer ada-token', 'X-Biu-Workspace-Id': 'ws-a' },
        })
      ).status,
      200,
    )
    const unauthenticatedWs = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/plugin-extra`)
      socket.once('close', (code) => resolve(code))
    })
    assert.equal(unauthenticatedWs, 4401)
    const securedWs = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/plugin-extra?workspaceId=ws-a`, {
        headers: { Cookie: 'biu_account=ada-token' },
      })
      socket.once('message', (raw) => {
        resolve(String(raw))
        socket.close()
      })
      socket.once('error', reject)
    })
    assert.equal(securedWs, 'secured')
    const previewWs = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/plugin-extra?landingPreview=1&workspaceId=ws-a`, {
        headers: { Cookie: 'biu_account=ada-token' },
      })
      socket.once('close', (code) => resolve(code))
    })
    assert.equal(previewWs, 4401)
    const legacyWs = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspaceId=ws-a`, {
        headers: { Cookie: 'biu_legacy_account=ada-token' },
      })
      socket.once('message', () => resolve(socket))
      socket.once('error', reject)
    })
    legacyWs.close()

    const connect = (token: string, workspaceId: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspaceId=${workspaceId}`, {
          headers: { Cookie: `biu_account=${token}` },
        })
        socket.once('message', () => resolve(socket))
        socket.once('error', reject)
      })
    const [ada, bob] = await Promise.all([connect('ada-token', 'ws-a'), connect('bob-token', 'ws-b')])
    const inferredSessionMessage = new Promise<string>((resolve) => ada.once('message', (raw) => resolve(String(raw))))
    ctx.http.broadcast('session', { sessionId: 'session-a', event: { type: 'done' } })
    assert.match(await inferredSessionMessage, /"session-a"/)
    const inferredAgentMessage = new Promise<string>((resolve) => ada.once('message', (raw) => resolve(String(raw))))
    ctx.http.broadcast('agent', { sessionId: 'session-a', status: 'running' })
    assert.match(await inferredAgentMessage, /"running"/)
    const inferredInboxMessage = new Promise<string>((resolve) => ada.once('message', (raw) => resolve(String(raw))))
    ctx.http.broadcast('inbox', { sessionId: 'session-a', inbox: [] })
    assert.match(await inferredInboxMessage, /"inbox"/)
    const adaMessage = new Promise<string>((resolve) => ada.once('message', (raw) => resolve(String(raw))))
    let bobReceived = false
    bob.once('message', () => {
      bobReceived = true
    })
    ctx.http.broadcast('database', { changed: true }, 'ws-a')
    assert.match(await adaMessage, /"changed":true/)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(bobReceived, false)
    const bobAccountMessage = new Promise<string>((resolve) => bob.once('message', (raw) => resolve(String(raw))))
    ctx.http.broadcastAccount('bob', 'inbox', { accountOnly: true })
    assert.match(await bobAccountMessage, /"accountOnly":true/)
    const bobClosed = new Promise<number>((resolve) => bob.once('close', (code) => resolve(code)))
    validTokens.delete('bob-token')
    ctx.http.disconnectRevokedSessions('bob')
    assert.equal(await bobClosed, 4401)
    const closed = new Promise<number>((resolve) => ada.once('close', (code) => resolve(code)))
    memberships.delete('ada:ws-a')
    ctx.http.disconnectTenant('ada', 'ws-a')
    assert.equal(await closed, 4403)
  } finally {
    await fiber.dispose()
    if (previous === undefined) delete process.env.BIU_ONLINE
    else process.env.BIU_ONLINE = previous
  }
})

test('host prefers dist after vite build unless BIU_PUBLIC_DIR is set', () => {
  const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
  assert.match(src, /BIU_PUBLIC_DIR/)
  assert.match(src, /existsSync\(join\(dist, 'index.html'\)\)/)
})

test('index html is painted with the profile theme', () => {
  const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
  assert.match(src, /paintDocumentTheme/)
  assert.match(src, /profilePath\(\)/)
  assert.match(http.paintDocumentTheme('<html class="light" data-theme-source="static"><meta name="color-scheme" content="light">', 'dark'), /class="dark" data-theme-source="server"/)
})
