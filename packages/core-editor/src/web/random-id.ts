function fillRandomBytes() {
  const bytes = new Uint8Array(16)
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

function uuidFromBytes(bytes: Uint8Array) {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `http://` 局域网地址不是安全上下文，`crypto.randomUUID` 不存在。 */
export function randomUUID(): string {
  const cryptoObj = globalThis.crypto
  const native = cryptoObj?.randomUUID
  if (typeof native === 'function') {
    try {
      return native.call(cryptoObj)
    } catch {
      /* 非安全上下文里有的浏览器会直接抛 */
    }
  }
  return uuidFromBytes(fillRandomBytes())
}

/** 让插件里直接写的 `crypto.randomUUID()` 在局域网分享页也能用。 */
export function installInsecureRandomUUID() {
  const cryptoObj = globalThis.crypto
  if (!cryptoObj) return
  if (typeof cryptoObj.randomUUID === 'function') {
    try {
      cryptoObj.randomUUID()
      return
    } catch {
      /* 换成不依赖安全上下文的实现 */
    }
  }
  const value = () => uuidFromBytes(fillRandomBytes())
  try {
    Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, writable: true, value })
  } catch {
    try {
      cryptoObj.randomUUID = value
    } catch {
      /* 调用方改走 randomUUID() */
    }
  }
}
