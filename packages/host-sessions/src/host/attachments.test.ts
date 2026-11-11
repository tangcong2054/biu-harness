/** @vitest-environment node */
import assert from 'node:assert/strict'
import { cp, mkdtemp, open, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { artifactsDir, readArtifactFile, resolveArtifactFile } from './artifacts.ts'
import {
  AttachmentError, MAX_ATTACHMENT_BYTES, cloneSessionAttachments, getSessionFile,
  persistLegacyMessageImages, readSessionFileText, resolveSessionFiles, uploadSessionFile,
} from './attachments.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'biu-attachments-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const stream = (data: string | Buffer) => Readable.from([Buffer.from(data)])

test('uploads bytes with safe unique identifiers, original labels and paginated text', () => fixture(async (baseDir) => {
  const file = await uploadSessionFile('s1', '../../说明.txt', stream('hello world'), { baseDir })
  assert.equal(file.name, '说明.txt')
  assert.equal(file.size, 11)
  assert.equal(file.mime, 'application/octet-stream')
  assert.equal(file.url, `/api/sessions/s1/artifacts/${file.id}`)
  assert.deepEqual(await getSessionFile('s1', file.id, baseDir), file)
  assert.equal((await readSessionFileText('s1', file.id, 0, 5, baseDir)).text, 'hello')
  assert.equal((await readSessionFileText('s1', file.id, 5, 32, baseDir)).text, ' world')
  const other = await uploadSessionFile('s1', file.name, stream('hello world'), { baseDir })
  assert.notEqual(other.id, file.id)
}))

test('sniffs images rather than trusting extensions and never stores data URLs in metadata', () => fixture(async (baseDir) => {
  const image = await uploadSessionFile('s1', 'hello.txt', stream(PNG), { baseDir })
  assert.equal(image.mime, 'image/png')
  assert.match(image.id, /\.png$/)
  assert.ok(!JSON.stringify(image).includes('base64'))
  const fake = await uploadSessionFile('s1', 'fake.png', stream('<script>bad()</script>'), { baseDir })
  assert.equal(fake.mime, 'application/octet-stream')
}))

test('rejects oversize declared and chunked uploads and cleans partial files', () => fixture(async (baseDir) => {
  await assert.rejects(uploadSessionFile('s1', 'huge.txt', stream('a'), { baseDir, contentLength: MAX_ATTACHMENT_BYTES + 1 }), (error: unknown) => error instanceof AttachmentError && error.status === 413)
  const chunks = Readable.from((function* () { for (let i = 0; i < 21; i++) yield Buffer.alloc(1024 * 1024) })())
  await assert.rejects(uploadSessionFile('s1', 'huge.txt', chunks, { baseDir }), /20 MiB/)
  assert.deepEqual(await readdir(artifactsDir('s1', baseDir)), ['_meta'])
  const exact = await uploadSessionFile('s1', 'exact.bin', stream(Buffer.alloc(MAX_ATTACHMENT_BYTES)), { baseDir })
  assert.equal(exact.size, MAX_ATTACHMENT_BYTES)
}))

test('cleans failed and truncated uploads', () => fixture(async (baseDir) => {
  const broken = Readable.from((async function* () { yield Buffer.from('part'); throw new Error('disconnected') })())
  await assert.rejects(uploadSessionFile('s1', 'broken', broken, { baseDir }), /disconnected/)
  await assert.rejects(uploadSessionFile('s1', 'truncated', stream('a'), { baseDir, contentLength: 2 }), /不完整/)
  assert.deepEqual(await readdir(artifactsDir('s1', baseDir)), ['_meta'])
}))

test('reference resolution rejects cross-session IDs, URL and excessive counts', () => fixture(async (baseDir) => {
  const file = await uploadSessionFile('s1', 'data.json', stream('{}'), { baseDir })
  await uploadSessionFile('s2', 'data.json', stream('{}'), { baseDir })
  await assert.rejects(resolveSessionFiles('s2', [file.id], baseDir), /不属于此会话/)
  await assert.rejects(resolveSessionFiles('s1', [file.url], baseDir), /无效/)
  await assert.rejects(resolveSessionFiles('s1', Array(7).fill(file.id), baseDir), /6/)
  assert.equal((await resolveSessionFiles('s1', [file.id], baseDir)).length, 1)
}))

test('safe resolver rejects session traversal and symlink files or directories', () => fixture(async (baseDir) => {
  assert.equal(resolveArtifactFile('../outside', 'file.txt', baseDir), null)
  const file = await uploadSessionFile('s1', 'hello.txt', stream('hello'), { baseDir })
  const external = join(baseDir, 'external.txt')
  await writeFile(external, 'secret')
  await rm(join(artifactsDir('s1', baseDir), file.id))
  await symlink(external, join(artifactsDir('s1', baseDir), file.id))
  assert.equal(await readArtifactFile('s1', file.id, baseDir), null)
  await assert.rejects(getSessionFile('s1', file.id, baseDir), /不存在/)
  await symlink(artifactsDir('s1', baseDir), artifactsDir('s2', baseDir))
  assert.equal(await readArtifactFile('s2', file.id, baseDir), null)
  await assert.rejects(uploadSessionFile('s2', 'bad.txt', stream('bad'), { baseDir }), /directory/)
}))

test('legacy POST images convert to references and fork copies attachments without cross-session access', () => fixture(async (baseDir) => {
  const [image] = await persistLegacyMessageImages('s1', [{ name: 'old.png', url: `data:image/png;base64,${PNG.toString('base64')}` }], baseDir)
  assert.ok(image)
  assert.ok(!image.url.includes('base64'))
  const file = await uploadSessionFile('s1', 'note.txt', stream('note'), { baseDir })
  const events = [{ type: 'user/message', text: 'inspect', images: [image], files: [file] }]
  const fork = await cloneSessionAttachments('s1', 's2', events, baseDir)
  assert.equal(events[0]!.images[0]!.url, image.url)
  assert.ok(fork[0]!.images[0]!.url.startsWith('/api/sessions/s2/'))
  assert.equal(fork[0]!.images[0]!.id, image.id)
  assert.equal(fork[0]!.files[0]!.id, file.id)
  assert.equal((await readSessionFileText('s2', fork[0]!.files[0]!.id, 0, 32, baseDir)).text, 'note')
  assert.deepEqual((await readArtifactFile('s2', fork[0]!.images[0]!.id, baseDir))?.data, PNG)
}))

test('binary files are not decoded as text and read ranges are bounded', () => fixture(async (baseDir) => {
  const file = await uploadSessionFile('s1', 'book.pdf', stream('%PDF-example'), { baseDir })
  assert.equal((await readSessionFileText('s1', file.id, 0, 32, baseDir)).binary, true)
  await assert.rejects(readSessionFileText('s1', file.id, -1, 32, baseDir), /offset/)
  await assert.rejects(readSessionFileText('s1', file.id, 0, 65537, baseDir), /limit/)
}))

test('UTF-8 pagination retains complete characters and supports extensionless files', () => fixture(async (baseDir) => {
  const file = await uploadSessionFile('s1', 'README', stream('你好世界'), { baseDir })
  const first = await readSessionFileText('s1', file.id, 0, 5, baseDir)
  assert.equal(first.text, '你')
  assert.equal(first.nextOffset, 3)
  const next = await readSessionFileText('s1', file.id, first.nextOffset, 32, baseDir)
  assert.equal(next.text, '好世界')
  const invalid = await uploadSessionFile('s1', 'raw', stream(Buffer.from([255, 254, 253])), { baseDir })
  assert.equal((await readSessionFileText('s1', invalid.id, 0, 32, baseDir)).binary, true)
}))

test('enforces session storage and file-count quotas including abandoned uploads', () => fixture(async (baseDir) => {
  await uploadSessionFile('s1', 'empty', stream(''), { baseDir })
  const dir = artifactsDir('s1', baseDir)
  const sparse = await open(join(dir, 'old.bin'), 'wx')
  await sparse.truncate(200 * 1024 * 1024)
  await sparse.close()
  await assert.rejects(uploadSessionFile('s1', 'over', stream('a'), { baseDir }), /200 MiB/)
  await rm(join(dir, 'old.bin'))
  await Promise.all(Array.from({ length: 255 }, (_, index) => writeFile(join(dir, `empty-${index}`), '')))
  await assert.rejects(uploadSessionFile('s1', 'over', stream(''), { baseDir }), /数量/)
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.part')).length, 0)
}))

test('legacy image batches validate fully before writing and roll back a quota failure', () => fixture(async (baseDir) => {
  const valid = { name: 'old.png', url: `data:image/png;base64,${PNG.toString('base64')}` }
  await assert.rejects(persistLegacyMessageImages('s1', [valid, { url: 'data:image/png;base64,AAAA' }], baseDir), /图片内容/)
  await assert.rejects(readdir(artifactsDir('s1', baseDir)), { code: 'ENOENT' })
  const original = await uploadSessionFile('s1', 'keep.txt', stream('keep'), { baseDir })
  const dir = artifactsDir('s1', baseDir)
  await Promise.all(Array.from({ length: 254 }, (_, index) => writeFile(join(dir, `existing-${index}`), '')))
  const before = (await readdir(dir)).sort()
  await assert.rejects(persistLegacyMessageImages('s1', [valid, valid], baseDir), /数量/)
  assert.deepEqual((await readdir(dir)).sort(), before)
  assert.deepEqual(await readdir(join(dir, '_meta')), [`${original.id}.json`])
  assert.equal((await readSessionFileText('s1', original.id, 0, 32, baseDir)).text, 'keep')
}))

test('desktop and cloud forks keep identical attachment references', () => fixture(async (baseDir) => {
  const cloud = join(baseDir, 'cloud')
  const desktop = join(baseDir, 'desktop')
  const file = await uploadSessionFile('source', 'README', stream('original'), { baseDir: cloud })
  await cp(artifactsDir('source', cloud), artifactsDir('source', desktop), { recursive: true })
  const events = [{ type: 'user/message', text: '', files: [file] }]
  const cloudFork = await cloneSessionAttachments('source', 'child', events, cloud)
  const localFork = await cloneSessionAttachments('source', 'child', events, desktop)
  assert.deepEqual(localFork, cloudFork)
  assert.equal(localFork[0]!.files[0]!.id, file.id)
  for (const root of [cloud, desktop]) {
    await rm(artifactsDir('source', root), { recursive: true })
    assert.equal((await readSessionFileText('child', file.id, 0, 32, root)).text, 'original')
  }
}))

test('fork failure rolls back new copies without overwriting existing target files', () => fixture(async (baseDir) => {
  const first = await uploadSessionFile('source', 'first.txt', stream('first'), { baseDir })
  const second = await uploadSessionFile('source', 'second.txt', stream('second'), { baseDir })
  const firstEvent = { type: 'user/message', files: [first] }
  const secondEvent = { type: 'user/message', files: [second] }
  await cloneSessionAttachments('source', 'child', [secondEvent], baseDir)
  await assert.rejects(cloneSessionAttachments('source', 'child', [firstEvent, secondEvent], baseDir), { code: 'EEXIST' })
  await assert.rejects(getSessionFile('child', first.id, baseDir), /不存在/)
  assert.equal((await readSessionFileText('child', second.id, 0, 32, baseDir)).text, 'second')
  assert.deepEqual((await readdir(artifactsDir('child', baseDir))).sort(), ['_meta', second.id].sort())
}))
