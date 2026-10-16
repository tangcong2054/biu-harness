import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MarketingHome } from './marketing-home.tsx'
import { MarketingSite } from './marketing-site/index.tsx'
import { BrandMark, resetBrandConfigCache } from './marketing-site/brand-mark.tsx'

// 品牌调节器会把配置写进 localStorage。测试之间必须隔离，
// 否则前一个用例存的颜色会污染后一个的「默认值」断言。
afterEach(() => {
  cleanup()
  localStorage.clear()
  // store 的模块级缓存不会随 localStorage 一起清，必须显式丢，
  // 否则上一条用例调过的颜色会污染下一条的「默认值」断言。
  resetBrandConfigCache()
})

function renderSite(initialPath = '/') {
  let login = 0
  let start = 0
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MarketingSite
        onLogin={() => { login += 1 }}
        onStart={() => { start += 1 }}
      />
    </MemoryRouter>,
  )
  return { login: () => login, start: () => start }
}

test('landing page embeds real empty product surfaces and opens account actions', () => {
  let login = 0
  let start = 0
  render(
    <MemoryRouter>
      <MarketingHome onLogin={() => { login += 1 }} onStart={() => { start += 1 }} />
    </MemoryRouter>,
  )

  assert.match(screen.getByRole('heading', { level: 1 }).textContent ?? '', /一个页面.*组合所有软件/)

  // P0-13：演示区用静态截图，不再嵌 iframe（iframe 会完整加载 web 应用三次）
  assert.equal(screen.queryByTitle('BIU 页面界面预览'), null, '不应再有 iframe 预览')

  const video = document.querySelector('video.site-demo-shot') as HTMLVideoElement
  assert.ok(video, '默认标签是「页面」录屏')
  assert.equal(video.getAttribute('poster'), '/site/demo-allinone.webp')
  assert.deepEqual(Array.from(video.querySelectorAll('source')).map((s) => s.getAttribute('src')), ['/site/demo-allinone.webm', '/site/demo-allinone.mp4'])
  assert.ok(video.muted && video.loop, '自动播放的录屏必须静音循环')

  fireEvent.click(screen.getByRole('tab', { name: '插件' }))
  const shot = screen.getByRole('img', { name: /BIU 插件/ }) as HTMLImageElement
  assert.equal(shot.getAttribute('src'), '/site/shot-plugins.webp')
  assert.equal(shot.getAttribute('loading'), 'lazy')
  const tablist = screen.getByRole('tablist', { name: '产品演示' })
  assert.deepEqual(
    Array.from(tablist.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
    ['页面', '插件', '分享', '组件', '数据', '引用'],
  )
  const caption = document.querySelector('.site-demo-lead')!
  assert.ok(tablist.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING, '说明文字在切换按钮下面')
  assert.ok(caption.compareDocumentPosition(document.querySelector('.site-demo-shot')!) & Node.DOCUMENT_POSITION_FOLLOWING, '说明文字在画面上面')
  assert.equal(document.querySelector('.site-product-demo h3'), null, '说明文字不带标题')
  const lead = () => document.querySelector('.site-demo-lead')?.textContent ?? ''
  const leads = new Set<string>()
  for (const [tab, src] of [['组件', 'demo-component'], ['数据', 'demo-file-system'], ['引用', 'demo-context']] as const) {
    fireEvent.click(screen.getByRole('tab', { name: tab }))
    assert.doesNotMatch(lead(), /算法面试陪跑/, `切到「${tab}」后说明文字要跟着换`)
    leads.add(lead())
    const img = document.querySelector('img.site-demo-shot') as HTMLImageElement
    assert.equal(img.getAttribute('src'), `/site/${src}.webp`, `「${tab}」用回原来那张真实截图`)
    assert.equal(img.getAttribute('width'), '3840')
  }
  assert.equal(leads.size, 3, '每个标签有自己的说明')
  fireEvent.click(screen.getByRole('tab', { name: '组件' }))
  assert.match(lead(), /散落.*重新收集.*结构化/, '组件说明讲的是把散在各页的插件收集成结构化的表')

  const wall = screen.getByRole('region', { name: '插件' })
  assert.ok(wall.querySelectorAll('article').length >= 8, '首页插件墙列出现成的插件')
  assert.match(wall.textContent ?? '', /Excalidraw/)

  fireEvent.click(screen.getByTestId('site-login'))
  assert.equal(login, 1)
  assert.equal(start, 0)
  fireEvent.click(screen.getByRole('button', { name: '开始使用' }))
  assert.equal(start, 1, '首屏主行动是「开始使用」')
  cleanup()
})

test('home 收窄后：深度内容下沉，导航指向独立页', () => {
  renderSite('/')
  // 原首页的 6 张解决方案卡已移到 /use-cases
  assert.equal(screen.queryByText('研究与分析'), null)
  // 导航里有独立页面入口
  const print = screen.getByTestId('site-print')
  const tile = print.querySelector('pattern')
  assert.ok(tile, '官网背景用重复图案铺满')
  assert.equal(tile?.getAttribute('width'), '42')
  assert.equal(tile?.getAttribute('height'), '42')
  assert.equal(tile?.querySelector('rect'), null, '印花只要圆，不要圆角方底')
  const base = print.querySelector('[data-print-layer="base"]') as SVGSVGElement
  const columns = [...base.querySelectorAll('rect[data-print-column]')]
  const alphas = columns.map((rect) => Number(rect.getAttribute('opacity')))
  assert.ok(alphas.length > 10, '印花按列切条，每列一个透明度')
  const middle = Math.min(...alphas)
  assert.ok(middle >= 0.15 && middle < 0.3, '中线那列最淡，但仍然看得见')
  assert.equal(Math.max(alphas[0], alphas[alphas.length - 1]), 1, '最外侧一列不打折')
  const left = alphas.slice(0, alphas.indexOf(middle) + 1)
  assert.ok(left.every((alpha, i) => i === 0 || alpha <= left[i - 1]), '从左缘到中线逐列变淡')
  const levels = columns.map((rect) => Number(rect.getAttribute('data-print-level')))
  assert.equal(levels[alphas.indexOf(middle)], 0, '中线那列标记最小')
  assert.equal(Math.max(levels[0], levels[levels.length - 1]), 4, '最外侧一列是原尺寸')
  const fills = [...base.querySelectorAll('path[fill]')].map((path) => path.getAttribute('fill') ?? '')
  assert.ok(fills.length > 0 && fills.every((fill) => /^#([0-9a-f]{2})\1\1$/i.test(fill) || fill === 'none'), '底层印花是同色系的灰')
  const nav = screen.getByRole('navigation', { name: '官网' })
  assert.match(nav.textContent ?? '', /产品/)
  assert.match(nav.textContent ?? '', /场景/)
  // 首页主张：All in One —— 页面组合软件
  assert.match(screen.getByRole('heading', { level: 1 }).textContent ?? '', /组合所有软件/)
  cleanup()
})

test('印花随滚动向上走，速度慢于正文，并按格子循环', async () => {
  renderSite('/product')
  const print = screen.getByTestId('site-print')
  const root = print.closest('.site') as HTMLElement
  root.scrollTop = 100
  fireEvent.scroll(root)
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  assert.equal(print.style.getPropertyValue('--print-shift'), '-35px', '滚 100px，印花走 35px')
  root.scrollTop = 200
  fireEvent.scroll(root)
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  assert.equal(print.style.getPropertyValue('--print-shift'), '-28px', '走过一格后从头循环（70 mod 42）')
  cleanup()
})

test('鼠标聚光：彩色层只在鼠标附近露出，触屏不触发', async () => {
  renderSite('/product')
  const print = screen.getByTestId('site-print')
  const spot = screen.getByTestId('site-print-spot')
  const root = print.closest('.site') as HTMLElement
  const columns = [...spot.querySelectorAll('rect[data-print-column]')]
  assert.ok(columns.length > 0 && columns.every((rect) => rect.getAttribute('opacity') === '1'), '彩色层不再叠透明度渐变')
  fireEvent.pointerMove(root, { pointerType: 'touch', clientX: 10, clientY: 10 })
  assert.equal(print.dataset.spot, undefined, '触屏没有悬停，不点亮')
  fireEvent.pointerMove(root, { pointerType: 'mouse', clientX: 300, clientY: 200 })
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  assert.equal(print.dataset.spot, 'on')
  assert.equal(print.style.getPropertyValue('--spot-x'), '300px')
  assert.equal(print.style.getPropertyValue('--spot-y'), '200px')
  fireEvent.pointerLeave(root)
  assert.equal(print.dataset.spot, undefined, '鼠标离开后熄灭')
  cleanup()
})

test('每个官网路径都能渲染，且各页有独立 h1', () => {
  const cases: Array<[string, RegExp]> = [
    ['/product', /页面是容器，插件是软件/],
    ['/use-cases', /为真实工作而生/],
  ]
  for (const [path, pattern] of cases) {
    renderSite(path)
    assert.match(screen.getByRole('heading', { level: 1 }).textContent ?? '', pattern, `path=${path}`)
    cleanup()
  }
})

test('定位：All in One，文案不夸大', () => {
  renderSite('/')
  const body = document.body.textContent ?? ''
  assert.match(body, /开源 · 免费 · All in One/)
  assert.equal(document.querySelector('.site-task-box'), null, '首页不再放会丢掉输入的任务框')
  assert.doesNotMatch(body, /BIU 团队/, '不放团队自述冒充用户证言')
  cleanup()
})

test('未知路径不 404 空白，给出诚实占位', () => {
  renderSite('/not-a-real-page')
  assert.match(screen.getByRole('heading', { level: 1 }).textContent ?? '', /这一页还没建/)
  cleanup()
})

test('每页写入独立的 title / description / canonical（规划 §7.2）', () => {
  const cases: Array<[string, RegExp]> = [
    ['/product', /产品 · BIU/],
    ['/use-cases', /场景 · BIU/],
  ]
  for (const [path, pattern] of cases) {
    renderSite(path)
    assert.match(document.title, pattern, `path=${path} 的 title`)
    const desc = document.head.querySelector('meta[name="description"]')
    assert.ok(desc && (desc.getAttribute('content') ?? '').length > 10, `path=${path} 的 description`)
    const canonical = document.head.querySelector('link[rel="canonical"]')
    assert.ok(canonical, `path=${path} 的 canonical`)
    cleanup()
  }
})

test('品牌标记：小尺寸下线条不缩成亚像素（毛边的来源）', () => {
  // 线条在 viewBox 单位里表达，缩到 24px 会变成 0.1~0.3 屏幕像素 ——
  // 浏览器画不了零点几像素的线，只能抗锯齿糊过去，就出现毛边。
  // displayWidth 用来兜住这件事：任何尺寸下线都不低于 1 屏幕像素。
  const cases: Array<[number, number]> = [
    [3, 24], [7.5, 24], [12, 24], [3, 240], [7.5, 240], [20, 240],
  ]
  for (const [width, display] of cases) {
    const { unmount } = render(<BrandMark strokeWidth={width} lineWidth={width} displayWidth={display} />)
    const svg = screen.getByRole('img')
    const vbSize = Number(svg.getAttribute('viewBox')!.split(/\s+/)[2])
    const onScreen = (el: Element) =>
      (Number(el.getAttribute('stroke-width')) / vbSize) * display
    for (const el of Array.from(svg.querySelectorAll('[stroke-width]'))) {
      assert.ok(
        onScreen(el) >= 0.999,
        `线宽 ${width} 在 ${display}px 下只有 ${onScreen(el).toFixed(2)} 屏幕像素，会糊`,
      )
    }
    unmount()
    cleanup()
  }
})

test('品牌标记：粗细为 0 时原样输出（不被可见性保底顶回去）', () => {
  // 用户要隐藏线条时，不该被最小可见宽度救回来。
  render(
    <BrandMark strokeWidth={0} lineWidth={0} scene="icon" />,
  )
  for (const w of Array.from(screen.getByRole('img').querySelectorAll('[stroke-width]')).map((n) => n.getAttribute('stroke-width'))) {
    assert.equal(w, '0', '图标场景下 0 也必须是 0')
  }
  cleanup()
})

test('品牌标记：两块是 B 的两弧、半圆是 U，方位与明度都不能改错', () => {
  render(<BrandMark colors={['#1e3a8a', '#0ea5e9', '#0f172a']} />)
  const svg = screen.getByRole('img')
  const paths = Array.from(svg.querySelectorAll('path[fill]'))
  assert.equal(paths.length, 3)

  // 每块的「结束边」角度决定它落在画面哪一侧，借此钉住 B/I/U 的方位。
  // 这是标记的全部意义所在 —— 位置错了就不是 BIU 了。
  const endAngle = (i: number) => {
    const m = paths[i]!.getAttribute('d')!.match(/A [\d.]+ [\d.]+ 0 \d 1 ([\d.]+) ([\d.]+)/)
    assert.ok(m, '扇区应有弧线')
    return Math.round(Math.atan2(Number(m![2]) - 615, Number(m![1]) - 450) * 180 / Math.PI)
  }
  assert.equal(endAngle(0), -39, 'colors[0] 应结束于 -39°（B 的上弧）')
  assert.equal(endAngle(1), 52, 'colors[1] 应结束于 52°（B 的下弧）')
  assert.equal(endAngle(2), -127, 'colors[2] 应结束于 -127°（左下半圆 = U）')

  // 默认是「深海」三色，与标签页图标同一套
  const fills = paths.map((n) => n.getAttribute('fill')!)
  assert.deepEqual(
    fills.map((f) => f.toLowerCase()),
    ['#1e3a8a', '#0ea5e9', '#0f172a'],
    `默认应为深海三色，实际：${fills.join(' / ')}`,
  )
  cleanup()
})

test('标签页图标、README 横条、分享卡片都是当前品牌标记（深海配色），与默认配置同步', async () => {
  const { buildFaviconSvg, buildLockupSvg, buildOgImageSvg } = await import('./marketing-site/brand-assets.tsx')
  const { BRAND_DEFAULT } = await import('./marketing-site/brand-mark.tsx')
  assert.equal(BRAND_DEFAULT.strokeWidth, 0, '默认不画圆的描边')
  assert.equal(BRAND_DEFAULT.lineWidth, 0, '默认不画分割线')
  assert.equal(BRAND_DEFAULT.circleRatio, 0.7)
  const read = (name: string) => readFileSync(resolve(process.cwd(), 'public', name), 'utf8')
  const hint = '过期了：npx tsx scripts/build-brand-assets.tsx'
  assert.equal(read('favicon.svg'), buildFaviconSvg(), `favicon.svg ${hint}`)
  assert.equal(read('brand-lockup.svg'), buildLockupSvg(), `brand-lockup.svg ${hint}`)
  assert.equal(read('og-image.svg'), buildOgImageSvg(), `og-image.svg ${hint}`)
  for (const name of ['favicon.svg', 'brand-lockup.svg', 'og-image.svg']) {
    for (const color of ['#1e3a8a', '#0ea5e9', '#0f172a']) assert.match(read(name), new RegExp(`fill="${color}"`), `${name} 应为深海配色`)
  }
  const png = readFileSync(resolve(process.cwd(), 'public/og-image.png'))
  assert.equal(png.readUInt32BE(16), 1200, '分享卡片宽 1200')
  assert.equal(png.readUInt32BE(20), 630, '分享卡片高 630')

  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg/)
  assert.match(html, /<meta property="og:image" content="\/og-image\.png" \/>/, '爬虫不执行脚本，og:image 要写在静态 HTML 里')
  const meta = readFileSync(resolve(process.cwd(), 'packages/web-app-shell/src/web/marketing-site/use-page-meta.ts'), 'utf8')
  assert.match(meta, /DEFAULT_IMAGE = '\/og-image\.png'/)
})

test('场景页：卡片写明组合了哪些块，团队协作说明云端现状', () => {
  renderSite('/use-cases')
  const chips = document.querySelectorAll('.site-usecase-card .site-block-chips')
  assert.ok(chips.length >= 6, '每张场景卡都列出组合的块')
  cleanup()
  renderSite('/use-cases/collaboration')
  assert.ok(screen.getByRole('heading', { name: '这一页里组合了哪些块' }))
  assert.match(document.querySelector('.site-usecase-note')?.textContent ?? '', /官方云端服务即将上线/)
  cleanup()
})

test('产品页：每个板块配一张真实截图', () => {
  renderSite('/product')
  const images = Array.from(document.querySelectorAll('.site-block-media img'))
  assert.ok(images.length >= 6)
  assert.ok(images.every((img) => /^\/site\/shot-.+\.webp$/.test(img.getAttribute('src') ?? '')), '截图统一用 webp')
  cleanup()
})



