export const HTML_SELECTION_MESSAGE = 'biu:page-html-selection'
export const MAX_HTML_SELECTION_CHARS = 16_000

export type HtmlSelectionMessage = {
  type: typeof HTML_SELECTION_MESSAGE
  nonce: string
  action: 'preview' | 'attach'
  text: string
  rect?: { top: number; left: number; width: number; height: number }
}

function cleanSelectionText(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').trim().slice(0, MAX_HTML_SELECTION_CHARS)
}

export function parseHtmlSelectionMessage(
  event: Pick<MessageEvent, 'source' | 'data'>,
  frame: HTMLIFrameElement | null,
  nonce: string,
): HtmlSelectionMessage | null {
  if (!frame || event.source !== frame.contentWindow) return null
  if (!event.data || typeof event.data !== 'object') return null
  const data = event.data as Record<string, unknown>
  if (data.type !== HTML_SELECTION_MESSAGE || data.nonce !== nonce) return null
  if (data.action !== 'preview' && data.action !== 'attach') return null
  const text = cleanSelectionText(data.text)
  if (!text) return null
  const raw = data.rect
  const rect =
    raw &&
    typeof raw === 'object' &&
    ['top', 'left', 'width', 'height'].every((key) =>
      Number.isFinite((raw as Record<string, unknown>)[key]),
    )
      ? {
          top: Number((raw as Record<string, unknown>).top),
          left: Number((raw as Record<string, unknown>).left),
          width: Math.max(0, Number((raw as Record<string, unknown>).width)),
          height: Math.max(0, Number((raw as Record<string, unknown>).height)),
        }
      : undefined
  return {
    type: HTML_SELECTION_MESSAGE,
    nonce,
    action: data.action,
    text,
    ...(rect ? { rect } : {}),
  }
}

/** 向 sandbox srcDoc 注入只读选区桥；不需要 allow-same-origin。 */
export function injectHtmlSelectionBridge(html: string, nonce: string) {
  const constants = JSON.stringify({ type: HTML_SELECTION_MESSAGE, nonce })
  const script = `<script data-biu-html-selection-bridge>(function(){
var cfg=${constants};
function snapshot(action,event){
  if(event&&event.isTrusted===false)return;
  var sel=window.getSelection();
  var text=sel&&!sel.isCollapsed?String(sel):'';
  text=text.replace(/\\u0000/g,'').trim().slice(0,${MAX_HTML_SELECTION_CHARS});
  if(!text)return;
  var rect={top:0,left:0,width:0,height:0};
  try{var r=sel.getRangeAt(0).getBoundingClientRect();rect={top:r.top,left:r.left,width:r.width,height:r.height}}catch(_){}
  parent.postMessage({type:cfg.type,nonce:cfg.nonce,action:action,text:text,rect:rect},'*');
}
document.addEventListener('mouseup',function(event){setTimeout(function(){snapshot('preview',event)},0)},true);
document.addEventListener('keydown',function(event){
  if(event.isComposing||event.altKey||event.shiftKey||!(event.metaKey||event.ctrlKey)||(event.key!=='l'&&event.key!=='L'))return;
  var sel=window.getSelection();
  if(!sel||sel.isCollapsed||!String(sel).trim())return;
  event.preventDefault();event.stopPropagation();snapshot('attach',event);
},true);
})();<\/script>`
  const bodyEnd = html.search(/<\/body\s*>/i)
  if (bodyEnd >= 0) return `${html.slice(0, bodyEnd)}${script}${html.slice(bodyEnd)}`
  const htmlEnd = html.search(/<\/html\s*>/i)
  if (htmlEnd >= 0) return `${html.slice(0, htmlEnd)}${script}${html.slice(htmlEnd)}`
  return `${html}${script}`
}

/** 页面块可拖拽；选字期间临时关闭祖先拖拽，结束后恢复。 */
export function suspendAncestorDrag(from: Element, target: Window = window) {
  const host = from.closest('[draggable="true"]')
  if (!host) return () => {}
  host.setAttribute('draggable', 'false')
  const restore = () => {
    host.setAttribute('draggable', 'true')
    target.removeEventListener('mouseup', restore)
    target.removeEventListener('dragend', restore)
    target.removeEventListener('blur', restore)
  }
  target.addEventListener('mouseup', restore)
  target.addEventListener('dragend', restore)
  target.addEventListener('blur', restore)
  return restore
}
