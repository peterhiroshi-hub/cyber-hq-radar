export type HostId = 'local' | string

export type GpuMetrics = {
  name: string
  utilPct: number
  vramUsedMiB: number
  vramTotalMiB: number
  tempC: number
  powerW: number
}

export type HostMetrics = {
  cpuPct: number
  ramPct: number
  ramUsedGb: number
  ramTotalGb: number
  diskPct: number
  diskFreeGb: number
  load1: number
  cores?: number
  osName?: string
  gpu?: GpuMetrics | null
}

export type HostNodeInfo = {
  id: HostId
  label: string
  role: string
  endpoint: string
  online: boolean
  isControlPlane: boolean
  activeWorkers: number
  totalWorkspaces: number
  specs: string
  metrics: HostMetrics | null
}

export type BotSquad = string
export type BotRole = 'copilot' | 'leader' | 'product' | 'delivery' | 'qa' | 'release' | 'other'

export type BotNodeInfo = {
  id: string
  name: string
  shortName: string
  squad: BotSquad
  role: BotRole
  botHost: HostId
  primaryHost: HostId
  secondaryHost: HostId | null
  targetHosts?: HostId[]
  agent: string
  state: 'working' | 'unread' | 'idle' | 'paused'
  chatsCount: number
  workspaceId: string | null
  workspacePath?: string | null
  activeDispatchCount: number
  activeSessionTitle: string | null
  activeToolName: string | null
  lastActivityAt: number | null
}

export type WorkerNodeInfo = {
  id: string
  title: string
  host: HostId
  bot: string | null
  parentBotWorkspaceId: string | null
  squad: BotSquad
  agent: string
  state: 'working' | 'permission' | 'succeeded' | 'failed' | 'stopped' | 'idle'
  branch: string | null
  workspaceId: string | null
  workspacePath: string
  sessionId: string | null
  terminalId: string | null
  sessionTitle: string | null
  activeToolName: string | null
  lastActivityAt: number | null
}

export type HqEventEntry = {
  ts: number
  kind: 'dispatch' | 'status' | 'workspace' | 'system'
  message: string
}

export type HqSnapshot = {
  generatedAt: number
  controlHostId: HostId
  controlHostLabel: string
  hosts: HostNodeInfo[]
  bots: BotNodeInfo[]
  workers: WorkerNodeInfo[]
  events: HqEventEntry[]
  summary: {
    totalBots: number
    workingBots: number
    onlineHosts: number
    activeWorkers: number
    recentWorkers: number
  }
}

export type OpenSessionInput = {
  workspaceId?: string | null
  host?: HostId | null
  terminalId?: string | null
  sessionId?: string | null
  workspacePath?: string | null
  botName?: string | null
  title?: string | null
  fallbackWorkspaceId?: string | null
}

export type OpenSessionOutput = {
  opened: boolean
  mode: 'focused' | 'opened' | 'activated' | 'fallback' | 'none'
  detail: string
}

export type SaveVideoInput = {
  base64: string
  mimeType?: string
  filename?: string
  reveal?: boolean
  uploadId?: string
  chunkIndex?: number
  totalChunks?: number
}

export type SaveVideoOutput = {
  saved: boolean
  path: string | null
  bytes: number
  format: 'mp4' | 'webm'
  chunkAccepted?: boolean
  error?: string
}

export type OpenWallOutput = {
  opened: boolean
  url: string | null
  error?: string
}

export type SaveEndpointOutput = {
  url: string | null
  token: string | null
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    'hq.getSnapshot': { output: HqSnapshot }
    'hq.refresh': { output: HqSnapshot }
    'hq.openWorkspace': { input: { workspaceId: string }; output: { opened: boolean } }
    'hq.openSession': { input: OpenSessionInput; output: OpenSessionOutput }
    'hq.saveVideo': { input: SaveVideoInput; output: SaveVideoOutput }
    'hq.getSaveEndpoint': { output: SaveEndpointOutput }
    'hq.openFullscreenWall': { output: OpenWallOutput }
  }
  interface PluginPanelEvents {
    'hq.snapshot': HqSnapshot
  }
}
