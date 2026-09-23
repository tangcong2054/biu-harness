const MAX_SQL_LENGTH = 50_000
const FORBIDDEN_SQL_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'RENAME', 'GRANT', 'REVOKE', 'SET', 'CALL', 'DO', 'HANDLER', 'LOAD', 'LOCK',
  'UNLOCK', 'FLUSH', 'RESET', 'KILL', 'SHUTDOWN', 'INSTALL', 'UNINSTALL',
  'ANALYZE', 'OPTIMIZE', 'REPAIR', 'START', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'XA', 'IMPORT',
])
const FORBIDDEN_SELECT_PATTERNS = [
  [/\bINTO\s+(?:OUTFILE|DUMPFILE|@)/i, 'SELECT INTO'],
  [/\bFOR\s+UPDATE\b/i, 'FOR UPDATE'],
  [/\bLOCK\s+IN\s+SHARE\s+MODE\b/i, 'LOCK IN SHARE MODE'],
  [/\b(?:GET_LOCK|RELEASE_LOCK|IS_FREE_LOCK|IS_USED_LOCK)\s*\(/i, '命名锁函数'],
  [/\b(?:SLEEP|BENCHMARK)\s*\(/i, '耗时函数'],
  [/\bLOAD_FILE\s*\(/i, 'LOAD_FILE'],
]

function stripQuotedAndComments(sql) {
  let out = ''
  let quote = ''
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (quote) {
      if (ch === '\\') {
        out += '  '
        i += 1
        continue
      }
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += '  '
          i += 1
          continue
        }
        quote = ''
      }
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ' '
      continue
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? '')) {
      while (i < sql.length && sql[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return { text: out, error: 'SQL 块注释没有结束' }
      out += ' '.repeat(end + 2 - i)
      i = end + 1
      continue
    }
    out += ch
  }
  return quote ? { text: out, error: 'SQL 字符串或标识符没有结束' } : { text: out, error: '' }
}

export function validateReadOnlySql(input) {
  const sql = String(input ?? '').trim()
  if (!sql) return { ok: false, error: '请输入 SQL' }
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, error: `SQL 最长 ${MAX_SQL_LENGTH} 字符` }
  if (/(^|\n)\s*\\[!.]/.test(sql) || /(^|\n)\s*(?:system|source)\b/i.test(sql)) {
    return { ok: false, error: '拒绝 MySQL 客户端命令' }
  }
  // MySQL 会执行 /*! ... */ 中的内容，不能按普通注释剥离，否则可绕过写关键字检查。
  if (/\/\*!/.test(sql)) return { ok: false, error: '拒绝 MySQL 可执行注释 /*! ... */' }
  const stripped = stripQuotedAndComments(sql)
  if (stripped.error) return { ok: false, error: stripped.error }
  let structural = stripped.text.trim()
  if (structural.endsWith(';')) structural = structural.slice(0, -1).trim()
  if (structural.includes(';')) return { ok: false, error: '一次只能执行一条 SQL' }
  const tokens = structural.toUpperCase().match(/[A-Z_]+/g) ?? []
  const first = tokens[0] ?? ''
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'].includes(first)) {
    return { ok: false, error: `只允许 SELECT / SHOW / DESCRIBE / EXPLAIN，收到 ${first || '空语句'}` }
  }
  if (first === 'EXPLAIN' && tokens[1] !== 'SELECT' && tokens[1] !== 'WITH') {
    return { ok: false, error: 'EXPLAIN 只允许分析 SELECT' }
  }
  const forbidden = tokens.find((token) => FORBIDDEN_SQL_WORDS.has(token))
  if (forbidden) return { ok: false, error: `检测到写操作或管理关键字 ${forbidden}，已拒绝` }
  if (first === 'WITH' && !tokens.includes('SELECT')) return { ok: false, error: 'WITH 必须返回只读 SELECT' }
  for (const [pattern, label] of FORBIDDEN_SELECT_PATTERNS) {
    if (pattern.test(structural)) return { ok: false, error: `${label} 不属于安全只读查询，已拒绝` }
  }
  return { ok: true, sql: sql.replace(/;\s*$/, '') }
}
