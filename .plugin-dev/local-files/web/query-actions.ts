import type { FsRoot } from './fs.ts'
import { listTree, searchFiles, searchContent, readFiles, readRange } from './file-query.ts'

export function fileQueryActions(requireRoot: (args: Record<string, unknown>) => FsRoot) {
  const properties = {
    rootId: { type: 'string', description: 'list_roots 返回的 rootId' },
    path: { type: 'string', description: '相对根路径；目录查询为空串表示根目录' },
    maxEntries: { type: 'number', description: '最大遍历条数，默认 1000，最大 5000' },
    maxDepth: { type: 'number', description: '最大目录深度，默认 8，最大 32' },
  }
  const action = (description: string, extra: Record<string, unknown>, required: string[], run: (root: FsRoot, args: Record<string, unknown>) => Promise<unknown>) => ({
    description,
    risk: 'read',
    inputSchema: { type: 'object', properties: { ...properties, ...extra }, required, additionalProperties: false },
    run: (args: Record<string, unknown>) => run(requireRoot(args), args),
  })
  const search = {
    query: { type: 'string', description: '字面量搜索词，不执行正则表达式' },
    caseSensitive: { type: 'boolean' },
    limit: { type: 'number', description: '最大结果数，默认 100，最大 500' },
  }
  return {
    list_tree: action('递归列出本地目录树，跳过 node_modules/.git 等；优先用它定位文件', {}, [], listTree),
    search_files: action('按相对路径的子串搜索文件名', search, ['query'], searchFiles),
    search_content: action('搜索本地文本内容，返回路径、行号和上下文；跳过二进制和超过 5MB 的文件，总扫描最多 20MB', {
      ...search, context: { type: 'number', description: '前后上下文行数，默认 2，最大 5' },
    }, ['query'], searchContent),
    read_files: action('一次批量读取 1～20 个本地文本文件；默认总内容 200KB，最大 1MB；返回磁盘或只读副本，不含未保存编辑', {
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      maxBytes: { type: 'number' },
    }, ['paths'], readFiles),
    read_range: action('按 1 起始的行号读取本地文本；默认 200 行、100KB，输出最大 1MB，扫描最大 32MB；不含未保存编辑', {
      startLine: { type: 'number' }, endLine: { type: 'number' }, maxBytes: { type: 'number' },
    }, ['path'], readRange),
  }
}
