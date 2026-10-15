const React = globalThis.React
const { useState } = React

export const name = 'hello-card'
export const inject = ['slots']

function HelloCard() {
  const [n, setN] = useState(0)
  return (
    <div style={{ fontFamily: 'var(--font-sans, sans-serif)', padding: 16, color: 'var(--dsw-label, #111)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>你好，这是 hello-card 👋</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.7 }}>
        最小示例插件：沙箱 → 打包 → 已在运行。
      </p>
      <button
        onClick={() => setN(n + 1)}
        style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsw-border, #ccc)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
      >
        点我 {n} 次
      </button>
    </div>
  )
}

export function apply(ctx: any) {
  ctx.slots.place('plugin-store-extras', HelloCard, { key: name })
}
