/**
 * 叠放式幻灯片的桥。
 *
 * 有些 htmlframe 块内部自己就是一叠「幻灯片」：一堆绝对定位、靠 opacity / .on 类切换的
 * 兄弟节点（典型如 window.DECK + section.s）。整块只当 1 页的话，这些叠着的页面永远放不出来。
 *
 * 这里往块内注入一小段脚本，让它：
 *   1) 自报「一共几页 / 现在第几页」（postMessage 给父页）；
 *   2) 接受父页指令翻到指定页（优先调 window.__phpDeckPage.goto，否则合成键盘事件）；
 *   3) 把块内的方向键 / Esc 上报父页，并吃掉自己的默认处理，避免父页与块内各翻一次。
 *
 * 块内如愿意可自己声明 window.__phpDeckPage = { total, page, goto(n) } 来接管，
 * 比启发式探测准。探测靠三条：显式 API > window.DECK（配合同级堆叠数）> 同级绝对定位堆叠。
 */

export const BRIDGE_FLAG = 'data-php-deck-bridge'

/** 桥脚本本体。注意：写在模板字面量里，正则的 \\s 必须写成 \\\\s，且不能用反引号与 ${。 */
export const BRIDGE_SOURCE = `
(function () {
  var synthetic = false
  function stackGroup() {
    var all = document.querySelectorAll('*')
    if (all.length > 5000) return []
    var buckets = []
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      var par = el.parentElement
      if (!par) continue
      var cs
      try { cs = getComputedStyle(el) } catch (e) { continue }
      if (cs.position !== 'absolute') continue
      if (el.offsetWidth < 40 || el.offsetHeight < 40) continue
      var hit = null
      for (var j = 0; j < buckets.length; j++) {
        if (buckets[j].par === par) { hit = buckets[j]; break }
      }
      if (!hit) { hit = { par: par, list: [] }; buckets.push(hit) }
      hit.list.push(el)
    }
    var best = []
    for (var k = 0; k < buckets.length; k++) {
      if (buckets[k].list.length > best.length) best = buckets[k].list
    }
    return best
  }
  function pageOf(list) {
    var i
    for (i = 0; i < list.length; i++) {
      var cl = list[i].classList
      if (!cl) continue
      if (cl.contains('on') || cl.contains('active') || cl.contains('current') || cl.contains('is-active')) return i
    }
    for (i = 0; i < list.length; i++) {
      var cs = getComputedStyle(list[i])
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (parseFloat(cs.opacity || '1') > 0.5) return i
    }
    return -1
  }
  function clamp(n, limit) {
    if (n < 0) return 0
    if (n > limit - 1) return limit - 1
    return n
  }
  /**
   * 把「最大堆叠簇」收窄成真正的一叠幻灯片。
   * 簇里常混进 stage / bar 之类无关的绝对定位兄弟（它们的 tagName 与幻灯片不同），
   * 按「标签名占多数」过滤后，剩下的才是幻灯片。
   */
  function slideGroup() {
    var group = stackGroup()
    if (group.length < 2) return group
    var counts = {}
    var bestTag = null
    var bestN = 0
    for (var i = 0; i < group.length; i++) {
      var t = group[i].tagName
      counts[t] = (counts[t] || 0) + 1
      if (counts[t] > bestN) { bestN = counts[t]; bestTag = t }
    }
    if (bestN < 2) return group
    var out = []
    for (var j = 0; j < group.length; j++) {
      if (group[j].tagName === bestTag) out.push(group[j])
    }
    return out.length >= 2 ? out : group
  }
  function info() {
    var api = window.__phpDeckPage
    if (api && typeof api.total === 'number') {
      var t = Math.max(1, api.total | 0)
      return { total: t, page: currentPage(t) }
    }
    try {
      var D = window.DECK || {}
      var arr = D.slides || D.deck
      if (Object.prototype.toString.call(arr) === '[object Array]' && arr.length) {
        return { total: arr.length, page: currentPage(arr.length) }
      }
    } catch (e) {}
    var group = slideGroup()
    if (group.length >= 2) return { total: group.length, page: currentPage(group.length) }
    return { total: 1, page: 0 }
  }
  /*
   * 目标页与收敛重试。
   *
   * PPT 有转场动画，转场中「从 DOM 读回的页码」是旧值；快按时单次合成按键还会被丢掉。
   * 所以不一次性算步数，改成：记下目标页，反复「回读实际页 → 没到位就再补一次」，
   * 直到到位或超过重试上限。这样慢按/快按都收敛。
   */
  var want = null
  var tries = 0
  var totalGuess = 1
  var MAX_TRIES = 12
  /* 父页告知：本次放映是否是多块连放。单页块在多块连放里也要交出按键（否则没法翻到下一块）。 */
  var deckMulti = false

  function derivedPage(total) {
    var api = window.__phpDeckPage
    if (api && typeof api.page === 'number') return clamp(api.page | 0, total)
    try {
      var D = window.DECK || {}
      var arr = D.slides || D.deck
      if (Object.prototype.toString.call(arr) === '[object Array]' && arr.length) {
        var g1 = slideGroup()
        return g1.length >= 2 ? clamp(pageOf(g1), total) : 0
      }
    } catch (e) {}
    var group = slideGroup()
    if (group.length >= 2) return clamp(pageOf(group), total)
    return 0
  }

  /** 对外报的页码：有在途目标就先认它，页面的即时响应不依赖转场结束。 */
  function currentPage(total) {
    if (want != null) return clamp(want, total)
    return derivedPage(total)
  }

  function ensure() {
    if (want == null) return
    var total = Math.max(1, totalGuess | 0)
    var actual = derivedPage(total)
    if (actual === want) {
      want = null
      tries = 0
      report()
      return
    }
    if (tries >= MAX_TRIES) {
      want = null
      tries = 0
      report()
      return
    }
    tries++
    var api = window.__phpDeckPage
    if (api && typeof api.goto === 'function') {
      try { api.goto(want) } catch (e) { key(want > actual ? 'ArrowRight' : 'ArrowLeft') }
    } else {
      key(want > actual ? 'ArrowRight' : 'ArrowLeft')
    }
    setTimeout(ensure, 160)
  }

  function key(k) {
    synthetic = true
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) } catch (e) {}
    synthetic = false
  }

  function report() {
    var i = info()
    try { parent.postMessage({ __phpDeckInfo: 1, total: i.total, page: i.page }, '*') } catch (e) {}
  }

  /** 设目标页并开始收敛。 */
  function go(target) {
    var cur = info()
    var total = cur.total
    totalGuess = total
    if (target < 0) target = 0
    if (target > total - 1) target = total - 1
    if (target === cur.page) { report(); return }
    want = target
    tries = 0
    report()
    ensure()
  }

  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || !d.__phpDeckCmd) return
    var c = d.__phpDeckCmd
    if (c === 'info') { report(); return }
    if (c === 'cfg') {
      deckMulti = !!d.multi
      report()
      return
    }
    if (c === 'goto') {
      go(typeof d.page === 'number' ? d.page : 0)
    } else if (c === 'next' || c === 'prev' || c === 'first' || c === 'last') {
      var i = info()
      go(c === 'next' ? i.page + 1 : c === 'prev' ? i.page - 1 : c === 'first' ? 0 : i.total - 1)
    } else {
      return
    }
    setTimeout(report, 80)
  })
  /*
   * 块内按键：只在「本块确实是一叠多页」时才接管，否则放行。
   * 否则单页的工具型块（表单 / 交互应用）在放映时会被吞掉空格、方向键。
   */
  document.addEventListener('keydown', function (e) {
    if (synthetic) return
    /* 只有「本块多页」或「多块连放」时才接管按键，否则放行给块内（表单 / 交互应用） */
    if (info().total <= 1 && !deckMulti) return
    var k = e.key
    var c = null
    if (k === 'Escape') c = 'close'
    else if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown') c = 'next'
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') c = 'prev'
    else if (k === 'Home') c = 'first'
    else if (k === 'End') c = 'last'
    if (!c) return
    e.preventDefault()
    e.stopPropagation()
    try { parent.postMessage({ __phpDeckKey: c }, '*') } catch (er) {}
  }, true)
  report()
  window.addEventListener('load', report)
  var n = 0
  var iv = setInterval(function () { report(); if (++n > 16) clearInterval(iv) }, 250)
  window.__phpDeckBridgePing = report
})()
`

const OPEN_TAG = '<' + 'script ' + BRIDGE_FLAG + '="1">'
const CLOSE_TAG = '<' + '/script>'

/** 把桥注入一段完整 HTML。已注入过则原样返回。 */
export function injectDeckBridge(html: string): string {
  const source = typeof html === 'string' ? html : ''
  if (!source || source.indexOf(BRIDGE_FLAG) >= 0) return source
  const tag = OPEN_TAG + BRIDGE_SOURCE + CLOSE_TAG
  const body = source.search(/<\/body\s*>/i)
  if (body >= 0) return source.slice(0, body) + tag + source.slice(body)
  const doc = source.search(/<\/html\s*>/i)
  if (doc >= 0) return source.slice(0, doc) + tag + source.slice(doc)
  return source + tag
}

/**
 * 离屏放一个同内容的 iframe，问它自己有分几页。返回 >=1 的页数；探测不到按 1 页算。
 */
export function probeDeckPages(html: string, timeout = 1200): Promise<number> {
  if (typeof document === 'undefined') return Promise.resolve(1)
  const source = injectDeckBridge(html)
  return new Promise<number>((resolve) => {
    let frame: HTMLIFrameElement | null = null
    let done = false
    const finish = (n: number) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      try {
        frame?.remove()
      } catch {
        /* 忽略 */
      }
      frame = null
      resolve(Math.max(1, Math.round(n) || 1))
    }
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { __phpDeckInfo?: number; total?: number } | null
      if (data && data.__phpDeckInfo && typeof data.total === 'number') finish(data.total)
    }
    window.addEventListener('message', onMessage)
    try {
      frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.style.cssText =
        'position:fixed;left:-12000px;top:0;width:960px;height:540px;border:0;visibility:hidden;pointer-events:none'
      frame.addEventListener('load', () => {
        try {
          frame?.contentWindow?.postMessage({ __phpDeckCmd: 'info' }, '*')
        } catch {
          /* 忽略 */
        }
      })
      frame.srcdoc = source
      document.body.appendChild(frame)
    } catch {
      finish(1)
      return
    }
    window.setTimeout(() => finish(1), timeout)
  })
}

/** 给 iFrame 发一条指令。 */
export function sendDeckCommand(frame: HTMLIFrameElement | null | undefined, cmd: string, page?: number) {
  if (!frame) return
  try {
    frame.contentWindow?.postMessage(page == null ? { __phpDeckCmd: cmd } : { __phpDeckCmd: cmd, page }, '*')
  } catch {
    /* 忽略 */
  }
}
