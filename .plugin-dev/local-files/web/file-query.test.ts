// @vitest-environment node
import { expect, test } from 'vitest'
import { SnapshotRoot } from './fs.ts'
import { listTree, searchFiles, searchContent, readFiles, readRange } from './file-query.ts'
import { fileQueryActions } from './query-actions.ts'

function root() {
  return new SnapshotRoot('r', 'project', 'directory', [
    { path: 'docs/a.md', file: new File(['# Hello\r\n中文 target\r\nlast'], 'a.md') },
    { path: 'src/app.ts', file: new File(['const target = 1;\nend'], 'app.ts') },
    { path: 'node_modules/hidden.js', file: new File(['target'], 'hidden.js') },
    { path: 'data.bin', file: new File([new Uint8Array([0, 1])], 'data.bin') },
  ])
}

test('tree skips ignored folders and exposes traversal bounds', async () => {
  const tree = await listTree(root(), {})
  expect(tree.entries.some((entry) => entry.path.startsWith('node_modules'))).toBe(false)
  expect(tree.entries.some((entry) => entry.path === 'docs/a.md')).toBe(true)
  expect((await listTree(root(), { maxEntries: 1 })).truncated).toBe(true)
  expect((await listTree(root(), { maxDepth: 1 })).truncated).toBe(true)
  await expect(listTree(root(), { path: '../secret' })).rejects.toThrow('非法路径')
})

test('file search matches paths case-insensitively and limits results', async () => {
  expect((await searchFiles(root(), { query: 'APP.TS' })).matches.map((entry) => entry.path)).toEqual(['src/app.ts'])
  expect((await searchFiles(root(), { query: '.md', caseSensitive: true })).matches).toHaveLength(1)
  await expect(searchFiles(root(), { query: '' })).rejects.toThrow('搜索词')
})

test('content search returns line numbers, context and skips binary', async () => {
  const result = await searchContent(root(), { query: 'TARGET', context: 1 })
  expect(result.matches.map((match) => [match.path, match.line])).toEqual([['docs/a.md', 2], ['src/app.ts', 1]])
  expect(result.matches[0].context[0]).toEqual({ line: 1, text: '# Hello' })
  expect(result.skipped.some((item) => item.path === 'data.bin')).toBe(true)
  expect((await searchContent(root(), { query: 'target', limit: 1 })).truncated).toBe(true)
  expect((await searchContent(root(), { query: '.*' })).matches).toEqual([])
})

test('read range streams requested lines and handles EOF and invalid ranges', async () => {
  const result = await readRange(root(), { path: 'docs/a.md', startLine: 2, endLine: 3 })
  expect(result.lines).toEqual([{ line: 2, text: '中文 target' }, { line: 3, text: 'last' }])
  expect(result.truncated).toBe(false)
  expect((await readRange(root(), { path: 'docs/a.md', startLine: 20 })).lines).toEqual([])
  expect((await readRange(root(), { path: 'docs/a.md', maxBytes: 2 })).truncated).toBe(true)
  await expect(readRange(root(), { path: 'docs/a.md', startLine: 3, endLine: 2 })).rejects.toThrow('endLine')
  await expect(readRange(root(), { path: 'data.bin' })).rejects.toThrow('二进制')
})

test('batch read bounds total content and isolates missing/binary files', async () => {
  const result = await readFiles(root(), { paths: ['docs/a.md', 'missing', 'data.bin'] })
  expect(result.files[0].text).toContain('中文')
  expect(result.files[1].error).toBeDefined()
  expect(result.files[2].skipped).toBe('二进制文件')
  const bounded = await readFiles(root(), { paths: ['docs/a.md', 'src/app.ts'], maxBytes: 3 })
  expect(bounded.bytes).toBeLessThanOrEqual(3)
  expect(bounded.files[1].skipped).toBeDefined()
  await expect(readFiles(root(), { paths: Array(21).fill('a') })).rejects.toThrow('1～20')
})

test('query actions are discoverable read actions and use the supplied authorized root resolver', async () => {
  const actions = fileQueryActions(() => root())
  expect(Object.keys(actions)).toEqual(['list_tree', 'search_files', 'search_content', 'read_files', 'read_range'])
  for (const action of Object.values(actions)) expect(action.risk).toBe('read')
  const result = await actions.search_files.run({ query: 'app' }) as { matches: unknown[] }
  expect(result.matches).toHaveLength(1)
})
