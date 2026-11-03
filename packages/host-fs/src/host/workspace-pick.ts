import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { platform } from 'node:os'

const execFileAsync = promisify(execFile)

export class DirectoryPickCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'DirectoryPickCancelled'
  }
}

export class DirectoryPickUnavailable extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DirectoryPickUnavailable'
  }
}

/** 在跑 host 的机器上弹出系统目录选择框，返回绝对路径（对齐 dsh Choose workspace）。 */
export async function pickHostDirectory(initial?: string): Promise<string> {
  const os = platform()
  if (os === 'darwin') return pickMac(initial)
  if (os === 'win32') return pickWindows(initial)
  return pickLinux(initial)
}

/** 空输出是用户取消（-128）。ERR: 才是默认目录解析失败，可以再弹一次不带默认位置的框。 */
export function macFolderPickOutcome(stdout: string): 'cancel' | 'retry' | { path: string } {
  const line = stdout.trim()
  if (!line) return 'cancel'
  if (line.startsWith('ERR:')) return 'retry'
  return { path: line.replace(/\/$/, '') }
}

async function pickMac(initial?: string) {
  // choose folder 对 default location（当前绑定的项目目录，可能是中文等非 ASCII 路径）
  // 若无法解析成 alias，会抛出 -1700 等非 -128 错误（-128 才是用户取消）。
  // 先带 default location 尝试；只有默认位置本身失败时，才退回不带默认位置再弹一次。
  // 用户取消必须停住，不能落到下一次 choose folder，否则要点两次取消。
  const options = initial
    ? [
        `set chosen to choose folder with prompt "Choose workspace" default location POSIX file ${jsonString(initial)}`,
        'set chosen to choose folder with prompt "Choose workspace"',
      ]
    : ['set chosen to choose folder with prompt "Choose workspace"']

  let lastError: unknown
  for (const openLine of options) {
    const lines = [
      'try',
      openLine,
      'return POSIX path of chosen',
      'on error errMsg number errNum',
      'if errNum is -128 then return ""',
      'return "ERR:" & errNum & ":" & errMsg',
      'end try',
    ]
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', lines.join('\n')], { timeout: 300_000 })
      const outcome = macFolderPickOutcome(stdout)
      if (outcome === 'cancel') throw new DirectoryPickCancelled()
      if (outcome === 'retry') {
        lastError = new DirectoryPickUnavailable(`osascript 目录选择失败：${stdout.trim()}`)
        continue
      }
      return outcome.path
    } catch (error) {
      if (error instanceof DirectoryPickCancelled) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError
  throw new DirectoryPickCancelled()
}

async function pickWindows(initial?: string) {
  const init = initial ? String(initial).replace(/'/g, "''") : ''
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose workspace'
$dialog.ShowNewFolderButton = $true
${init ? `$dialog.SelectedPath = '${init}'` : ''}
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
[Console]::Out.Write($dialog.SelectedPath)
`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 300_000, windowsHide: true },
    )
    const path = stdout.trim()
    if (!path) throw new DirectoryPickCancelled()
    return path
  } catch (error) {
    const err = error as { code?: number | string }
    if (err.code === 2 || err.code === '2') throw new DirectoryPickCancelled()
    throw error
  }
}

async function pickLinux(initial?: string) {
  const errors: string[] = []
  for (const attempt of [
    () =>
      execFileAsync(
        'zenity',
        ['--file-selection', '--directory', '--title=Choose workspace', ...(initial ? [`--filename=${initial}/`] : [])],
        { timeout: 300_000 },
      ),
    () =>
      execFileAsync(
        'kdialog',
        ['--getexistingdirectory', initial || process.env.HOME || '/', '--title', 'Choose workspace'],
        { timeout: 300_000 },
      ),
  ]) {
    try {
      const { stdout } = await attempt()
      const path = stdout.trim()
      if (!path) throw new DirectoryPickCancelled()
      return path
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { code?: number | string }
      if (err.code === 'ENOENT') {
        errors.push(String(err.message))
        continue
      }
      // zenity cancel → exit 1（child_process 上 code 常为 number）
      if (Number(err.code) === 1) throw new DirectoryPickCancelled()
      throw error
    }
  }
  throw new DirectoryPickUnavailable(
    `无法打开系统目录对话框（未找到 zenity/kdialog）。${errors.join('; ') || ''}请安装 zenity，或在有桌面环境的机器上运行 host。`,
  )
}

function jsonString(value: string) {
  return JSON.stringify(value)
}
