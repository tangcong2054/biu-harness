const React = globalThis.React
const { useEffect, useMemo, useRef, useState } = React

export const name = 'calc-block'
export const inject = ['pageEditor', 'uiActions']

type UiActionsApi = { register: (spec: Record<string, unknown>) => () => void }
let uiActions: UiActionsApi | undefined

/* ------------------------------------------------------------------ 表达式求值 */

export type AngleMode = 'deg' | 'rad'

const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2 }

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new Error('阶乘只支持非负整数')
  if (n > 170) return Infinity
  let out = 1
  for (let i = 2; i <= n; i += 1) out *= i
  return out
}

/** 括号不配对时自动补齐右括号，方便「sin(45」这类半成品直接求值。 */
export function balanceParens(src: string): string {
  let open = 0
  for (const ch of src) {
    if (ch === '(') open += 1
    else if (ch === ')') open = Math.max(0, open - 1)
  }
  return src + ')'.repeat(open)
}

const ID_START = /[a-zA-Z_]/
const ID_CHAR = /[a-zA-Z0-9_]/

/** 不带括号也能调用的函数名（√9、sin30 这种写法）。 */
const PREFIX_FNS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'ln', 'log', 'log2', 'log10', 'exp', 'sqrt', '√', 'cbrt', '∛', 'abs', 'sign',
  'floor', 'ceil', 'round', 'fact',
])

function tokenize(src: string): string[] {
  const s = src.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1
      out.push(s.slice(i, j))
      i = j
      continue
    }
    // π 与根号是单字符符号，单独成 token（否则 √9 会被吃成一个名字）。
    if (ch === 'π' || ch === '√' || ch === '∛') {
      out.push(ch)
      i += 1
      continue
    }
    if (ID_START.test(ch)) {
      let j = i + 1
      while (j < s.length && ID_CHAR.test(s[j])) j += 1
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if ('+-*/^%()!,'.includes(ch)) {
      out.push(ch)
      i += 1
      continue
    }
    throw new Error(`无法识别的字符「${ch}」`)
  }
  return out
}

function callFn(fname: string, args: number[], angle: AngleMode): number {
  const toRad = (x: number) => (angle === 'deg' ? (x * Math.PI) / 180 : x)
  const fromRad = (x: number) => (angle === 'deg' ? (x * 180) / Math.PI : x)
  const need = (n: number, max?: number) => {
    if (args.length < n) throw new Error(fname + '() 需要 ' + n + ' 个参数')
    if (max !== undefined && args.length > max) throw new Error(fname + '() 参数过多')
  }
  switch (fname) {
    case 'sin': need(1, 1); return Math.sin(toRad(args[0]))
    case 'cos': need(1, 1); return Math.cos(toRad(args[0]))
    case 'tan': need(1, 1); return Math.tan(toRad(args[0]))
    case 'asin': case 'arcsin': need(1, 1); return fromRad(Math.asin(args[0]))
    case 'acos': case 'arccos': need(1, 1); return fromRad(Math.acos(args[0]))
    case 'atan': case 'arctan': need(1, 1); return fromRad(Math.atan(args[0]))
    case 'sinh': need(1, 1); return Math.sinh(args[0])
    case 'cosh': need(1, 1); return Math.cosh(args[0])
    case 'tanh': need(1, 1); return Math.tanh(args[0])
    case 'ln': need(1, 1); return Math.log(args[0])
    case 'log': need(1, 2); return args.length === 2 ? Math.log(args[0]) / Math.log(args[1]) : Math.log10(args[0])
    case 'log2': need(1, 1); return Math.log2(args[0])
    case 'log10': need(1, 1); return Math.log10(args[0])
    case 'exp': need(1, 1); return Math.exp(args[0])
    case 'sqrt': case '√': need(1, 1); return Math.sqrt(args[0])
    case 'cbrt': case '∛': need(1, 1); return Math.cbrt(args[0])
    case 'abs': need(1, 1); return Math.abs(args[0])
    case 'sign': need(1, 1); return Math.sign(args[0])
    case 'floor': need(1, 1); return Math.floor(args[0])
    case 'ceil': need(1, 1); return Math.ceil(args[0])
    case 'round': need(1, 2)
      return args.length === 2
        ? Number(args[0].toFixed(Math.max(0, Math.min(15, Math.trunc(args[1])))))
        : Math.round(args[0])
    case 'min': need(1); return Math.min(...args)
    case 'max': need(1); return Math.max(...args)
    case 'mod': need(2, 2); return args[0] % args[1]
    case 'pow': need(2, 2); return Math.pow(args[0], args[1])
    case 'hypot': need(1); return Math.hypot(...args)
    case 'gcd': {
      need(2)
      const g = (a: number, b: number): number => (b === 0 ? Math.abs(a) : g(b, a % b))
      return args.map((x) => Math.trunc(x)).reduce((a, b) => g(a, b))
    }
    case 'fact': need(1, 1); return factorial(Math.trunc(args[0]))
    case 'avg': need(1); return args.reduce((a, b) => a + b, 0) / args.length
    case 'sum': need(1); return args.reduce((a, b) => a + b, 0)
    default: throw new Error('未知函数 ' + fname + '()')
  }
}

/**
 * 递归下降求值：+ - * / ^ % ! ( ) 常量 函数 变量（ans / m）。
 * `x%` 作为后缀百分比；二元 `a + b%` 按「b% 相对于 a」处理（和手机计算器一致）。
 */
export function evalExpr(input: string, angle: AngleMode = 'rad', vars: Record<string, number> = {}): number {
  const tokens = tokenize(balanceParens(input))
  let p = 0
  const peek = () => tokens[p]
  const eat = (t?: string) => {
    const cur = tokens[p]
    if (t !== undefined && cur !== t) throw new Error('这里应该是「' + t + '」')
    p += 1
    return cur
  }

  function expr(): number {
    let v = term()
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') break
      eat()
      const right = termWithPct()
      // 后缀百分比已在 termWithPct 里除过 100，这里只需按「相对于左边」折算。
      if (right.pct) v = op === '+' ? v + v * right.value : v - v * right.value
      else v = op === '+' ? v + right.value : v - right.value
    }
    return v
  }

  function termWithPct(): { value: number; pct: boolean } {
    let value = unary()
    let pct = false
    for (;;) {
      const op = peek()
      if (op === '*' || op === '/') {
        eat()
        const right = unary()
        value = op === '*' ? value * right : value / right
        pct = false
        continue
      }
      if (op === '%') {
        eat()
        value /= 100
        pct = true
        continue
      }
      break
    }
    return { value, pct }
  }

  function term(): number {
    return termWithPct().value
  }

  function unary(): number {
    if (peek() === '-') { eat(); return -unary() }
    if (peek() === '+') { eat(); return unary() }
    return power()
  }

  function power(): number {
    const base = postfix()
    if (peek() === '^') {
      eat()
      return Math.pow(base, unary())
    }
    return base
  }

  function postfix(): number {
    let v = primary()
    for (;;) {
      if (peek() === '!') { eat(); v = factorial(Math.trunc(v)); continue }
      break
    }
    return v
  }

  function primary(): number {
    const t = peek()
    if (t === undefined) throw new Error('表达式不完整')
    if (t === '(') {
      eat()
      const v = expr()
      if (peek() === ')') eat(')')
      return v
    }
    if (/^[0-9.]/.test(t)) {
      eat()
      const n = Number(t)
      if (!Number.isFinite(n)) throw new Error('数字「' + t + '」无效')
      return n
    }
    if (ID_START.test(t) || t === 'π' || t === '√' || t === '∛') {
      eat()
      const lower = t === '∛' ? 'cbrt' : t === '√' ? 'sqrt' : t.toLowerCase()
      if (PREFIX_FNS.has(lower) && peek() !== '(') {
        return callFn(lower, [unary()], angle)
      }
      if (peek() === '(') {
        eat()
        const args: number[] = []
        if (peek() !== ')') {
          for (;;) {
            args.push(expr())
            if (peek() === ',') { eat(); continue }
            break
          }
        }
        if (peek() === ')') eat(')')
        return callFn(lower, args, angle)
      }
      if (CONSTS[lower] !== undefined) return CONSTS[lower]
      if (vars[lower] !== undefined) return vars[lower]
      throw new Error('未知名称「' + t + '」')
    }
    throw new Error('无法解析「' + t + '」')
  }

  const out = expr()
  if (p < tokens.length) throw new Error('多余内容「' + tokens[p] + '」')
  return out
}

/* ------------------------------------------------------------------ 数字格式化 */

export function fmtNum(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e15 || abs < 1e-9) {
    return n.toExponential(9).replace(/\.?0+e/, 'e').replace('e+', 'e')
  }
  const rounded = Number(n.toPrecision(12))
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1e15) return String(rounded)
  return String(rounded)
}

function groupDigits(digits: string): string {
  const neg = digits.startsWith('-')
  const body = neg ? digits.slice(1) : digits
  const parts = body.split('.')
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + [grouped, ...parts.slice(1)].join('.')
}

export function fmtDisplay(n: number, grouping = true): string {
  const s = fmtNum(n)
  if (!grouping || s.includes('e') || s.includes('∞')) return s
  return groupDigits(s)
}

export function toBase(n: number, radix: number): string {
  if (!Number.isFinite(n)) return '—'
  const neg = n < 0
  const v = Math.trunc(Math.abs(n))
  return (neg ? '-' : '') + v.toString(radix).toUpperCase()
}

/* ------------------------------------------------------------------ 单位换算 */

type UnitDef = { label: string; factor: number }
type Category = { id: string; label: string; units: UnitDef[]; note?: string }

export const CATEGORIES: Category[] = [
  {
    id: 'length',
    label: '长度',
    units: [
      { label: '毫米 mm', factor: 0.001 },
      { label: '厘米 cm', factor: 0.01 },
      { label: '米 m', factor: 1 },
      { label: '千米 km', factor: 1000 },
      { label: '英寸 in', factor: 0.0254 },
      { label: '英尺 ft', factor: 0.3048 },
      { label: '码 yd', factor: 0.9144 },
      { label: '英里 mi', factor: 1609.344 },
      { label: '海里 nmi', factor: 1852 },
      { label: '光年 ly', factor: 9.4607304725808e15 },
    ],
  },
  {
    id: 'mass',
    label: '重量',
    units: [
      { label: '毫克 mg', factor: 1e-6 },
      { label: '克 g', factor: 0.001 },
      { label: '千克 kg', factor: 1 },
      { label: '吨 t', factor: 1000 },
      { label: '盎司 oz', factor: 0.028349523125 },
      { label: '磅 lb', factor: 0.45359237 },
      { label: '市斤', factor: 0.5 },
      { label: '两', factor: 0.05 },
    ],
  },
  {
    id: 'temperature',
    label: '温度',
    units: [{ label: '摄氏度 °C', factor: 1 }, { label: '华氏度 °F', factor: 1 }, { label: '开尔文 K', factor: 1 }],
    note: '温度按公式换算，不走比例。',
  },
  {
    id: 'area',
    label: '面积',
    units: [
      { label: '平方厘米 cm²', factor: 0.0001 },
      { label: '平方米 m²', factor: 1 },
      { label: '亩', factor: 666.6666666667 },
      { label: '公顷 ha', factor: 10000 },
      { label: '平方千米 km²', factor: 1e6 },
      { label: '平方英尺 ft²', factor: 0.09290304 },
      { label: '平方英里 mi²', factor: 2589988.110336 },
    ],
  },
  {
    id: 'volume',
    label: '体积',
    units: [
      { label: '毫升 mL', factor: 0.001 },
      { label: '升 L', factor: 1 },
      { label: '立方米 m³', factor: 1000 },
      { label: '加仑(美) gal', factor: 3.785411784 },
      { label: '加仑(英) gal', factor: 4.54609 },
      { label: '立方英尺 ft³', factor: 28.316846592 },
    ],
  },
  {
    id: 'speed',
    label: '速度',
    units: [
      { label: '米/秒 m/s', factor: 1 },
      { label: '千米/时 km/h', factor: 0.2777777777777778 },
      { label: '英里/时 mph', factor: 0.44704 },
      { label: '节 kn', factor: 0.5144444444444445 },
      { label: '马赫 Mach', factor: 340.29 },
    ],
  },
  {
    id: 'time',
    label: '时间',
    units: [
      { label: '毫秒 ms', factor: 0.001 },
      { label: '秒 s', factor: 1 },
      { label: '分钟 min', factor: 60 },
      { label: '小时 h', factor: 3600 },
      { label: '天 d', factor: 86400 },
      { label: '周 w', factor: 604800 },
      { label: '年(365天)', factor: 31536000 },
    ],
  },
  {
    id: 'data',
    label: '数据',
    units: [
      { label: '字节 B', factor: 1 },
      { label: 'KB', factor: 1024 },
      { label: 'MB', factor: 1024 ** 2 },
      { label: 'GB', factor: 1024 ** 3 },
      { label: 'TB', factor: 1024 ** 4 },
      { label: 'PB', factor: 1024 ** 5 },
      { label: 'Kb(比特)', factor: 0.125 },
      { label: 'Mb(比特)', factor: 0.125 * 1024 ** 2 },
    ],
    note: '按 1024 进制（KiB 口径）。',
  },
  {
    id: 'angle',
    label: '角度',
    units: [
      { label: '度 °', factor: 1 },
      { label: '弧度 rad', factor: 57.29577951308232 },
      { label: '百分度 grad', factor: 0.9 },
      { label: '圈 turn', factor: 360 },
    ],
  },
]

function temperatureToC(amount: number, from: string): number {
  if (from.includes('°F')) return ((amount - 32) * 5) / 9
  if (from.includes('K')) return amount - 273.15
  return amount
}

function temperatureFromC(c: number, to: string): number {
  if (to.includes('°F')) return (c * 9) / 5 + 32
  if (to.includes('K')) return c + 273.15
  return c
}

export function convertUnit(amount: number, catId: string, from: string, to: string): number {
  const cat = CATEGORIES.find((c) => c.id === catId) ?? CATEGORIES[0]
  if (cat.id === 'temperature') return temperatureFromC(temperatureToC(amount, from), to)
  const f = cat.units.find((u) => u.label === from) ?? cat.units[0]
  const t = cat.units.find((u) => u.label === to) ?? cat.units[1] ?? cat.units[0]
  return (amount * f.factor) / t.factor
}

/* ------------------------------------------------------------------ 键位定义 */

type Key = { label: string; ins: string; kind?: 'op' | 'fn' | 'eq' | 'clear' | 'mem' | 'digit' }

const MEM_KEYS: Key[] = [
  { label: 'MC', ins: 'MC', kind: 'mem' },
  { label: 'MR', ins: 'MR', kind: 'mem' },
  { label: 'M+', ins: 'M+', kind: 'mem' },
  { label: 'M−', ins: 'M-', kind: 'mem' },
]

const BASIC_ROWS: Key[][] = [
  [
    { label: 'AC', ins: 'AC', kind: 'clear' },
    { label: '⌫', ins: 'BACK', kind: 'clear' },
    { label: '%', ins: '%', kind: 'fn' },
    { label: '÷', ins: '/', kind: 'op' },
  ],
  [
    { label: '7', ins: '7', kind: 'digit' },
    { label: '8', ins: '8', kind: 'digit' },
    { label: '9', ins: '9', kind: 'digit' },
    { label: '×', ins: '*', kind: 'op' },
  ],
  [
    { label: '4', ins: '4', kind: 'digit' },
    { label: '5', ins: '5', kind: 'digit' },
    { label: '6', ins: '6', kind: 'digit' },
    { label: '−', ins: '-', kind: 'op' },
  ],
  [
    { label: '1', ins: '1', kind: 'digit' },
    { label: '2', ins: '2', kind: 'digit' },
    { label: '3', ins: '3', kind: 'digit' },
    { label: '+', ins: '+', kind: 'op' },
  ],
  [
    { label: '±', ins: 'NEG', kind: 'fn' },
    { label: '0', ins: '0', kind: 'digit' },
    { label: '.', ins: '.', kind: 'digit' },
    { label: '=', ins: '=', kind: 'eq' },
  ],
]

/** 科学模式左列，与 BASIC_ROWS 逐行对齐。 */
const SCI_COLUMN: Key[] = [
  { label: 'sin', ins: 'sin(', kind: 'fn' },
  { label: 'cos', ins: 'cos(', kind: 'fn' },
  { label: 'tan', ins: 'tan(', kind: 'fn' },
  { label: 'ln', ins: 'ln(', kind: 'fn' },
  { label: 'log', ins: 'log10(', kind: 'fn' },
]

const SCI_CHIPS: Key[] = [
  { label: 'π', ins: 'π', kind: 'fn' },
  { label: 'e', ins: 'e', kind: 'fn' },
  { label: 'x²', ins: '^2', kind: 'fn' },
  { label: 'xʸ', ins: '^', kind: 'fn' },
  { label: '√', ins: 'sqrt(', kind: 'fn' },
  { label: 'ˣ√y', ins: '^(1/', kind: 'fn' },
  { label: '(', ins: '(', kind: 'fn' },
  { label: ')', ins: ')', kind: 'fn' },
  { label: 'n!', ins: '!', kind: 'fn' },
  { label: '1/x', ins: '1/(', kind: 'fn' },
  { label: '|x|', ins: 'abs(', kind: 'fn' },
  { label: 'round', ins: 'round(', kind: 'fn' },
  { label: 'ans', ins: 'ans', kind: 'fn' },
  { label: 'm', ins: 'm', kind: 'fn' },
]

/* ------------------------------------------------------------------ 样式 */

const STYLE_ID = 'calc-block-style-v1'
const STYLE_CSS = `
.cb-root{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-border);border-radius:12px;background:var(--dsw-bg);color:var(--dsw-label);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 1px 2px rgba(15,15,15,.04);outline:none}
.cb-root:focus-visible{border-color:var(--dsw-pick);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-pick) 18%,transparent)}
.cb-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-border);background:var(--dsw-sidebar);border-radius:12px 12px 0 0}
.cb-title{min-width:70px;flex:1;border:0;outline:none;background:transparent;color:inherit;font:650 13px/1.4 inherit;padding:2px 0}
.cb-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--dsw-border);border-radius:8px;background:var(--dsw-input)}
.cb-seg button{border:0;border-radius:6px;padding:3px 9px;background:transparent;color:var(--dsw-label-2);font:650 12px/1.4 inherit;cursor:pointer}
.cb-seg button[data-on=true]{background:var(--dsw-bg);color:var(--dsw-label);box-shadow:0 1px 2px rgba(15,15,15,.08)}
.cb-btn{border:1px solid var(--dsw-border);border-radius:7px;padding:3px 8px;background:var(--dsw-input);color:var(--dsw-label-2);font:600 12px/1.4 inherit;cursor:pointer}
.cb-btn:hover{background:var(--dsw-hover);color:var(--dsw-label)}
.cb-btn[data-on=true]{border-color:var(--dsw-pick);color:var(--dsw-pick)}
.cb-body{display:flex;min-width:0;align-items:stretch}
.cb-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:8px;padding:10px}
.cb-screen{border:1px solid var(--dsw-border);border-radius:10px;background:color-mix(in srgb,var(--dsw-hover) 45%,var(--dsw-bg));padding:9px 12px;text-align:right;overflow:hidden}
.cb-expr{width:100%;box-sizing:border-box;border:0;outline:none;background:transparent;color:var(--dsw-label);font:600 15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:right;padding:0}
.cb-expr::placeholder{color:var(--dsw-placeholder);font-weight:500}
.cb-value{margin-top:4px;font:700 25px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:-.01em;color:var(--dsw-label);word-break:break-all}
.cb-value[data-error=true]{font-size:13px;font-weight:600;color:var(--dsw-danger);font-family:inherit}
.cb-bases{margin-top:5px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;font:11px/1.4 ui-monospace,Menlo,monospace;color:var(--dsw-label-3);word-break:break-all}
.cb-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-label-3);min-height:18px}
.cb-placeholder{color:var(--dsw-label-3)}
.cb-keys{display:grid;gap:6px;grid-auto-rows:minmax(34px,auto)}
.cb-key{border:1px solid var(--dsw-border);border-radius:9px;background:var(--dsw-input);color:var(--dsw-label);font:600 15px/1 inherit;cursor:pointer;padding:0;min-height:34px;transition:background .1s,border-color .1s}
.cb-key:hover{background:var(--dsw-hover)}
.cb-key:active{transform:translateY(1px)}
.cb-key:disabled{cursor:default;opacity:.6}
.cb-key[data-kind=op]{color:var(--dsw-pick);font-size:17px}
.cb-key[data-kind=fn]{font-size:12.5px;color:var(--dsw-label-2);background:color-mix(in srgb,var(--dsw-hover) 55%,var(--dsw-bg))}
.cb-key[data-kind=eq]{background:var(--dsw-pick);border-color:var(--dsw-pick);color:#fff;font-size:17px}
.cb-key[data-kind=clear]{color:var(--dsw-danger);font-size:13px}
.cb-key[data-kind=mem]{font-size:11px;color:var(--dsw-label-3)}
.cb-chips{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
.cb-chipkey{border:1px solid var(--dsw-border);border-radius:8px;background:color-mix(in srgb,var(--dsw-hover) 55%,var(--dsw-bg));color:var(--dsw-label-2);font:600 12px/1 inherit;padding:7px 2px;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-chipkey:hover{background:var(--dsw-hover);color:var(--dsw-label)}
.cb-history{flex:none;width:198px;border-left:1px solid var(--dsw-border);display:flex;flex-direction:column;min-height:0}
.cb-history-head{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--dsw-border);font:650 11px/1.4 inherit;color:var(--dsw-label-3)}
.cb-history-list{overflow:auto;max-height:360px;padding:4px}
.cb-history-item{display:block;width:100%;text-align:right;border:0;border-radius:7px;background:transparent;padding:5px 8px;color:var(--dsw-label);font:12px/1.45 ui-monospace,Menlo,monospace;cursor:pointer}
.cb-history-item:hover{background:var(--dsw-hover)}
.cb-history-item span{display:block;color:var(--dsw-label-3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-history-empty{padding:14px 10px;color:var(--dsw-label-3);font-size:12px;text-align:center}
.cb-conv{display:flex;flex-direction:column;gap:9px;padding:10px}
.cb-conv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cb-conv input,.cb-conv select{border:1px solid var(--dsw-border);border-radius:8px;background:var(--dsw-input);color:var(--dsw-label);font:13px/1.4 inherit;padding:7px 9px;outline:none;min-width:0}
.cb-conv input{flex:1;font-family:ui-monospace,Menlo,monospace}
.cb-conv select{min-width:132px}
.cb-conv-swap{border:1px solid var(--dsw-border);border-radius:8px;background:var(--dsw-input);color:var(--dsw-label-2);cursor:pointer;padding:7px 10px;font:600 13px/1 inherit}
.cb-conv-swap:hover{background:var(--dsw-hover);color:var(--dsw-label)}
.cb-conv-out{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-border);border-radius:10px;padding:10px 12px;background:color-mix(in srgb,var(--dsw-hover) 45%,var(--dsw-bg));font-family:ui-monospace,Menlo,monospace}
.cb-conv-out b{font-size:22px;letter-spacing:-.01em;word-break:break-all}
.cb-conv-out em{font-style:normal;color:var(--dsw-label-3);font-size:12px}
.cb-note{color:var(--dsw-label-3);font-size:11px}
.cb-launch{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-border);border-radius:12px;padding:9px 12px;background:var(--dsw-bg)}
.cb-launch b{font-weight:650}
.cb-launch span{color:var(--dsw-label-3);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-float{position:fixed;z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-float-border,var(--dsw-border));border-radius:12px;background:var(--dsw-bg);box-shadow:0 16px 44px rgba(0,0,0,.24);color:var(--dsw-label);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
.cb-float-head{display:flex;align-items:center;gap:7px;padding:6px 8px;background:var(--dsw-sidebar);border-bottom:1px solid var(--dsw-border);cursor:grab;user-select:none;font-size:12px;font-weight:650;touch-action:none}
.cb-float.cb-dragging .cb-float-head{cursor:grabbing}
.cb-dots{display:flex;gap:4px;margin-right:2px}
.cb-dots i{width:9px;height:9px;border-radius:50%;display:block}
.cb-dots i:nth-child(1){background:#ff5f57}
.cb-dots i:nth-child(2){background:#febc2e}
.cb-dots i:nth-child(3){background:#28c840}
.cb-float-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-float-body{max-height:min(76vh,620px);overflow:auto}
.cb-mini{display:flex;align-items:center;gap:10px;min-width:0}
.cb-mini b{font:700 13px/1.4 ui-monospace,Menlo,monospace}
.cb-mini span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-label-3);font-size:11px;min-width:0}
@media (max-width:720px){.cb-body{flex-direction:column}.cb-history{width:auto;border-left:0;border-top:1px solid var(--dsw-border)}}
`

function useCalcStyle() {
  useEffect(() => {
    const existing = document.getElementById(STYLE_ID)
    const el = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
    el.id = STYLE_ID
    el.textContent = STYLE_CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

/* ------------------------------------------------------------------ 类型与默认值 */

export type CalcMode = 'basic' | 'scientific' | 'convert'

export type CalcData = {
  title?: string
  mode?: CalcMode
  angle?: AngleMode
  expr?: string
  ans?: number
  memory?: number
  history?: { expr: string; value: number }[]
  floating?: boolean
  showHistory?: boolean
  showBases?: boolean
  group?: boolean
  convert?: { category?: string; from?: string; to?: string; amount?: string }
  /** 悬浮小窗位置（px，相对视口左上角）。 */
  floatPos?: { x?: number; y?: number }
}

type Props = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
  presentation?: { mode: 'inline' | 'sidebar' | 'maximized' | 'minimized' | string; maximize?: () => void; detached?: boolean }
}

const DEFAULT_DATA: CalcData = {
  title: '计算器',
  mode: 'scientific',
  angle: 'deg',
  expr: '',
  ans: 0,
  memory: 0,
  history: [],
  floating: false,
  showHistory: true,
  showBases: true,
  group: true,
  convert: { category: 'length', from: '米 m', to: '英尺 ft', amount: '1' },
}

function readMode(v: unknown): CalcMode {
  const s = String(v ?? '')
  return s === 'basic' || s === 'convert' ? s : 'scientific'
}

/* ------------------------------------------------------------------ 计算器主体 */

function useCalcModel(data: Record<string, unknown>, update: (patch: Record<string, unknown>) => void, writable: boolean) {
  const angle: AngleMode = String(data.angle ?? 'rad') === 'deg' ? 'deg' : 'rad'
  const history = Array.isArray(data.history) ? (data.history as { expr: string; value: number }[]) : []
  const memory = Number(data.memory ?? 0) || 0
  const ans = Number(data.ans ?? 0) || 0
  const [expr, setExpr] = useState(() => String(data.expr ?? ''))
  const [error, setError] = useState('')
  const exprRef = useRef(expr)
  const dirty = useRef(false)
  exprRef.current = expr

  const persisted = String(data.expr ?? '')
  useEffect(() => {
    if (!dirty.current && persisted !== exprRef.current) setExpr(persisted)
  }, [persisted])

  const vars = useMemo(() => ({ ans, m: memory, mem: memory }), [ans, memory])
  const historyRef = useRef(history)
  const varsRef = useRef(vars)
  const updateRef = useRef(update)
  const angleRef = useRef(angle)
  const writableRef = useRef(writable)
  historyRef.current = history
  varsRef.current = vars
  updateRef.current = update
  angleRef.current = angle
  writableRef.current = writable

  const preview = useMemo(() => {
    const src = expr.trim()
    if (!src) return { text: '', ok: false, empty: true }
    try {
      return { text: fmtNum(evalExpr(src, angle, vars)), ok: true, empty: false }
    } catch (e) {
      return { text: (e as Error).message, ok: false, empty: false }
    }
  }, [expr, angle, vars])

  function setExprValue(next: string) {
    dirty.current = true
    setError('')
    exprRef.current = next
    setExpr(next)
  }

  function commit() {
    const src = exprRef.current.trim()
    if (!src) return { expr: '', value: null as number | null, error: '' }
    try {
      const value = evalExpr(src, angleRef.current, varsRef.current)
      const list = [{ expr: src, value }, ...historyRef.current.filter((h) => !(h.expr === src && h.value === value))].slice(0, 30)
      const text = fmtNum(value)
      dirty.current = false
      setError('')
      exprRef.current = text
      setExpr(text)
      updateRef.current({ ans: value, expr: text, history: list })
      return { expr: text, value, error: '' }
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      return { expr: src, value: null as number | null, error: message }
    }
  }

  function applyKey(raw: string) {
    const cur = exprRef.current
    if (raw === 'AC') { setExprValue(''); return }
    if (raw === 'BACK') { setExprValue(cur.slice(0, -1)); return }
    if (raw === '=') { commit(); return }
    if (!writableRef.current) return
    if (raw === 'NEG') {
      const m = cur.match(/(\d*\.?\d+)$/)
      if (!m) { setExprValue(cur + '-'); return }
      const start = cur.length - m[1].length
      const before = cur.slice(0, start)
      setExprValue(before.endsWith('-') ? before.slice(0, -1) + m[1] : before + '-' + m[1])
      return
    }
    if (raw === 'MC') { updateRef.current({ memory: 0 }); return }
    if (raw === 'MR') { setExprValue(cur + fmtNum(Number(varsRef.current.m) || 0)); return }
    if (raw === 'M+' || raw === 'M-') {
      let v = Number(varsRef.current.ans) || 0
      try { if (cur.trim()) v = evalExpr(cur, angleRef.current, varsRef.current) } catch { v = Number(varsRef.current.ans) || 0 }
      updateRef.current({ memory: (Number(varsRef.current.m) || 0) + (raw === 'M+' ? v : -v) })
      return
    }
    setExprValue(cur + raw)
  }

  function onKeyDown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void; stopPropagation: () => void }) {
    const k = event.key
    if (event.ctrlKey || event.metaKey) return
    if (/^[0-9.+\-*/^%()!]$/.test(k)) { event.preventDefault(); event.stopPropagation(); applyKey(k); return }
    if (k === 'Enter' || k === '=') { event.preventDefault(); event.stopPropagation(); commit(); return }
    if (k === 'Backspace') { event.preventDefault(); event.stopPropagation(); applyKey('BACK'); return }
    if (k === 'Delete' || k === 'Escape') { event.preventDefault(); event.stopPropagation(); applyKey('AC'); return }
    if (/^[a-zA-Z]$/.test(k)) { event.preventDefault(); event.stopPropagation(); applyKey(k.toLowerCase()); return }
  }

  useEffect(() => () => { if (dirty.current) updateRef.current({ expr: exprRef.current }) }, [])

  const api = { expr, exprRef, error, setExprValue, commit, applyKey, onKeyDown, preview, angle, vars, history, memory, ans, writable }
  const apiRef = useRef(api)
  apiRef.current = api
  return { api, apiRef }
}

/* ------------------------------------------------------------------ 子组件 */

function Keypad({ api, compact }: { api: ReturnType<typeof useCalcModel>['api']; compact?: boolean }) {
  const rows = BASIC_ROWS.map((row, i) => (compact ? row : [SCI_COLUMN[i], ...row]))
  const cols = compact ? 'repeat(4,minmax(0,1fr))' : 'repeat(5,minmax(0,1fr))'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="cb-keys" style={{ gridTemplateColumns: cols }}>
        {rows.flat().map((key, index) => (
          <button
            key={key.label + index}
            type="button"
            className="cb-key"
            data-kind={key.kind ?? 'digit'}
            data-testid={'calc-key-' + key.ins}
            onClick={() => api.applyKey(key.ins)}
          >
            {key.label}
          </button>
        ))}
      </div>
      <div className="cb-keys" style={{ gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}>
        {(compact ? MEM_KEYS.slice(0, 2) : MEM_KEYS).map((key) => (
          <button key={key.label} type="button" className="cb-key" data-kind="mem" onClick={() => api.applyKey(key.ins)}>
            {key.label}
          </button>
        ))}
        {!compact && (
          <>
            <button type="button" className="cb-key" data-kind="fn" onClick={() => api.applyKey('(')}>
              (
            </button>
            <button type="button" className="cb-key" data-kind="fn" onClick={() => api.applyKey(')')}>
              )
            </button>
          </>
        )}
      </div>
      {!compact && (
        <div className="cb-chips">
          {SCI_CHIPS.map((chip) => (
            <button key={chip.label} type="button" className="cb-chipkey" onClick={() => api.applyKey(chip.ins)}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Screen({ api, showBases, group }: { api: ReturnType<typeof useCalcModel>['api']; showBases: boolean; group: boolean }) {
  let raw = Number.NaN
  if (api.preview.ok) {
    try { raw = evalExpr(api.expr, api.angle, api.vars) } catch { raw = Number.NaN }
  }
  const display = api.preview.ok ? (group ? fmtDisplay(raw) : fmtNum(raw)) : api.preview.text
  return (
    <div className="cb-screen">
      <input
        className="cb-expr"
        data-testid="calc-expr"
        placeholder="输入表达式，例如 12*(3+4)/sqrt(2)"
        spellCheck={false}
        readOnly={!api.writable}
        value={api.expr}
        onChange={(event) => api.setExprValue(event.currentTarget.value)}
      />
      {api.error ? (
        <div className="cb-value" data-error="true" data-testid="calc-error">
          {api.error}
        </div>
      ) : (
        <div className="cb-value" data-testid="calc-value">
          {api.preview.empty ? '0' : display}
        </div>
      )}
      {showBases && !api.error && !api.preview.empty && Number.isFinite(raw) ? (
        <div className="cb-bases">
          <span>HEX {toBase(raw, 16)}</span>
          <span>BIN {toBase(raw, 2)}</span>
        </div>
      ) : null}
    </div>
  )
}

function HistoryPanel({ api, update }: { api: ReturnType<typeof useCalcModel>['api']; update: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="cb-history">
      <div className="cb-history-head">
        <span>历史（{api.history.length}）</span>
        <span style={{ flex: 1 }} />
        {api.history.length > 0 && (
          <button type="button" className="cb-chip" onClick={() => update({ history: [] })} disabled={!api.writable}>
            清空
          </button>
        )}
      </div>
      <div className="cb-history-list">
        {api.history.length === 0 ? (
          <div className="cb-history-empty">按 = 会把算式记在这里，点一条可回填。</div>
        ) : (
          api.history.map((item, index) => (
            <button
              key={item.expr + index}
              type="button"
              className="cb-history-item"
              title={item.expr + ' = ' + fmtNum(item.value)}
              onClick={() => api.setExprValue(fmtNum(item.value))}
            >
              {fmtDisplay(item.value)}
              <span>{item.expr}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function ConvertPanel({ data, update, writable }: { data: Record<string, unknown>; update: (patch: Record<string, unknown>) => void; writable: boolean }) {
  const convert = (data.convert ?? {}) as { category?: string; from?: string; to?: string; amount?: string }
  const category = CATEGORIES.find((c) => c.id === convert.category) ?? CATEGORIES[0]
  const [amount, setAmount] = useState(() => String(convert.amount ?? '1'))
  const amountRef = useRef(amount)
  amountRef.current = amount
  useEffect(() => {
    const persisted = String(convert.amount ?? '1')
    if (persisted !== amountRef.current) setAmount(persisted)
  }, [convert.amount])

  const units = category.units
  const from = units.some((u) => u.label === convert.from) ? String(convert.from) : units[0].label
  const to = units.some((u) => u.label === convert.to) ? String(convert.to) : (units[1] ?? units[0]).label
  const n = Number(amount)
  const valid = amount.trim() !== '' && Number.isFinite(n)
  const result = valid ? convertUnit(n, category.id, from, to) : Number.NaN

  function persist(patch: Partial<{ category: string; from: string; to: string; amount: string }>) {
    update({ convert: { category, from, to, amount: amountRef.current, ...patch } })
  }

  return (
    <div className="cb-conv">
      <div className="cb-conv-row">
        <select
          data-testid="calc-conv-category"
          disabled={!writable}
          value={category.id}
          onChange={(event) => {
            const next = CATEGORIES.find((c) => c.id === event.target.value) ?? CATEGORIES[0]
            update({ convert: { category: next.id, from: next.units[0].label, to: (next.units[1] ?? next.units[0]).label, amount: amountRef.current } })
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          data-testid="calc-conv-amount"
          inputMode="decimal"
          spellCheck={false}
          readOnly={!writable}
          value={amount}
          placeholder="数值，也可写 1+2"
          onChange={(event) => setAmount(event.currentTarget.value)}
          onBlur={() => {
            let next = amountRef.current.trim()
            if (next && !Number.isFinite(Number(next))) {
              try { next = fmtNum(evalExpr(next, 'rad')) } catch { next = '0' }
              setAmount(next)
            }
            persist({ amount: next })
          }}
        />
      </div>
      <div className="cb-conv-row">
        <select data-testid="calc-conv-from" disabled={!writable} value={from} onChange={(event) => persist({ from: event.target.value })}>
          {units.map((u) => (
            <option key={u.label} value={u.label}>
              {u.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="cb-conv-swap"
          disabled={!writable}
          title="对调单位"
          onClick={() => persist({ from: to, to: from })}
        >
          ⇄
        </button>
        <select data-testid="calc-conv-to" disabled={!writable} value={to} onChange={(event) => persist({ to: event.target.value })}>
          {units.map((u) => (
            <option key={u.label} value={u.label}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cb-conv-out">
        <b data-testid="calc-conv-result">{valid ? fmtDisplay(result) : '—'}</b>
        <em>{to}</em>
        <span style={{ flex: 1 }} />
        <em>{valid ? fmtDisplay(n) + ' ' + from + ' =' : '请输入数值'}</em>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 6 }}>
        {units
          .filter((u) => u.label !== from)
          .map((u) => (
            <div key={u.label} className="cb-note" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, border: '1px solid var(--dsw-border)', borderRadius: 8, padding: '5px 8px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.label}</span>
              <span style={{ color: 'var(--dsw-label)', fontFamily: 'ui-monospace,Menlo,monospace' }}>
                {valid ? fmtDisplay(convertUnit(n, category.id, from, u.label)) : '—'}
              </span>
            </div>
          ))}
      </div>
      {category.note ? <div className="cb-note">{category.note}</div> : null}
    </div>
  )
}

type FloatProps = {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
}

/** 悬浮计算器的 UI：拖动标题栏移动，位置写回块数据。 */
export function FloatingView({ data, update }: FloatProps) {
  const pos = (data.floatPos ?? {}) as { x?: number; y?: number }
  const [xy, setXy] = useState(() => ({
    x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : Math.max(12, window.innerWidth - 340),
    y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : 96,
  }))
  const [dragging, setDragging] = useState(false)
  const drag = useRef({ dx: 0, dy: 0 })
  const { api } = useCalcModel(data, update, true)
  const title = String(data.title ?? '计算器')
  useCalcStyle()

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      setXy({
        x: Math.min(Math.max(-40, event.clientX - drag.current.dx), window.innerWidth - 80),
        y: Math.min(Math.max(0, event.clientY - drag.current.dy), window.innerHeight - 48),
      })
    }
    const up = () => {
      setDragging(false)
      setXy((cur) => {
        update({ floatPos: { x: Math.round(cur.x), y: Math.round(cur.y) } })
        return cur
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, update])

  return (
    <div
      className={'cb-float' + (dragging ? ' cb-dragging' : '')}
      data-testid="calc-float"
      style={{ left: xy.x, top: xy.y, width: 312 }}
    >
      <div
        className="cb-float-head"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          drag.current = { dx: event.clientX - xy.x, dy: event.clientY - xy.y }
          setDragging(true)
        }}
      >
        <span className="cb-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="cb-float-title">{title}</span>
        <button type="button" className="cb-btn" title="收起悬浮计算器" onClick={() => update({ floating: false })}>
          ✕
        </button>
      </div>
      <div className="cb-float-body">
        <div className="cb-main" style={{ padding: 8 }}>
          <Screen api={api} showBases={false} group={Boolean(data.group !== false)} />
          <Keypad api={api} compact />
        </div>
      </div>
    </div>
  )
}

/** 悬浮窗挂到 body 上，不受块容器裁剪影响。 */
export function FloatPortal({ data, update }: FloatProps) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHost(document.body)
  }, [])
  if (!host) return null
  const ReactDOM = globalThis.ReactDOM
  return ReactDOM?.createPortal ? ReactDOM.createPortal(<FloatingView data={data} update={update} />, host) : <FloatingView data={data} update={update} />
}

function MinimizedCalc({ data }: { data: Record<string, unknown> }) {
  const expr = String(data.expr ?? '')
  const ans = Number(data.ans ?? 0) || 0
  const memory = Number(data.memory ?? 0) || 0
  const mode = readMode(data.mode)
  const label = mode === 'convert' ? '单位换算' : mode === 'basic' ? '基础' : '科学'
  return (
    <div className="cb-mini">
      <b>{expr.trim() || fmtDisplay(ans)}</b>
      <span>
        {label} · M {fmtDisplay(memory)}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ 主组件 */

function CalcBlock(props: Props) {
  const { data, update, writable, presentation } = props
  const ro = !writable
  const mode = readMode(data.mode)
  const title = String(data.title ?? '计算器')
  const showHistory = data.showHistory !== false
  const showBases = data.showBases !== false
  const group = data.group !== false
  const angle: AngleMode = String(data.angle ?? 'rad') === 'deg' ? 'deg' : 'rad'
  const { api, apiRef } = useCalcModel(data, update, writable)
  const instanceId = useRef('calc-' + (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 18))
  const dataRef = useRef(data)
  dataRef.current = data
  useCalcStyle()

  const minimized = presentation?.mode === 'minimized'
  const detached = !minimized && Boolean(presentation && presentation.mode !== 'inline' && presentation.detached !== false)

  const updateRef = useRef(update)
  updateRef.current = update
  const writableRef = useRef(writable)
  writableRef.current = writable

  useEffect(
    () =>
      uiActions?.register({
        plugin: name,
        instanceId: instanceId.current,
        kind: 'calc',
        label: title,
        surface: 'main',
        state: () => ({
          expr: apiRef.current.expr,
          result: apiRef.current.preview.ok ? apiRef.current.preview.text : null,
          error: apiRef.current.error || null,
          mode: String(dataRef.current.mode ?? 'scientific'),
          angle: String(dataRef.current.angle ?? 'deg'),
          ans: Number(dataRef.current.ans ?? 0),
          memory: Number(dataRef.current.memory ?? 0),
          history: dataRef.current.history ?? [],
          floating: Boolean(dataRef.current.floating),
        }),
        actions: {
          read_state: {
            description: '读取计算器当前表达式、结果预览、错误、角度模式、内存与历史',
            risk: 'read',
            run: () => ({
              expr: apiRef.current.expr,
              result: apiRef.current.preview.ok ? apiRef.current.preview.text : null,
              error: apiRef.current.error || null,
              mode: String(dataRef.current.mode ?? ''),
              angle: String(dataRef.current.angle ?? ''),
              memory: Number(dataRef.current.memory ?? 0),
              history: dataRef.current.history ?? [],
            }),
          },
          press_key: {
            description: '按一个键：0-9 . + - * / ^ % ( ) ! 、= 、AC、BACK、NEG、MC、MR、M+、M-',
            risk: 'write',
            inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
            run: (args: Record<string, unknown>) => {
              if (!writableRef.current) throw new Error('计算器当前只读')
              const key = String(args.key ?? '')
              if (key === '=') {
                const out = apiRef.current.commit()
                return out
              }
              apiRef.current.applyKey(key)
              return { expr: apiRef.current.expr }
            },
          },
          evaluate: {
            description: '对表达式求值并写入历史（不传 expression 时用当前输入框内容）',
            risk: 'write',
            inputSchema: {
              type: 'object',
              properties: { expression: { type: 'string' }, angle: { type: 'string', enum: ['deg', 'rad'] } },
            },
            run: (args: Record<string, unknown>) => {
              if (!writableRef.current) throw new Error('计算器当前只读')
              const src = args.expression === undefined ? apiRef.current.expr : String(args.expression)
              const useAngle: AngleMode = args.angle === 'rad' ? 'rad' : args.angle === 'deg' ? 'deg' : apiRef.current.angle
              let value: number
              try {
                value = evalExpr(src, useAngle, apiRef.current.vars)
              } catch (e) {
                return { expression: src, ok: false, error: (e as Error).message }
              }
              const history = [{ expr: src.trim(), value }, ...apiRef.current.history].slice(0, 30)
              apiRef.current.setExprValue(fmtNum(value))
              updateRef.current({ ans: value, expr: fmtNum(value), history })
              return { expression: src, value, text: fmtDisplay(value), ok: true }
            },
          },
          clear: {
            description: '清空输入框（AC）',
            risk: 'write',
            run: () => {
              if (!writableRef.current) throw new Error('计算器当前只读')
              apiRef.current.applyKey('AC')
              return { expr: '' }
            },
          },
          get_history: {
            description: '读取历史记录列表',
            risk: 'read',
            run: () => ({ history: dataRef.current.history ?? [] }),
          },
          clear_history: {
            description: '清空历史记录',
            risk: 'write',
            run: () => {
              if (!writableRef.current) throw new Error('计算器当前只读')
              updateRef.current({ history: [] })
              return { history: [] }
            },
          },
          convert: {
            description: '单位换算：给 amount 与单位（可选 category/from/to），返回结果并写回块数据',
            risk: 'write',
            inputSchema: {
              type: 'object',
              properties: {
                amount: { type: ['number', 'string'] },
                category: { type: 'string', description: 'length/mass/temperature/area/volume/speed/time/data/angle' },
                from: { type: 'string', description: '源单位，如 米 m' },
                to: { type: 'string', description: '目标单位，如 英尺 ft' },
              },
              required: ['amount'],
            },
            run: (args: Record<string, unknown>) => {
              const current = (dataRef.current.convert ?? {}) as { category?: string; from?: string; to?: string }
              const categoryId = String(args.category ?? current.category ?? 'length')
              const cat = CATEGORIES.find((c) => c.id === categoryId)
              if (!cat) throw new Error('未知分类 ' + categoryId + '，可用：' + CATEGORIES.map((c) => c.id).join('/'))
              const findUnit = (name: unknown, idx: number) => {
                if (typeof name === 'string' && name) {
                  const hit = cat.units.find((u) => u.label === name || u.label.includes(name) || name.includes(u.label))
                  if (hit) return hit.label
                }
                return (cat.units[idx] ?? cat.units[0]).label
              }
              const from = findUnit(args.from ?? current.from, 0)
              const to = findUnit(args.to ?? current.to, 1)
              const amountRaw = args.amount
              let amount = typeof amountRaw === 'number' ? amountRaw : Number(String(amountRaw ?? '').trim())
              if (!Number.isFinite(amount)) {
                try { amount = evalExpr(String(amountRaw ?? ''), 'rad') } catch { throw new Error('amount 不是数字：' + String(amountRaw)) }
              }
              const value = convertUnit(amount, cat.id, from, to)
              if (writableRef.current) {
                updateRef.current({ convert: { category: cat.id, from, to, amount: fmtNum(amount) } })
              }
              return { amount, from, to, value, text: fmtDisplay(value), category: cat.id, label: cat.label }
            },
          },
        },
      }),
    [],
  )

  // 宿主把块收进侧栏/全屏时，文档里留一条紧凑摘要；悬浮窗走 portal 到 body。
  const body = minimized ? (
    <MinimizedCalc data={data} />
  ) : detached ? (
    <div className="cb-launch">
      <b>{title}</b>
      <span>{api.expr.trim() ? api.expr + ' = ' + (api.preview.ok ? api.preview.text : '…') : '已在独立窗口运行'}</span>
      <span style={{ flex: 1 }} />
      {presentation?.maximize && (
        <button type="button" className="cb-btn" onClick={() => presentation.maximize?.()}>
          聚焦窗口
        </button>
      )}
    </div>
  ) : (
    <div
      className="cb-root"
      data-testid="page-calc-block"
      tabIndex={0}
      onKeyDown={(event) => api.onKeyDown(event)}
    >
      <div className="cb-head">
        <input
          className="cb-title"
          data-testid="calc-title"
          data-page-block-capture=""
          readOnly={ro}
          spellCheck={false}
          value={title}
          onChange={(event) => update({ title: event.currentTarget.value })}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div className="cb-seg">
          {(['basic', 'scientific', 'convert'] as CalcMode[]).map((id) => (
            <button key={id} type="button" data-on={mode === id} disabled={ro} onClick={() => update({ mode: id })}>
              {id === 'basic' ? '基础' : id === 'scientific' ? '科学' : '换算'}
            </button>
          ))}
        </div>
        {mode !== 'convert' && (
          <button
            type="button"
            className="cb-btn"
            data-on={angle === 'deg'}
            disabled={ro}
            title="三角函数按度或弧度计算"
            onClick={() => update({ angle: angle === 'deg' ? 'rad' : 'deg' })}
          >
            {angle === 'deg' ? 'DEG' : 'RAD'}
          </button>
        )}
        <button
          type="button"
          className="cb-btn"
          data-on={showHistory}
          disabled={ro}
          title="显示/隐藏历史记录"
          onClick={() => update({ showHistory: !showHistory })}
        >
          历史
        </button>
        <button
          type="button"
          className="cb-btn"
          data-on={showBases}
          disabled={ro}
          title="在结果下方显示十六进制/二进制"
          onClick={() => update({ showBases: !showBases })}
        >
          HEX
        </button>
        <button
          type="button"
          className="cb-btn"
          data-on={Boolean(data.floating)}
          disabled={ro}
          title="把计算器做成可拖动的悬浮小窗"
          onClick={() => update({ floating: !data.floating })}
        >
          悬浮
        </button>
      </div>
      {mode === 'convert' ? (
        <ConvertPanel data={data} update={update} writable={writable} />
      ) : (
        <div className="cb-body">
          <div className="cb-main">
            <Screen api={api} showBases={showBases} group={group} />
            <div className="cb-meta">
              <span>M = {fmtDisplay(api.memory)}</span>
              <span>ans = {fmtDisplay(api.ans)}</span>
              <span style={{ flex: 1 }} />
              <span className="cb-placeholder">键盘可直接输入，Enter 计算</span>
            </div>
            <Keypad api={api} />
          </div>
          {showHistory && <HistoryPanel api={api} update={update} />}
        </div>
      )}
    </div>
  )

  return (
    <>
      {body}
      {data.floating && !minimized ? <FloatPortal data={data} update={update} /> : null}
    </>
  )
}

/** 宿主把块收起到页面里时显示的紧凑摘要。 */
function CalcMinimized(props: Props) {
  useCalcStyle()
  return <MinimizedCalc data={props.data} />
}

/* ------------------------------------------------------------------ 插件入口 */

type PageEditorApi = {
  registerBlock: (spec: {
    kind: string
    plugin: string
    label: string
    blockType?: string
    blockTypeLabel?: string
    hint?: string
    aliases?: string[]
    defaults?: Record<string, unknown> | (() => Record<string, unknown>)
    assets?: never
    View: (props: Props) => unknown
    MinimizedView?: (props: Props) => unknown
  }) => void
}

export function apply(ctx: { pageEditor: PageEditorApi; uiActions: UiActionsApi }) {
  uiActions = ctx.uiActions
  ctx.pageEditor.registerBlock({
    kind: 'calc',
    plugin: name,
    label: '计算器',
    blockType: 'calc',
    blockTypeLabel: '计算器',
    hint: '基础/科学/单位换算三种外观，键盘直接输入，可悬浮成可拖动小窗',
    aliases: ['calc', 'calculator', '计算器', '算一下', '换算'],
    assets: [],
    defaults: () => ({
      title: '计算器',
      mode: DEFAULT_DATA.mode,
      angle: DEFAULT_DATA.angle,
      expr: '',
      ans: 0,
      memory: 0,
      history: [],
      floating: false,
      showHistory: true,
      showBases: true,
      group: true,
      convert: { ...(DEFAULT_DATA.convert ?? {}) },
    }),
    View: CalcBlock,
    MinimizedView: CalcMinimized,
  })
}
