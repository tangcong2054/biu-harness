export type DeliverSessionChoice = {
  id: string
  title: string
  busy?: boolean
  updatedAt: number
  projectPath?: string
  projectName?: string
}

export type DeliverSessionChoices = {
  projectPath: string
  projectName: string
  sessions: DeliverSessionChoice[]
}

function folderName(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 当前打开的会话绑定了项目时，只列出这个项目里的会话；否则列出全部。 */
export function deliverSessionChoices(sessions: DeliverSessionChoice[], currentSessionId: string): DeliverSessionChoices {
  const current = currentSessionId ? sessions.find((item) => item.id === currentSessionId) : undefined
  const projectPath = current?.projectPath?.trim() ?? ''
  const projectName = current?.projectName?.trim() || (projectPath ? folderName(projectPath) : '')
  const matched = projectPath ? sessions.filter((item) => item.projectPath === projectPath) : sessions
  const sorted = [...matched].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  return { projectPath, projectName, sessions: sorted }
}

let currentSessionId = () => ''
let refreshSessions: (() => Promise<void>) | undefined

export function bindDeliverSessionSource(read: () => string, refresh?: () => Promise<void>) {
  currentSessionId = read
  refreshSessions = refresh
  return () => {
    currentSessionId = () => ''
    refreshSessions = undefined
  }
}

export function currentDeliverSessionId() {
  return currentSessionId()
}

export function refreshDeliverSessionList() {
  return refreshSessions?.() ?? Promise.resolve()
}
