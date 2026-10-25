/**
 * 计算器块自测：不依赖浏览器，直接验证求值器、格式化与单位换算。
 * 用法：node verify.mjs   （全部通过退出码 0）
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const noop = () => undefined
const hook = () => undefined
globalThis.React = { useEffect: hook, useMemo: hook, useRef: () => ({ current: null }), useState: (v) => [typeof v === 'function' ? v() : v, noop], createElement: (t, p, ...c) => ({ t, p, c }) }
globalThis.ReactDOM = { createPortal: (n) => n }
globalThis.ReactJSXRuntime = { jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }), jsxDEV: (t, p) => ({ t, p }) }

const esbuild = await import('esbuild')
const out = await esbuild.build({
  entryPoints: [new URL('./web/index.tsx', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  tsconfigRaw: '{"compilerOptions":{"jsx":"react"}}',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
})
const dir = mkdtempSync(join(tmpdir(), 'calcverify-'))
const file = join(dir, 'web.mjs')
writeFileSync(file, out.outputFiles[0].text)
const mod = await import(pathToFileURL(file).href)

const { evalExpr, fmtNum, fmtDisplay, toBase, convertUnit } = mod
let failed = 0
let passed = 0

function eq(actual, expected, label) {
  const close = typeof expected === 'number' && typeof actual === 'number' && Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-9)
  const ok = Object.is(actual, expected) || close
  if (ok) { passed += 1; console.log('  ✅ ' + label + ' → ' + actual) }
  else { failed += 1; console.log('  ❌ ' + label + ' → 期望 ' + expected + '，实际 ' + actual) }
}
function throws(fn, label) {
  try { fn(); failed += 1; console.log('  ❌ ' + label + ' → 期望报错，却算出了结果') }
  catch { passed += 1; console.log('  ✅ ' + label + ' → 正确报错') }
}

console.log('▸ 基础运算')
eq(evalExpr('1+2*3'), 7, '优先级 1+2*3')
eq(evalExpr('(1+2)*3'), 9, '括号 (1+2)*3')
eq(evalExpr('2^10'), 1024, '乘方 2^10')
eq(evalExpr('2^3^2'), 512, '乘方右结合 2^3^2')
eq(evalExpr('-3^2'), -9, '一元负号优先级 -3^2')
eq(evalExpr('5!'), 120, '阶乘 5!')
eq(evalExpr('√9'), 3, 'Unicode 根号 √9')
eq(evalExpr('12 ÷ 4'), 3, '全角符号 12 ÷ 4')

console.log('▸ 百分比（手机口径）')
eq(evalExpr('200*15%'), 30, '200*15%')
eq(evalExpr('100+10%'), 110, '100+10%')
eq(evalExpr('100-10%'), 90, '100-10%')
eq(evalExpr('50%'), 0.5, '单独 50%')

console.log('▸ 函数与常量')
eq(evalExpr('sin(30)', 'deg'), 0.5, 'sin(30) 角度制')
eq(Math.round(evalExpr('sin(pi/2)', 'rad') * 1e9) / 1e9, 1, 'sin(pi/2) 弧度制')
eq(evalExpr('sin(45', 'deg'), Math.sin(Math.PI / 4), '缺右括号自动补齐 sin(45')
eq(evalExpr('max(3,7,2)'), 7, '多参 max(3,7,2)')
eq(evalExpr('gcd(12,18)'), 6, 'gcd(12,18)')
eq(evalExpr('round(3.14159,2)'), 3.14, 'round(3.14159,2)')
eq(evalExpr('log(1000)'), 3, 'log 以 10 为底')
eq(evalExpr('log(8,2)'), 3, 'log(8,2) 指定底')
eq(evalExpr('hypot(3,4)'), 5, 'hypot(3,4)')

console.log('▸ 变量与错误')
eq(evalExpr('ans*2', 'rad', { ans: 21 }), 42, '变量 ans')
eq(evalExpr('m+1', 'rad', { m: 4 }), 5, '变量 m')
throws(() => evalExpr('1/'), '表达式不完整 1/')
throws(() => evalExpr('foo(1)'), '未知函数 foo(1)')
throws(() => evalExpr('aa+1'), '未知名称 aa')

console.log('▸ 数字格式化')
eq(fmtNum(0.1 + 0.2), '0.3', '浮点修复 0.1+0.2')
eq(fmtNum(1 / 3), '0.333333333333', '1/3 保留 12 位有效')
eq(fmtDisplay(1234567.5), '1,234,567.5', '千分位')
eq(fmtNum(1e20), '1e20', '大数走科学计数')
eq(toBase(255, 16), 'FF', 'HEX 255')
eq(toBase(10, 2), '1010', 'BIN 10')
eq(toBase(-10, 2), '-1010', 'BIN 负数')

console.log('▸ 单位换算')
eq(convertUnit(1, 'length', '英里 mi', '千米 km'), 1.609344, '1 英里 → 千米')
eq(convertUnit(1, 'length', '英寸 in', '厘米 cm'), 2.54, '1 英寸 → 厘米')
eq(convertUnit(12, 'length', '英寸 in', '英尺 ft'), 1, '12 英寸 → 英尺')
eq(Math.round(convertUnit(100, 'temperature', '摄氏度 °C', '华氏度 °F')), 212, '100°C → °F')
eq(Math.round(convertUnit(32, 'temperature', '华氏度 °F', '摄氏度 °C')), 0, '32°F → °C')
eq(convertUnit(450, 'time', '秒 s', '分钟 min'), 7.5, '450 秒 → 分钟')
eq(Math.round(convertUnit(1.5, 'data', 'GB', 'MB')), 1536, '1.5 GB → MB')
eq(Math.round(convertUnit(1, 'mass', '千克 kg', '市斤') * 100) / 100, 2, '1 kg → 市斤')
eq(convertUnit(180, 'angle', '度 °', '弧度 rad'), Math.PI, '180° → 弧度')

console.log('')
console.log(failed === 0 ? 'ALL PASS ✅  通过 ' + passed + ' 项' : 'FAILED ❌  ' + failed + ' 项失败 / 通过 ' + passed)
process.exit(failed === 0 ? 0 : 1)
