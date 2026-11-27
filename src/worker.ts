import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  BotNodeInfo,
  BotRole,
  BotSquad,
  GpuMetrics,
  HostId,
  HostMetrics,
  HostNodeInfo,
  HqEventEntry,
  HqSnapshot,
  OpenSessionInput,
  OpenSessionOutput,
  OpenWallOutput,
  SaveVideoInput,
  SaveVideoOutput,
  WorkerNodeInfo
} from './protocol'

function execFileAsync(
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; env?: Record<string, string | undefined> } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export type CliRunner = (args: string[]) => Promise<unknown | null>
export type RelayCliRunner = (hubSshTarget: string, args: string[]) => Promise<unknown | null>
export type MetricsRunner = (hostId: string, sshTarget?: string | null, hubSshTarget?: string | null) => Promise<HostMetrics | null>
export type VideoSaver = (input: SaveVideoInput) => Promise<SaveVideoOutput>
export type WallOpener = (url: string) => Promise<boolean>

export type HubRelayTarget = {
  baseUrl: string
  token: string
}

export type HubRelayChildPayload = {
  env?: RawEnv
  envName?: string
  ok?: boolean
  workers?: RawRemoteWorker[]
  remotePs?: RawWorktreePs[]
  metrics?: HostMetrics | null
}

export type HubRelaySnapshotPayload = {
  ok?: boolean
  host?: { hostname?: string; metrics?: HostMetrics | null }
  children?: HubRelayChildPayload[]
}

export type HubRelayClient = {
  fetchSnapshot: (target: HubRelayTarget) => Promise<HubRelaySnapshotPayload | null>
  activateWorktree: (target: HubRelayTarget, host: string, selector: string) => Promise<boolean>
}

export type PluginConfig = {
  controlEnvironment: string
  sshTargets: Record<string, string>
  hubRelays: Record<string, HubRelayTarget>
  showLocalHost: boolean
  pollIntervalSec: number
}

export function parseHubRelays(raw: string | undefined | null): Record<string, HubRelayTarget> {
  const out: Record<string, HubRelayTarget> = {}
  if (!raw) return out
  for (const part of String(raw).split(/[,;\n]/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const rest = trimmed.slice(eq + 1).trim()
    const sepIdx = rest.includes('#') ? rest.indexOf('#') : rest.indexOf('|')
    if (sepIdx <= 0) continue
    const baseUrl = rest.slice(0, sepIdx).trim().replace(/\/+$/, '')
    const token = rest.slice(sepIdx + 1).trim()
    if (!key || !token || !/^https?:\/\/[^/\s]+/i.test(baseUrl)) continue
    const entry: HubRelayTarget = { baseUrl, token }
    out[key] = entry
    out[key.toLowerCase()] = entry
  }
  return out
}

function httpJsonRequest(
  url: string,
  method: 'GET' | 'POST',
  token: string,
  bodyObj?: unknown,
  timeoutMs = 5500
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const isHttps = url.toLowerCase().startsWith('https://')
    const mod = isHttps ? https : http
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
    if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.from(bodyStr, 'utf8').length)
    }
    let settled = false
    const done = (val: unknown | null) => {
      if (settled) return
      settled = true
      resolve(val)
    }
    try {
      const req = mod.request(url, { method, headers, timeout: timeoutMs }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          done(null)
          return
        }
        let raw = ''
        let total = 0
        res.on('data', (chunk) => {
          const s = typeof chunk === 'string' ? chunk : String(chunk)
          total += s.length
          if (total > 8 * 1024 * 1024) {
            done(null)
            return
          }
          raw += s
        })
        res.on('end', () => {
          try {
            done(raw ? JSON.parse(raw) : null)
          } catch {
            done(null)
          }
        })
      })
      req.on('error', () => done(null))
      req.on('timeout', () => {
        try { req.destroy() } catch {}
        done(null)
      })
      if (bodyStr !== null) req.write(bodyStr)
      req.end()
    } catch {
      done(null)
    }
  })
}

export const defaultHubRelayClient: HubRelayClient = {
  async fetchSnapshot(target) {
    const res = await httpJsonRequest(`${target.baseUrl}/v1/relay-snapshot`, 'GET', target.token, undefined, 6000)
    return res && typeof res === 'object' ? (res as HubRelaySnapshotPayload) : null
  },
  async activateWorktree(target, host, selector) {
    const res = await httpJsonRequest(
      `${target.baseUrl}/v1/activate-worktree`,
      'POST',
      target.token,
      { host, selector },
      4500
    )
    return Boolean(res && (res as { activated?: boolean }).activated)
  }
}

export function parseSshTargets(raw: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const part of String(raw).split(/[,;\n]/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && val) {
      out[key] = val
      out[key.toLowerCase()] = val
    }
  }
  return out
}

function lookupSshTarget(cfg: PluginConfig, envName: string, endpointHost: string | null): string {
  return cfg.sshTargets[envName] || cfg.sshTargets[envName.toLowerCase()] || endpointHost || envName
}

export function defaultOrcaBin(): string {
  return process.env.ORCA_CLI_COMMAND || '/Applications/Orca.app/Contents/Resources/bin/orca'
}

export async function runOrcaCliJson(args: string[]): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync(defaultOrcaBin(), args, {
      timeout: 4500,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env }
    })
    const trimmed = stdout.trim()
    if (!trimmed) return null
    const parsed = JSON.parse(trimmed) as { ok?: boolean; result?: unknown }
    return parsed && parsed.ok !== false ? (parsed.result ?? parsed) : null
  } catch {
    return null
  }
}

export async function runRelayedOrcaCliJson(hubSshTarget: string, args: string[]): Promise<unknown | null> {
  if (!hubSshTarget || !/^[a-zA-Z0-9._@-]+$/.test(hubSshTarget)) return null
  if (!args.every((a) => /^[a-zA-Z0-9._:/@-]+$/.test(a))) return null
  const quotedArgs = args.map((a) => `'${a}'`).join(' ')
  const cmd = `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; ORCA=$(command -v orca 2>/dev/null || echo /Applications/Orca.app/Contents/Resources/bin/orca); "$ORCA" ${quotedArgs}`
  try {
    const { stdout } = await execFileAsync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=2',
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPersist=120',
        '-o', 'ControlPath=/tmp/orca-hq-ssh-%C',
        hubSshTarget,
        cmd
      ],
      { timeout: 6000, maxBuffer: 4 * 1024 * 1024 }
    )
    const trimmed = stdout.trim()
    if (!trimmed) return null
    const parsed = JSON.parse(trimmed) as { ok?: boolean; result?: unknown }
    return parsed && parsed.ok !== false ? (parsed.result ?? parsed) : null
  } catch {
    return null
  }
}

export async function defaultWallOpener(url: string): Promise<boolean> {
  const chromeApp = '/Applications/Google Chrome.app'
  try {
    await fs.access(chromeApp)
    await execFileAsync(
      'open',
      ['-na', 'Google Chrome', '--args', `--app=${url}`, '--start-fullscreen'],
      { timeout: 4000 }
    )
    return true
  } catch {
    try {
      await execFileAsync('open', [url], { timeout: 4000 })
      return true
    } catch {
      return false
    }
  }
}

export function stripBase64DataUrl(input: string | undefined | null): string {
  return String(input || '').replace(/^data:[^,]*;base64,/i, '').trim()
}

export async function defaultVideoSaver(input: SaveVideoInput): Promise<SaveVideoOutput> {
  const isMp4 = (input.mimeType || '').toLowerCase().includes('mp4')
  const format: 'mp4' | 'webm' = isMp4 ? 'mp4' : 'webm'
  const rawBase64 = stripBase64DataUrl(input.base64)
  if (!rawBase64) {
    return { saved: false, path: null, bytes: 0, format, error: 'Empty video payload' }
  }
  const bytesBuf = Buffer.from(rawBase64, 'base64')
  if (bytesBuf.length === 0 || bytesBuf.length > 64 * 1024 * 1024) {
    return { saved: false, path: null, bytes: bytesBuf.length, format, error: 'Video size out of bounds' }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const cleanName = input.filename
    ? path.basename(input.filename).replace(/[^a-zA-Z0-9._-]/g, '_')
    : `cyber-hq-radar-${stamp}.${format}`
  const finalName = cleanName.endsWith(`.${format}`) ? cleanName : `${cleanName}.${format}`
  const downloadsDir = path.join(os.homedir(), 'Downloads')
  await fs.mkdir(downloadsDir, { recursive: true })
  const outPath = path.join(downloadsDir, finalName)
  await fs.writeFile(outPath, bytesBuf)
  if (input.reveal !== false && os.platform() === 'darwin') {
    await execFileAsync('open', ['-R', outPath], { timeout: 3000 }).catch(() => null)
  }
  return { saved: true, path: outPath, bytes: bytesBuf.length, format }
}

export async function collectLocalMetrics(): Promise<HostMetrics | null> {
  try {
    const plat = os.platform()
    const totalBytes = os.totalmem()
    const totalGb = Number((totalBytes / 1024 ** 3).toFixed(1))
    const load1 = Number((os.loadavg()[0] || 0).toFixed(2))
    const cores = Math.max(1, os.cpus().length)

    if (plat === 'darwin') {
      const [topRes, vmRes, dfRes] = await Promise.all([
        execFileAsync('top', ['-l', '2', '-n', '0', '-s', '0'], { timeout: 3000 }).catch(() => null),
        execFileAsync('vm_stat', [], { timeout: 2000 }).catch(() => null),
        execFileAsync('df', ['-k', '/System/Volumes/Data'], { timeout: 2000 })
          .catch(() => execFileAsync('df', ['-k', '/'], { timeout: 2000 }))
          .catch(() => null)
      ])

      let cpuPct = Math.min(100, Math.round((load1 / cores) * 100))
      if (topRes?.stdout) {
        const matches = [...topRes.stdout.matchAll(/CPU usage:\s*[\d.]+%\s*user,\s*[\d.]+%\s*sys,\s*([\d.]+)%\s*idle/g)]
        const last = matches[matches.length - 1]
        if (last) {
          cpuPct = Math.max(0, Math.min(100, Math.round(100 - Number(last[1]))))
        }
      }

      let ramUsedGb = Number(((totalBytes - os.freemem()) / 1024 ** 3).toFixed(1))
      if (vmRes?.stdout) {
        const pageSizeMatch = vmRes.stdout.match(/page size of (\d+) bytes/)
        const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384
        const grab = (label: string) => {
          const m = vmRes.stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`))
          return m ? Number(m[1]) : 0
        }
        const usedBytes =
          (grab('Pages active') + grab('Pages wired down') + grab('Pages occupied by compressor')) * pageSize
        if (usedBytes > 0) ramUsedGb = Number((usedBytes / 1024 ** 3).toFixed(1))
      }
      const ramPct = totalGb > 0 ? Math.min(100, Math.round((ramUsedGb / totalGb) * 100)) : 0

      let diskPct = 0
      let diskFreeGb = 0
      if (dfRes?.stdout) {
        const line = dfRes.stdout.trim().split('\n').pop() || ''
        const cols = line.trim().split(/\s+/)
        const availKb = Number(cols[3] || 0)
        const capStr = cols.find((c: string) => c.endsWith('%')) || '0%'
        diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
        diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
      }

      return { cpuPct, ramPct, ramUsedGb, ramTotalGb: totalGb, diskPct, diskFreeGb, load1, cores, osName: 'macOS', gpu: null }
    }

    // Local Linux fallback
    const dfRes = await execFileAsync('df', ['-k', '/'], { timeout: 2000 }).catch(() => null)
    const cpuPct = Math.min(100, Math.round((load1 / cores) * 100))
    const ramUsedGb = Number(((totalBytes - os.freemem()) / 1024 ** 3).toFixed(1))
    const ramPct = totalGb > 0 ? Math.min(100, Math.round((ramUsedGb / totalGb) * 100)) : 0
    let diskPct = 0
    let diskFreeGb = 0
    if (dfRes?.stdout) {
      const line = dfRes.stdout.trim().split('\n').pop() || ''
      const cols = line.trim().split(/\s+/)
      const availKb = Number(cols[3] || 0)
      const capStr = cols.find((c: string) => c.endsWith('%')) || '0%'
      diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
      diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
    }
    return { cpuPct, ramPct, ramUsedGb, ramTotalGb: totalGb, diskPct, diskFreeGb, load1, cores, osName: plat, gpu: null }
  } catch {
    return null
  }
}

export async function collectRemoteHostMetrics(
  sshTarget: string,
  viaHubSsh?: string | null
): Promise<HostMetrics | null> {
  if (!sshTarget || !/^[a-zA-Z0-9._@-]+$/.test(sshTarget)) return null
  if (viaHubSsh && !/^[a-zA-Z0-9._@-]+$/.test(viaHubSsh)) return null
  const remoteScript = [
    'OS=$(uname -s); echo "OS:$OS"',
    'if [ "$OS" = "Darwin" ]; then',
    '  sysctl -n hw.ncpu; sysctl -n hw.memsize;',
    '  top -l 2 -n 0 -s 0 | awk \'/CPU usage:/{line=$0} END{print line}\';',
    '  vm_stat | awk \'/page size of/{ps=$8} /Pages active:/{a=$3} /Pages wired down:/{w=$4} /Pages occupied by compressor:/{c=$5} END{gsub(/\\./,"",a);gsub(/\\./,"",w);gsub(/\\./,"",c); print ps,a,w,c}\';',
    '  sysctl -n vm.loadavg;',
    '  df -k /System/Volumes/Data 2>/dev/null | tail -n1 || df -k / | tail -n1;',
    'else',
    '  nproc;',
    '  awk \'/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; print u,t}\' /proc/stat;',
    '  sleep 0.15;',
    '  awk \'/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; print u,t}\' /proc/stat;',
    '  cat /proc/loadavg;',
    '  free -m | awk \'/^Mem:/ {print $2,$3,$7}\';',
    '  df -k / | tail -n1;',
    '  nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || echo NO_GPU;',
    'fi'
  ].join(' ')

  const sshBase = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=2',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=120',
    '-o', 'ControlPath=/tmp/orca-hq-ssh-%C'
  ]
  const b64Script = Buffer.from(remoteScript, 'utf8').toString('base64')
  const relayedCmd = `ssh -o BatchMode=yes -o ConnectTimeout=2 ${sshTarget} 'printf %s ${b64Script} | (base64 -d 2>/dev/null || base64 -D) | sh'`
  const execArgs = viaHubSsh
    ? [...sshBase, viaHubSsh, relayedCmd]
    : [...sshBase, sshTarget, remoteScript]

  try {
    const { stdout } = await execFileAsync('ssh', execArgs, { timeout: viaHubSsh ? 6000 : 4500 })
    const lines = stdout.trim().split('\n').map((s: string) => s.trim()).filter(Boolean)
    if (lines.length < 5) return null

    if (lines[0] === 'OS:Darwin') {
      const cores = Math.max(1, parseInt(lines[1] || '1', 10) || 1)
      const totalBytes = Number(lines[2] || 0)
      const ramTotalGb = Number((totalBytes / 1024 ** 3).toFixed(1))
      const cpuMatch = (lines[3] || '').match(/([\d.]+)%\s*idle/)
      const cpuPct = cpuMatch ? Math.max(0, Math.min(100, Math.round(100 - Number(cpuMatch[1])))) : 0
      const [ps, a, w, c] = (lines[4] || '').split(/\s+/).map(Number)
      const usedBytes = (ps || 16384) * ((a || 0) + (w || 0) + (c || 0))
      const ramUsedGb = Number((usedBytes / 1024 ** 3).toFixed(1))
      const ramPct = ramTotalGb > 0 ? Math.min(100, Math.round((ramUsedGb / ramTotalGb) * 100)) : 0
      const loadMatch = (lines[5] || '').match(/([\d.]+)/)
      const load1 = Number((Number(loadMatch?.[1] || 0)).toFixed(2))
      const dfCols = (lines[6] || '').split(/\s+/)
      const availKb = Number(dfCols[3] || 0)
      const capStr = dfCols.find((col: string) => col.endsWith('%')) || '0%'
      const diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
      const diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
      return { cpuPct, ramPct, ramUsedGb, ramTotalGb, diskPct, diskFreeGb, load1, cores, osName: 'macOS', gpu: null }
    }

    // Linux
    const cores = Math.max(1, parseInt(lines[1] || '1', 10) || 1)
    const [u1, t1] = (lines[2] || '').split(/\s+/).map(Number)
    const [u2, t2] = (lines[3] || '').split(/\s+/).map(Number)
    const dt = t2 - t1
    const cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round(((u2 - u1) / dt) * 100))) : 0
    const load1 = Number((Number((lines[4] || '').split(/\s+/)[0]) || 0).toFixed(2))
    const [memTotalMb, , memAvailMb] = (lines[5] || '').split(/\s+/).map(Number)
    const ramTotalGb = Number(((memTotalMb || 0) / 1024).toFixed(1))
    const ramUsedGb = Number((((memTotalMb || 0) - (memAvailMb || 0)) / 1024).toFixed(1))
    const ramPct = memTotalMb > 0 ? Math.min(100, Math.round(((memTotalMb - memAvailMb) / memTotalMb) * 100)) : 0
    const dfCols = (lines[6] || '').split(/\s+/)
    const availKb = Number(dfCols[3] || 0)
    const capStr = dfCols.find((col: string) => col.endsWith('%')) || '0%'
    const diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
    const diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))

    let gpu: GpuMetrics | null = null
    const gpuLine = lines[7] || 'NO_GPU'
    if (gpuLine && gpuLine !== 'NO_GPU') {
      const parts = gpuLine.split(',').map((s: string) => s.trim())
      if (parts.length >= 6) {
        gpu = {
          name: parts[0].replace(/^NVIDIA GeForce\s+/i, ''),
          utilPct: Math.round(Number(parts[1]) || 0),
          vramUsedMiB: Math.round(Number(parts[2]) || 0),
          vramTotalMiB: Math.round(Number(parts[3]) || 0),
          tempC: Math.round(Number(parts[4]) || 0),
          powerW: Number((Number(parts[5]) || 0).toFixed(1))
        }
      }
    }
    return { cpuPct, ramPct, ramUsedGb, ramTotalGb, diskPct, diskFreeGb, load1, cores, osName: 'Linux', gpu }
  } catch {
    return null
  }
}

export async function defaultMetricsRunner(
  hostId: string,
  sshTarget?: string | null,
  hubSshTarget?: string | null
): Promise<HostMetrics | null> {
  if (hostId === 'local') return collectLocalMetrics()
  const target = sshTarget || hostId
  const direct = await collectRemoteHostMetrics(target)
  if (direct) return direct
  if (sshTarget && sshTarget !== hostId) {
    const byAlias = await collectRemoteHostMetrics(hostId)
    if (byAlias) return byAlias
  }
  if (hubSshTarget) {
    const viaHubAlias = await collectRemoteHostMetrics(hostId, hubSshTarget)
    if (viaHubAlias) return viaHubAlias
    if (target !== hostId) {
      return collectRemoteHostMetrics(target, hubSshTarget)
    }
  }
  return null
}

export function classifyRole(name: string | null | undefined): BotRole {
  const n = (name || '').toLowerCase()
  if (n.includes('copilot') || n.includes('orchestrator') || n.includes('master')) return 'copilot'
  if (n.includes('leader') || n.includes('lead')) return 'leader'
  if (n.includes('product') || n.includes('pm')) return 'product'
  if (n.includes('delivery') || n.includes('dev') || n.includes('eng') || n.includes('build')) return 'delivery'
  if (n.includes('qa') || n.includes('review') || n.includes('test')) return 'qa'
  if (n.includes('release') || n.includes('ops') || n.includes('deploy')) return 'release'
  return 'other'
}

export function classifySquad(name: string | null | undefined, knownSquads?: Iterable<string>): BotSquad {
  const raw = (name || '').trim()
  if (!raw) return 'fleet'
  const lower = raw.toLowerCase()
  if (lower.includes('copilot') || lower.includes('orchestrator') || lower.includes('hq')) return 'command'
  if (knownSquads) {
    for (const sq of knownSquads) {
      if (sq && sq !== 'command' && sq !== 'fleet' && lower.includes(sq)) return sq
    }
  }
  const wsMatch = lower.match(/\/workspaces\/([^/]+)/)
  if (wsMatch?.[1]) return wsMatch[1].split(/[_-]/)[0] || wsMatch[1]
  const words = raw.split(/[\s/_-]+/).filter(Boolean)
  if (words.length >= 2) {
    const first = words[0].toLowerCase()
    if (!['the', 'my', 'orca', 'ai', 'bot', 'home', 'users', 'var', 'tmp', 'opt'].includes(first)) return first
  }
  return 'fleet'
}

export function shortBotLabel(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 3) {
    const prefix = words[0].slice(0, 3).toUpperCase()
    const tail = words[words.length - 1]
    return `${prefix} ${tail}`
  }
  if (words.length === 2 && words[0].length > 5 && !/^copilot$/i.test(words[1])) {
    return `${words[0].slice(0, 3).toUpperCase()} ${words[1]}`
  }
  return name.length > 16 ? `${name.slice(0, 15)}…` : name
}

function mapWorkerState(
  rawState: string | undefined,
  liveness?: string,
  agentState?: string
): WorkerNodeInfo['state'] {
  if (agentState === 'working' || rawState === 'working' || rawState === 'active') return 'working'
  if (rawState === 'permission' || rawState === 'blocked' || agentState === 'blocked') return 'permission'
  if (rawState === 'succeeded' || rawState === 'done') return 'succeeded'
  if (rawState === 'failed') return 'failed'
  if (rawState === 'stopped') return 'stopped'
  if (liveness === 'live' && rawState !== 'inactive' && rawState !== 'idle') return 'working'
  return 'idle'
}

function extractEndpointHost(endpoint: string | undefined): string | null {
  if (!endpoint) return null
  const m = endpoint.match(/^(?:wss?|https?):\/\/([^:/]+)/i)
  return m?.[1] || null
}

function cleanLocalHostLabel(): string {
  const hn = (os.hostname() || 'LOCAL').replace(/\.local$/i, '').replace(/['’]/g, '')
  return hn.toUpperCase().slice(0, 18) || 'LOCAL'
}

function formatHostSpecs(m: HostMetrics | null, fallbackOs = 'Host'): string {
  if (!m) return fallbackOs
  const parts: string[] = []
  if (m.cores) parts.push(`${m.cores}C`)
  if (m.ramTotalGb) parts.push(`${Math.round(m.ramTotalGb)}GB`)
  if (m.gpu?.name) parts.push(m.gpu.name)
  else if (m.osName) parts.push(m.osName)
  return parts.join(' · ') || fallbackOs
}

type RawBot = {
  id?: string
  name?: string
  agent?: string
  paused?: boolean
  chats?: { count?: number }
}

type RawEnv = {
  id?: string
  name?: string
  endpoints?: { endpoint?: string }[]
}

type RawPsAgent = {
  paneKey?: string
  orcaSessionId?: string
  state?: string
  agent?: string
  agentType?: string
  prompt?: string | null
  toolName?: string | null
  taskTitle?: string | null
  updatedAt?: number | null
  activity?: { title?: string | null; status?: string | null } | null
}

type RawWorktreePs = {
  worktreeId?: string
  hostId?: string
  repo?: string
  path?: string
  branch?: string
  bot?: string | null
  botHome?: boolean
  displayName?: string
  status?: string
  unread?: boolean
  lastActivityAt?: number | null
  crossStoreParent?: {
    parent?: { workspaceKey?: string | null } | null
  } | null
  agents?: RawPsAgent[]
}

type RawRemoteWorker = {
  dispatchId?: string
  taskId?: string
  state?: string
  liveness?: string
  agent?: string
  terminal?: string
  workspace?: string
}

async function readPluginConfig(orca: OrcaWorkerApi): Promise<PluginConfig> {
  const res = await orca.host.call('settings.get').catch(() => null)
  const s = (res?.settings ?? {}) as Record<string, unknown>
  const controlEnvironment = typeof s.controlEnvironment === 'string' ? s.controlEnvironment.trim() : ''
  const sshTargets = parseSshTargets(typeof s.sshTargets === 'string' ? s.sshTargets : '')
  const hubRelays = parseHubRelays(typeof s.hubRelays === 'string' ? s.hubRelays : '')
  const showLocalHost = typeof s.showLocalHost === 'boolean' ? s.showLocalHost : true
  const rawPoll = typeof s.pollIntervalSec === 'number' ? s.pollIntervalSec : 10
  const pollIntervalSec = Math.max(5, Math.min(120, Math.round(rawPoll)))
  return { controlEnvironment, sshTargets, hubRelays, showLocalHost, pollIntervalSec }
}

export async function collectHqSnapshot(
  orca: OrcaWorkerApi,
  cli: CliRunner,
  metricsRunner: MetricsRunner,
  eventLog: HqEventEntry[],
  relayCli: RelayCliRunner = runRelayedOrcaCliJson,
  hubSshByHostOut?: Map<string, string>,
  hubRelayClient: HubRelayClient = defaultHubRelayClient,
  hubHttpByHostOut?: Map<string, HubRelayTarget>
): Promise<HqSnapshot> {
  const cfg = await readPluginConfig(orca)

  const [hostWsRes, envsRes, localBotsRes] = await Promise.all([
    orca.host.call('workspace.list', { includeStatus: true }).catch(() => ({ workspaces: [], truncated: false })),
    cli(['environment', 'list', '--json']),
    cfg.controlEnvironment ? Promise.resolve(null) : cli(['bot', 'list', '--json'])
  ])

  const hostWorkspaces = hostWsRes?.workspaces ?? []
  const rawEnvs: RawEnv[] = Array.isArray((envsRes as { environments?: unknown })?.environments)
    ? ((envsRes as { environments: RawEnv[] }).environments)
    : []

  // Resolve Control Plane Environment (local vs paired remote control host such as a remote Mac mini)
  let controlHostId: HostId = cfg.controlEnvironment || 'local'
  let rawBots: RawBot[] = Array.isArray((localBotsRes as { bots?: unknown })?.bots)
    ? ((localBotsRes as { bots: RawBot[] }).bots)
    : []

  if (cfg.controlEnvironment && cfg.controlEnvironment !== 'local') {
    const ctrlBotsRes = await cli(['bot', 'list', '--environment', cfg.controlEnvironment, '--json'])
    rawBots = Array.isArray((ctrlBotsRes as { bots?: unknown })?.bots)
      ? ((ctrlBotsRes as { bots: RawBot[] }).bots)
      : []
  } else if (!cfg.controlEnvironment && rawBots.length === 0 && rawEnvs.length > 0) {
    const probes = await Promise.all(
      rawEnvs.map(async (env) => {
        const envName = env.name || env.id || ''
        if (!envName) return { envName: '', bots: [] as RawBot[] }
        const res = await cli(['bot', 'list', '--environment', envName, '--json'])
        const bots = Array.isArray((res as { bots?: unknown })?.bots) ? ((res as { bots: RawBot[] }).bots) : []
        return { envName, bots }
      })
    )
    const found = probes.find((p) => p.bots.length > 0)
    if (found) {
      controlHostId = found.envName
      rawBots = found.bots
    }
  }

  const includeLocal = cfg.showLocalHost || controlHostId === 'local'
  const [localPsRes, localWorkersRes, localMetrics] = includeLocal
    ? await Promise.all([
        cli(['worktree', 'ps', '--since', '24h', '--json']),
        cli(['orchestration', 'worker-list', '--json']),
        metricsRunner('local', null, null).catch(() => null)
      ])
    : [null, null, null]

  type RemoteHostResult = {
    env: RawEnv
    envName: string
    sshTarget: string
    httpRelay: HubRelayTarget | null
    httpRelaySnap: HubRelaySnapshotPayload | null
    viaHub: string | null
    viaHubSsh: string | null
    ok: boolean
    workers: RawRemoteWorker[]
    remotePs: RawWorktreePs[]
    metrics: HostMetrics | null
  }

  const directRemoteResults: RemoteHostResult[] = await Promise.all(
    rawEnvs.map(async (env) => {
      const envName = env.name || env.id || 'remote'
      const endpointHost = extractEndpointHost(env.endpoints?.[0]?.endpoint)
      const sshTarget = lookupSshTarget(cfg, envName, endpointHost)
      const httpRelay = cfg.hubRelays[envName] || cfg.hubRelays[envName.toLowerCase()] || null
      const [res, remotePsRes, httpRelaySnap, sshMetrics] = await Promise.all([
        cli(['orchestration', 'worker-list', '--environment', envName, '--json']),
        cli(['worktree', 'ps', '--environment', envName, '--since', '24h', '--json']),
        httpRelay ? hubRelayClient.fetchSnapshot(httpRelay).catch(() => null) : Promise.resolve(null),
        httpRelay ? Promise.resolve(null) : metricsRunner(envName, sshTarget, null).catch(() => null)
      ])
      const metrics = httpRelaySnap?.host?.metrics ?? sshMetrics ?? (httpRelay ? await metricsRunner(envName, sshTarget, null).catch(() => null) : null)
      const workers = Array.isArray((res as { workers?: unknown })?.workers)
        ? ((res as { workers: RawRemoteWorker[] }).workers)
        : []
      const remotePs = Array.isArray((remotePsRes as { worktrees?: unknown })?.worktrees)
        ? ((remotePsRes as { worktrees: RawWorktreePs[] }).worktrees)
        : []
      return {
        env,
        envName,
        sshTarget,
        httpRelay,
        httpRelaySnap,
        viaHub: null,
        viaHubSsh: null,
        ok: res !== null || remotePsRes !== null || httpRelaySnap !== null,
        workers,
        remotePs,
        metrics
      }
    })
  )

  // Hub Relay Discovery: prefer Zero-SSH HTTP Hub Relay when configured, else fall back to SSH Hub Relay
  const seenEnvNames = new Set<string>(['local', ...directRemoteResults.map((r) => r.envName.toLowerCase())])
  const localHostNorm = cleanLocalHostLabel().toLowerCase()
  const relayedResults: RemoteHostResult[] = []

  for (const hub of directRemoteResults) {
    if (!hub.httpRelay || !hub.httpRelaySnap || !Array.isArray(hub.httpRelaySnap.children)) continue
    for (const ch of hub.httpRelaySnap.children) {
      const childName = ch.envName || ch.env?.name || ch.env?.id || ''
      if (!childName) continue
      const lower = childName.toLowerCase()
      if (seenEnvNames.has(lower) || lower === localHostNorm) continue
      seenEnvNames.add(lower)
      if (hubHttpByHostOut) hubHttpByHostOut.set(childName, hub.httpRelay)
      relayedResults.push({
        env: ch.env || { name: childName },
        envName: childName,
        sshTarget: childName,
        httpRelay: null,
        httpRelaySnap: null,
        viaHub: hub.envName,
        viaHubSsh: null,
        ok: Boolean(ch.ok || ch.metrics || (ch.workers && ch.workers.length) || (ch.remotePs && ch.remotePs.length)),
        workers: Array.isArray(ch.workers) ? ch.workers : [],
        remotePs: Array.isArray(ch.remotePs) ? ch.remotePs : [],
        metrics: ch.metrics ?? null
      })
    }
  }

  const relayProbes = await Promise.all(
    directRemoteResults
      .filter(
        (hub) =>
          !hub.httpRelay &&
          hub.ok &&
          (hub.metrics !== null || hub.envName === controlHostId || Boolean(cfg.sshTargets[hub.envName.toLowerCase()]))
      )
      .map(async (hub) => {
        const childEnvsRes = await relayCli(hub.sshTarget, ['environment', 'list', '--json']).catch(() => null)
        const childEnvs: RawEnv[] = Array.isArray((childEnvsRes as { environments?: unknown })?.environments)
          ? ((childEnvsRes as { environments: RawEnv[] }).environments)
          : []
        return { hub, childEnvs }
      })
  )

  const relayTasks: Promise<RemoteHostResult>[] = []
  for (const { hub, childEnvs } of relayProbes) {
    for (const childEnv of childEnvs) {
      const childName = childEnv.name || childEnv.id || ''
      if (!childName) continue
      const lower = childName.toLowerCase()
      if (seenEnvNames.has(lower) || lower === localHostNorm) continue
      seenEnvNames.add(lower)
      const childEpHost = extractEndpointHost(childEnv.endpoints?.[0]?.endpoint)
      const childSsh = lookupSshTarget(cfg, childName, childEpHost)
      if (hubSshByHostOut) hubSshByHostOut.set(childName, hub.sshTarget)
      relayTasks.push(
        (async (): Promise<RemoteHostResult> => {
          const [res, remotePsRes, metrics] = await Promise.all([
            relayCli(hub.sshTarget, ['orchestration', 'worker-list', '--environment', childName, '--json']).catch(() => null),
            relayCli(hub.sshTarget, ['worktree', 'ps', '--environment', childName, '--since', '24h', '--json']).catch(() => null),
            metricsRunner(childName, childSsh, hub.sshTarget).catch(() => null)
          ])
          const workers = Array.isArray((res as { workers?: unknown })?.workers)
            ? ((res as { workers: RawRemoteWorker[] }).workers)
            : []
          const remotePs = Array.isArray((remotePsRes as { worktrees?: unknown })?.worktrees)
            ? ((remotePsRes as { worktrees: RawWorktreePs[] }).worktrees)
            : []
          return {
            env: childEnv,
            envName: childName,
            sshTarget: childSsh,
            httpRelay: null,
            httpRelaySnap: null,
            viaHub: hub.envName,
            viaHubSsh: hub.sshTarget,
            ok: res !== null || remotePsRes !== null || metrics !== null,
            workers,
            remotePs,
            metrics
          }
        })()
      )
    }
  }
  if (relayTasks.length > 0) {
    relayedResults.push(...(await Promise.all(relayTasks)))
  }

  const remoteResults: RemoteHostResult[] = [...directRemoteResults, ...relayedResults]

  const rawLocalPs: RawWorktreePs[] = Array.isArray((localPsRes as { worktrees?: unknown })?.worktrees)
    ? ((localPsRes as { worktrees: RawWorktreePs[] }).worktrees)
    : []
  const rawLocalWorkers: RawRemoteWorker[] = Array.isArray((localWorkersRes as { workers?: unknown })?.workers)
    ? ((localWorkersRes as { workers: RawRemoteWorker[] }).workers)
    : []

  const localAgentByWs = new Map<string, string>()
  for (const lw of rawLocalWorkers) {
    if (lw.workspace && lw.agent && !localAgentByWs.has(lw.workspace)) {
      localAgentByWs.set(lw.workspace, lw.agent)
    }
  }

  // Index Bot Homes across ALL machines (local + every paired/relayed host) for true per-Bot machine ownership
  const envNameById = new Map<string, string>()
  for (const env of rawEnvs) {
    const name = env.name || env.id || ''
    if (!name) continue
    envNameById.set(name.toLowerCase(), name)
    if (env.id) envNameById.set(env.id.toLowerCase(), name)
  }
  const resolveHostId = (rawHostId?: string | null): HostId => {
    if (!rawHostId || rawHostId === 'local') return 'local'
    return envNameById.get(rawHostId.toLowerCase()) || rawHostId
  }

  const psByBotHome = new Map<string, RawWorktreePs>()
  const botHostByName = new Map<string, HostId>()
  const botNameByWorkspaceId = new Map<string, string>()
  const hostWsByBotName = new Map<string, string>()

  for (const ws of hostWorkspaces) {
    if (ws.kind === 'folder' && ws.name) {
      hostWsByBotName.set(ws.name.toLowerCase(), ws.id)
      botNameByWorkspaceId.set(ws.id, ws.name)
    }
  }

  for (const row of rawLocalPs) {
    if (row.botHome && row.bot) {
      const ownerHost = resolveHostId(row.hostId)
      psByBotHome.set(row.bot, row)
      botHostByName.set(row.bot, ownerHost)
      if (row.worktreeId) botNameByWorkspaceId.set(row.worktreeId, row.bot)
    }
  }

  for (const { envName, remotePs } of remoteResults) {
    for (const row of remotePs) {
      if (row.botHome && row.bot) {
        const existingHost = botHostByName.get(row.bot)
        const existingTs = psByBotHome.get(row.bot)?.lastActivityAt ?? -1
        const nextTs = row.lastActivityAt ?? 0
        if (!existingHost || existingHost === 'local' || nextTs >= existingTs) {
          psByBotHome.set(row.bot, row)
          botHostByName.set(row.bot, envName)
        }
        if (row.worktreeId) botNameByWorkspaceId.set(row.worktreeId, row.bot)
      }
    }
  }

  const pickBestAgent = (agents?: RawPsAgent[]): RawPsAgent | null => {
    if (!agents || agents.length === 0) return null
    const working = agents.find((a) => a.state === 'working')
    if (working) return working
    const sorted = [...agents].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return sorted[0] || null
  }

  const pickAgentSummary = (agent: RawPsAgent | null): string | null => {
    if (!agent) return null
    const candidates = [agent.activity?.title, agent.taskTitle, agent.prompt]
    for (const raw of candidates) {
      if (!raw) continue
      let text = raw.trim()
      if (text.includes('Subject:')) {
        const subjMatch = text.match(/Subject:\s*([^\n]+)/)
        if (subjMatch?.[1]?.trim()) text = subjMatch[1].trim()
      }
      if (/^You are working inside Orca/i.test(text)) {
        const taskMatch = text.match(/(?:Task|Goal|Objective|Subject):\s*([^\n]+)/i)
        if (taskMatch?.[1]?.trim()) text = taskMatch[1].trim()
        else continue
      }
      if (/^─{3,}\s*From:/i.test(text)) continue
      const singleLine = text.replace(/\s+/g, ' ').trim()
      if (!singleLine) continue
      return singleLine.length > 72 ? `${singleLine.slice(0, 71)}…` : singleLine
    }
    return null
  }

  const knownSquads = new Set<string>(rawBots.map((b) => classifySquad(b.name)))

  // Helper to match a worker with a Bot when crossStoreParent was not set
  const inferBotFromKnownBots = (squad: BotSquad, hint: string, explicitBot: string | null): string | null => {
    if (explicitBot) return explicitBot
    const h = hint.toLowerCase()
    const isQa = h.includes('qa') || h.includes('review') || h.includes('audit')
    const sameSquad = rawBots.filter((b) => classifySquad(b.name) === squad)
    if (sameSquad.length > 0) {
      const preferred = sameSquad.find((b) => {
        const r = classifyRole(b.name)
        return isQa ? r === 'qa' : r === 'delivery'
      })
      if (preferred?.name) return preferred.name
      if (sameSquad[0]?.name) return sameSquad[0].name
    }
    if (squad === 'command') {
      const cmd = rawBots.find((b) => classifyRole(b.name) === 'copilot')
      if (cmd?.name) return cmd.name
    }
    return null
  }

  const workers: WorkerNodeInfo[] = []
  const seenWorkspaces = new Set<string>()

  if (includeLocal) {
    for (const row of rawLocalPs) {
      if (row.botHome && row.bot) continue
      if (row.repo === 'Bots') continue
      const wtId = row.worktreeId || row.path || ''
      if (wtId) seenWorkspaces.add(wtId)
      const bestAgent = pickBestAgent(row.agents)
      const state = mapWorkerState(row.status, undefined, bestAgent?.state)
      const host = row.hostId && row.hostId !== 'local' ? row.hostId : 'local'
      const parentWsKey = row.crossStoreParent?.parent?.workspaceKey || null
      const parentBotName = (parentWsKey && botNameByWorkspaceId.get(parentWsKey)) || row.bot || null
      const squad = classifySquad(parentBotName || `${row.repo || ''} ${row.branch || ''} ${row.path || ''}`, knownSquads)
      const bot = inferBotFromKnownBots(squad, `${row.displayName || ''} ${row.branch || ''}`, parentBotName)
      workers.push({
        id: wtId || `${row.repo}:${row.displayName}`,
        title: row.displayName || row.branch || row.repo || 'workspace',
        host,
        bot,
        parentBotWorkspaceId: parentWsKey,
        squad,
        agent: (row.worktreeId && localAgentByWs.get(row.worktreeId)) || bestAgent?.agentType || bestAgent?.agent || 'antigravity',
        state,
        branch: row.branch ? row.branch.replace(/^refs\/heads\//, '') : null,
        workspaceId: row.worktreeId || null,
        workspacePath: row.path || '',
        sessionId: bestAgent?.orcaSessionId || null,
        terminalId: null,
        sessionTitle: pickAgentSummary(bestAgent),
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: row.lastActivityAt ?? null
      })
    }
  }

  for (const { envName, workers: rWorkers, remotePs } of remoteResults) {
    const psByWorkspace = new Map<string, RawWorktreePs>()
    for (const rps of remotePs) {
      if (rps.worktreeId) psByWorkspace.set(rps.worktreeId, rps)
    }

    const seenRemoteWs = new Set<string>()
    for (const w of rWorkers.slice(0, 14)) {
      const ws = w.workspace || ''
      if (ws && seenRemoteWs.has(ws)) continue
      if (ws) seenRemoteWs.add(ws)
      const matchedPs = ws ? psByWorkspace.get(ws) : undefined
      if (matchedPs?.botHome || matchedPs?.repo === 'Bots') continue
      const bestAgent = pickBestAgent(matchedPs?.agents)
      const wsPath = matchedPs?.path || (ws.includes('::') ? ws.split('::')[1] : ws)
      const shortName = matchedPs?.displayName || wsPath.split('/').filter(Boolean).pop() || w.dispatchId || 'worker'
      const mapped = mapWorkerState(w.state, w.liveness, bestAgent?.state)
      if (mapped !== 'working' && workers.filter((x) => x.host === envName).length >= 5) continue

      const parentWsKey = matchedPs?.crossStoreParent?.parent?.workspaceKey || null
      const parentBotName = parentWsKey ? (botNameByWorkspaceId.get(parentWsKey) ?? null) : null
      const squad = classifySquad(parentBotName || `${matchedPs?.repo || ''} ${wsPath} ${shortName}`, knownSquads)
      const bot = inferBotFromKnownBots(squad, `${envName} ${shortName} ${wsPath}`, parentBotName)

      workers.push({
        id: w.dispatchId || ws || shortName,
        title: shortName,
        host: envName,
        bot,
        parentBotWorkspaceId: parentWsKey,
        squad,
        agent: w.agent || bestAgent?.agentType || 'antigravity',
        state: mapped,
        branch: matchedPs?.branch ? matchedPs.branch.replace(/^refs\/heads\//, '') : null,
        workspaceId: ws || null,
        workspacePath: wsPath,
        sessionId: bestAgent?.orcaSessionId || null,
        terminalId: w.terminal || null,
        sessionTitle: pickAgentSummary(bestAgent),
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: matchedPs?.lastActivityAt ?? null
      })
    }

    for (const rps of remotePs) {
      const ws = rps.worktreeId || ''
      if (!ws || seenRemoteWs.has(ws)) continue
      if (rps.botHome || rps.repo === 'Bots') continue
      seenRemoteWs.add(ws)
      const bestAgent = pickBestAgent(rps.agents)
      const mapped = mapWorkerState(rps.status, undefined, bestAgent?.state)
      if (mapped !== 'working' && workers.filter((x) => x.host === envName).length >= 5) continue
      const parentWsKey = rps.crossStoreParent?.parent?.workspaceKey || null
      const parentBotName = parentWsKey ? (botNameByWorkspaceId.get(parentWsKey) ?? null) : null
      const squad = classifySquad(parentBotName || `${rps.repo || ''} ${rps.path || ''}`, knownSquads)
      const bot = inferBotFromKnownBots(squad, `${envName} ${rps.displayName || ''} ${rps.path || ''}`, parentBotName)
      workers.push({
        id: ws,
        title: rps.displayName || rps.branch || rps.repo || 'workspace',
        host: envName,
        bot,
        parentBotWorkspaceId: parentWsKey,
        squad,
        agent: bestAgent?.agentType || bestAgent?.agent || 'antigravity',
        state: mapped,
        branch: rps.branch ? rps.branch.replace(/^refs\/heads\//, '') : null,
        workspaceId: ws,
        workspacePath: rps.path || '',
        sessionId: bestAgent?.orcaSessionId || null,
        terminalId: null,
        sessionTitle: pickAgentSummary(bestAgent),
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: rps.lastActivityAt ?? null
      })
    }
  }

  if (includeLocal && rawLocalPs.length === 0 && hostWorkspaces.length > 0) {
    for (const ws of hostWorkspaces) {
      if (ws.kind !== 'worktree' || seenWorkspaces.has(ws.id)) continue
      const mapped = mapWorkerState(ws.status?.state)
      const host = ws.hostId || 'local'
      const squad = classifySquad(ws.project || ws.name || ws.path)
      workers.push({
        id: ws.id,
        title: ws.name || ws.branch || 'worktree',
        host,
        bot: inferBotFromKnownBots(squad, `${ws.name} ${ws.branch || ''}`, null),
        parentBotWorkspaceId: null,
        squad,
        agent: 'antigravity',
        state: mapped,
        branch: ws.branch,
        workspaceId: ws.id,
        workspacePath: ws.path,
        sessionId: null,
        terminalId: null,
        sessionTitle: null,
        activeToolName: null,
        lastActivityAt: ws.status?.lastActivityAt ?? null
      })
    }
  }

  const hosts: HostNodeInfo[] = []
  const botCountsByHost = new Map<string, number>()
  for (const ownerHost of botHostByName.values()) {
    botCountsByHost.set(ownerHost, (botCountsByHost.get(ownerHost) || 0) + 1)
  }

  if (includeLocal) {
    const localHasBots = (botCountsByHost.get('local') || 0) > 0 || controlHostId === 'local'
    hosts.push({
      id: 'local',
      label: cleanLocalHostLabel(),
      role: localHasBots ? 'CONTROL PLANE · LOCAL' : 'MONITORING CONSOLE',
      specs: formatHostSpecs(localMetrics, os.platform() === 'darwin' ? 'macOS' : 'Local'),
      endpoint: 'local',
      online: true,
      isControlPlane: localHasBots,
      activeWorkers: workers.filter((w) => w.host === 'local' && w.state === 'working').length,
      totalWorkspaces: hostWorkspaces.filter((w) => !w.hostId || w.hostId === 'local').length,
      metrics: localMetrics
    })
  }

  for (const { env, envName, viaHub, ok, metrics } of remoteResults) {
    const isCtrl = envName === controlHostId || (botCountsByHost.get(envName) || 0) > 0
    const hasGpu = Boolean(metrics?.gpu)
    const hubSuffix = viaHub ? ` · VIA ${viaHub.toUpperCase()}` : ''
    hosts.push({
      id: envName,
      label: envName.toUpperCase(),
      role: isCtrl
        ? 'REMOTE CONTROL PLANE'
        : hasGpu
          ? `GPU COMPUTE NODE${hubSuffix}`
          : `PAIRED COMPUTE NODE${hubSuffix}`,
      specs: formatHostSpecs(metrics, viaHub ? `Relayed via ${viaHub}` : 'Paired Node'),
      endpoint: env.endpoints?.[0]?.endpoint || envName,
      online: ok,
      isControlPlane: isCtrl,
      activeWorkers: workers.filter((w) => w.host === envName && w.state === 'working').length,
      totalWorkspaces: workers.filter((w) => w.host === envName).length,
      metrics
    })
  }

  const gpuHostId = hosts.find((h) => h.metrics?.gpu)?.id || null
  const nonCtrlNonGpuHostId = hosts.find((h) => !h.isControlPlane && h.id !== gpuHostId)?.id || null

  const bots: BotNodeInfo[] = rawBots.map((b) => {
    const name = b.name || 'Bot'
    const role = classifyRole(name)
    const home = psByBotHome.get(name)
    const actualBotHost = botHostByName.get(name) || controlHostId
    const bestAgent = pickBestAgent(home?.agents)
    const botWorkers = workers.filter((w) => w.bot === name)
    const activeDispatchCount = botWorkers.filter((w) => w.state === 'working').length

    // Dynamic host routing based on actual observed workers, then cluster capability heuristics
    const observedHosts = [...new Set(botWorkers.map((w) => w.host))]
    let primaryHost: HostId = observedHosts[0] || actualBotHost
    let secondaryHost: HostId | null = observedHosts[1] || null
    if (observedHosts.length === 0) {
      if (role === 'delivery' && gpuHostId) primaryHost = gpuHostId
      else if (role === 'qa' && nonCtrlNonGpuHostId) {
        primaryHost = nonCtrlNonGpuHostId
        secondaryHost = actualBotHost
      }
    }

    let state: BotNodeInfo['state'] = 'idle'
    if (b.paused) state = 'paused'
    else if (home?.status === 'working' || bestAgent?.state === 'working' || activeDispatchCount > 0) state = 'working'
    else if (home?.unread) state = 'unread'

    const workspaceId = home?.worktreeId ?? hostWsByBotName.get(name.toLowerCase()) ?? null
    return {
      id: b.id || name,
      name,
      shortName: shortBotLabel(name),
      squad: classifySquad(name),
      role,
      botHost: actualBotHost,
      primaryHost,
      secondaryHost,
      agent: b.agent || 'antigravity',
      state,
      chatsCount: b.chats?.count ?? 1,
      workspaceId,
      activeDispatchCount,
      activeSessionTitle: pickAgentSummary(bestAgent),
      activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
      lastActivityAt: home?.lastActivityAt ?? null
    }
  })

  workers.sort((a, b) => {
    const score = (s: WorkerNodeInfo['state']) =>
      s === 'working' ? 3 : s === 'permission' ? 2 : s === 'succeeded' ? 1 : 0
    const diff = score(b.state) - score(a.state)
    if (diff !== 0) return diff
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })

  const trimmedWorkers = workers.slice(0, 18)
  const controlHostLabel = hosts.find((h) => h.id === controlHostId)?.label || controlHostId.toUpperCase()

  return {
    generatedAt: Date.now(),
    controlHostId,
    controlHostLabel,
    hosts,
    bots,
    workers: trimmedWorkers,
    events: eventLog.slice(0, 18),
    summary: {
      totalBots: bots.length,
      workingBots: bots.filter((b) => b.state === 'working').length,
      onlineHosts: hosts.filter((h) => h.online).length,
      activeWorkers: workers.filter((w) => w.state === 'working').length,
      recentWorkers: trimmedWorkers.length
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let wallServer: http.Server | null = null
let wallPort = 0
let wallToken = ''
const sseClients = new Set<http.ServerResponse>()

function resolvePanelHtmlPath(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    return path.join(dir, 'panel.html')
  } catch {
    return path.join(__dirname || '', 'panel.html')
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    let total = 0
    req.on('data', (chunk) => {
      const s = typeof chunk === 'string' ? chunk : String(chunk)
      total += s.length
      if (total > 64 * 1024 * 1024) {
        reject(new Error('Body too large'))
        return
      }
      raw += s
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
  })
}

export default function activate(
  orca: OrcaWorkerApi,
  cli: CliRunner = runOrcaCliJson,
  metricsRunner: MetricsRunner = defaultMetricsRunner,
  videoSaver: VideoSaver = defaultVideoSaver,
  wallOpener: WallOpener = defaultWallOpener,
  relayCli: RelayCliRunner = runRelayedOrcaCliJson,
  hubRelayClient: HubRelayClient = defaultHubRelayClient
): void {
  const eventLog: HqEventEntry[] = [
    { ts: Date.now(), kind: 'system', message: 'CYBER HQ RADAR ONLINE · LINKED TO ORCA MESH' }
  ]
  let latestSnapshot: HqSnapshot | null = null
  const hubSshByHost = new Map<string, string>()
  const hubHttpByHost = new Map<string, HubRelayTarget>()

  const pushLog = (kind: HqEventEntry['kind'], message: string) => {
    eventLog.unshift({ ts: Date.now(), kind, message })
    if (eventLog.length > 24) eventLog.length = 24
  }

  const broadcastSse = (snap: HqSnapshot) => {
    if (sseClients.size === 0) return
    const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  const refreshAndBroadcast = async (): Promise<HqSnapshot> => {
    hubSshByHost.clear()
    hubHttpByHost.clear()
    const snap = await collectHqSnapshot(
      orca,
      cli,
      metricsRunner,
      eventLog,
      relayCli,
      hubSshByHost,
      hubRelayClient,
      hubHttpByHost
    )
    latestSnapshot = snap
    const activeTotal = snap.summary.activeWorkers + snap.summary.workingBots
    const tone = activeTotal > 0 ? 'accent' : 'success'
    await orca.host
      .call('statusBar.update', {
        id: 'hq-status',
        text: `HQ · ${snap.summary.onlineHosts}N · ${snap.summary.activeWorkers}W`,
        tone,
        tooltip: `${snap.summary.totalBots} Bots (${snap.summary.workingBots} working) · ${snap.summary.onlineHosts} Hosts online · ${snap.summary.activeWorkers} active workers`
      })
      .catch(() => {})
    orca.panels.post('hq.snapshot', snap)
    broadcastSse(snap)
    return snap
  }

  const scheduleRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void refreshAndBroadcast()
    }, 250)
  }

  orca.panels.handle('hq.getSnapshot', async () => {
    if (latestSnapshot) return latestSnapshot
    return refreshAndBroadcast()
  })

  orca.panels.handle('hq.refresh', async () => {
    pushLog('system', 'MANUAL RADAR SWEEP TRIGGERED')
    return refreshAndBroadcast()
  })

  orca.panels.handle('hq.openWorkspace', async ({ workspaceId }) => {
    if (!workspaceId) return { opened: false }
    const res = await orca.host.call('workspace.open', { workspaceId }).catch(() => null)
    return { opened: Boolean(res?.opened) }
  })

  const handleOpenSession = async (input: OpenSessionInput): Promise<OpenSessionOutput> => {
    const host = input?.host || 'local'
    const wsId = input?.workspaceId || null
    const wsPath = input?.workspacePath || null
    const termId = input?.terminalId || null
    const fallbackWs = input?.fallbackWorkspaceId || null

    if (host === 'local') {
      if (wsId) {
        const opened = await orca.host.call('workspace.open', { workspaceId: wsId }).catch(() => null)
        let targetTerm = termId && termId.startsWith('term_') ? termId : null
        if (!targetTerm) {
          const agentsRes = await orca.host.call('agents.list', { workspaceId: wsId }).catch(() => null)
          const activeAgent = agentsRes?.agents?.find((a) => a.terminalId && a.state === 'working')
            || agentsRes?.agents?.find((a) => a.terminalId)
          if (activeAgent?.terminalId) targetTerm = activeAgent.terminalId
        }
        if (targetTerm) {
          const foc = await orca.host.call('terminal.focus', { terminalId: targetTerm }).catch(() => null)
          if (foc?.focused) {
            pushLog('workspace', `FOCUSED SESSION :: ${wsPath || wsId}`)
            return { opened: true, mode: 'focused', detail: 'Focused live Orca session pane' }
          }
        }
        if (opened?.opened) {
          pushLog('workspace', `OPENED WORKSPACE :: ${wsPath || wsId}`)
          return { opened: true, mode: 'opened', detail: 'Opened Orca workspace' }
        }
      }
      if (fallbackWs) {
        const fb = await orca.host.call('workspace.open', { workspaceId: fallbackWs }).catch(() => null)
        if (fb?.opened) return { opened: true, mode: 'fallback', detail: 'Opened parent Bot session' }
      }
      return { opened: false, mode: 'none', detail: 'No matching local session' }
    }

    if (wsId || wsPath) {
      const listRes = await orca.host.call('workspace.list', { includeStatus: false }).catch(() => null)
      const matched = listRes?.workspaces?.find((w) =>
        (wsId && w.id === wsId) || (wsPath && w.path === wsPath)
      )
      if (matched) {
        const opened = await orca.host.call('workspace.open', { workspaceId: matched.id }).catch(() => null)
        if (opened?.opened) {
          pushLog('workspace', `OPENED REMOTE WORKSPACE :: ${host} · ${wsPath || wsId}`)
          return { opened: true, mode: 'opened', detail: `Opened ${host} workspace in Orca` }
        }
      }
    }

    if (termId && termId.startsWith('term_')) {
      const switched = await cli(['terminal', 'switch', '--environment', host, '--terminal', termId, '--json'])
      if (switched) {
        pushLog('workspace', `SWITCHED REMOTE SESSION :: ${host} · ${termId}`)
        return { opened: true, mode: 'focused', detail: `Switched to ${host} terminal` }
      }
    }

    const selector = wsId ? `id:${wsId}` : wsPath ? `path:${wsPath}` : null
    if (selector) {
      const hubHttp = hubHttpByHost.get(host)
      if (hubHttp) {
        const activated = await hubRelayClient.activateWorktree(hubHttp, host, selector).catch(() => false)
        if (activated) {
          pushLog('workspace', `ACTIVATED VIA HUB RELAY :: ${host} · ${wsPath || wsId}`)
          return { opened: true, mode: 'activated', detail: `Activated on ${host}` }
        }
      }
      const hubSsh = hubSshByHost.get(host)
      const act = hubSsh
        ? await relayCli(hubSsh, ['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'])
        : await cli(['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'])
      if (act && (act as { activated?: boolean }).activated !== false) {
        pushLog('workspace', `ACTIVATED REMOTE WORKTREE :: ${host} · ${wsPath || wsId}`)
        return { opened: true, mode: 'activated', detail: `Activated on ${host}` }
      }
    }

    if (fallbackWs) {
      const fb = await orca.host.call('workspace.open', { workspaceId: fallbackWs }).catch(() => null)
      if (fb?.opened) {
        pushLog('workspace', `OPENED PARENT BOT :: ${fallbackWs}`)
        return { opened: true, mode: 'fallback', detail: 'Opened dispatching Bot session' }
      }
    }

    return { opened: false, mode: 'none', detail: `Could not open session on ${host}` }
  }

  const pendingVideoUploads = new Map<
    string,
    { chunks: (string | undefined)[]; received: number; total: number; totalLen: number; createdAt: number }
  >()

  const handleSaveVideo = async (input: SaveVideoInput): Promise<SaveVideoOutput> => {
    const format: 'mp4' | 'webm' = (input?.mimeType || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm'
    try {
      const now = Date.now()
      for (const [id, entry] of pendingVideoUploads.entries()) {
        if (now - entry.createdAt > 120_000) pendingVideoUploads.delete(id)
      }

      let finalInput: SaveVideoInput = input
      if (input?.uploadId && typeof input.totalChunks === 'number' && input.totalChunks > 1) {
        const total = Math.floor(input.totalChunks)
        const idx = Math.floor(input.chunkIndex ?? -1)
        if (total > 512 || idx < 0 || idx >= total) {
          return { saved: false, path: null, bytes: 0, format, error: 'Invalid video chunk metadata' }
        }
        let slot = pendingVideoUploads.get(input.uploadId)
        if (!slot) {
          slot = { chunks: new Array(total), received: 0, total, totalLen: 0, createdAt: now }
          pendingVideoUploads.set(input.uploadId, slot)
        }
        if (slot.total !== total) {
          pendingVideoUploads.delete(input.uploadId)
          return { saved: false, path: null, bytes: 0, format, error: 'Mismatched video chunk total' }
        }
        const piece = typeof input.base64 === 'string' ? input.base64 : ''
        if (slot.chunks[idx] === undefined) {
          slot.received += 1
          slot.totalLen += piece.length
        }
        if (slot.totalLen > 90 * 1024 * 1024) {
          pendingVideoUploads.delete(input.uploadId)
          return { saved: false, path: null, bytes: 0, format, error: 'Video upload exceeds size limit' }
        }
        slot.chunks[idx] = piece
        if (slot.received < slot.total) {
          return { saved: false, path: null, bytes: 0, format, chunkAccepted: true }
        }
        pendingVideoUploads.delete(input.uploadId)
        finalInput = {
          base64: slot.chunks.join(''),
          mimeType: input.mimeType,
          filename: input.filename,
          reveal: input.reveal
        }
      }

      const out = await videoSaver(finalInput)
      if (out.saved && out.path) {
        const mb = (out.bytes / (1024 * 1024)).toFixed(2)
        pushLog('system', `EXPORTED VIDEO (${out.format.toUpperCase()} · ${mb}MB) :: ${path.basename(out.path)}`)
      }
      return out
    } catch (err) {
      if (input?.uploadId) pendingVideoUploads.delete(input.uploadId)
      return {
        saved: false,
        path: null,
        bytes: 0,
        format,
        error: err instanceof Error ? err.message : 'Save video failed'
      }
    }
  }

  const ensureWallServer = async (): Promise<string> => {
    if (wallServer && wallPort > 0 && wallToken) {
      return `http://127.0.0.1:${wallPort}/?wall=1&token=${wallToken}`
    }
    wallToken = crypto.randomBytes(16).toString('hex')
    const panelPath = resolvePanelHtmlPath()

    const srv = http.createServer((req, res) => {
      const reqUrl = req.url || '/'
      const qIdx = reqUrl.indexOf('?')
      const pathname = qIdx >= 0 ? reqUrl.slice(0, qIdx) : reqUrl
      const queryStr = qIdx >= 0 ? reqUrl.slice(qIdx + 1) : ''
      const params = new Map<string, string>()
      for (const pair of queryStr.split('&')) {
        if (!pair) continue
        const eq = pair.indexOf('=')
        const k = eq >= 0 ? decodeURIComponent(pair.slice(0, eq)) : decodeURIComponent(pair)
        const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : ''
        params.set(k, v)
      }
      const hdrTok = req.headers['x-hq-token']
      const tok = params.get('token') || (Array.isArray(hdrTok) ? hdrTok[0] : hdrTok) || ''
      if (tok !== wallToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (pathname === '/' && req.method === 'GET') {
        void fs.readFile(panelPath, 'utf8')
          .then((html) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(html)
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Failed to load panel.html')
          })
        return
      }

      if (pathname === '/api/snapshot' && req.method === 'GET') {
        void (latestSnapshot ? Promise.resolve(latestSnapshot) : refreshAndBroadcast())
          .then((s) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(s))
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end('{"error":"snapshot_failed"}')
          })
        return
      }

      if (pathname === '/api/refresh' && req.method === 'POST') {
        void refreshAndBroadcast()
          .then((s) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(s))
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end('{"error":"refresh_failed"}')
          })
        return
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        sseClients.add(res)
        if (latestSnapshot) {
          res.write(`event: snapshot\ndata: ${JSON.stringify(latestSnapshot)}\n\n`)
        }
        req.on('close', () => { sseClients.delete(res) })
        return
      }

      if (pathname === '/api/open-session' && req.method === 'POST') {
        void readJsonBody(req)
          .then(async (body) => {
            const out = await handleOpenSession((body || {}) as OpenSessionInput)
            if (out.opened) {
              await execFileAsync('open', ['-a', 'Orca'], { timeout: 2500 }).catch(() => null)
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(out))
          })
          .catch(() => {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end('{"opened":false,"mode":"none","detail":"Bad request"}')
          })
        return
      }

      if (pathname === '/api/save-video' && req.method === 'POST') {
        void readJsonBody(req)
          .then(async (body) => {
            const out = await handleSaveVideo((body || {}) as SaveVideoInput)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(out))
          })
          .catch(() => {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end('{"saved":false,"path":null,"bytes":0,"format":"webm","error":"Bad request"}')
          })
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    })

    await new Promise<void>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = srv.address()
    wallServer = srv
    wallPort = typeof addr === 'object' && addr ? addr.port : 0
    return `http://127.0.0.1:${wallPort}/?wall=1&token=${wallToken}`
  }

  orca.panels.handle('hq.openSession', handleOpenSession)
  orca.panels.handle('hq.saveVideo', handleSaveVideo)
  orca.panels.handle('hq.openFullscreenWall', async (): Promise<OpenWallOutput> => {
    try {
      const url = await ensureWallServer()
      const opened = await wallOpener(url)
      if (opened) pushLog('system', `LAUNCHED FULLSCREEN COMMAND WALL :: 127.0.0.1:${wallPort}`)
      return { opened, url }
    } catch (err) {
      return { opened: false, url: null, error: err instanceof Error ? err.message : 'Failed to open fullscreen wall' }
    }
  })

  orca.commands.register('cyber-hq-radar.refresh', async () => {
    const snap = await refreshAndBroadcast()
    return `Cyber HQ refreshed: ${snap.summary.onlineHosts} hosts, ${snap.summary.totalBots} bots, ${snap.summary.activeWorkers} active workers`
  })

  orca.events.on('agent.status.changed', (ev) => {
    const label = ev.title || ev.terminalId || 'agent'
    pushLog('status', `AGENT [${ev.state.toUpperCase()}] :: ${label}`)
    scheduleRefresh()
  })

  orca.events.on('workspace.created', (ev) => {
    pushLog('workspace', `SPAWN WORKTREE :: ${ev.branch || ev.path}`)
    scheduleRefresh()
  })

  orca.events.on('workspace.removed', (ev) => {
    pushLog('workspace', `PURGE WORKTREE :: ${ev.path}`)
    scheduleRefresh()
  })

  void refreshAndBroadcast()
  void readPluginConfig(orca).then((cfg) => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      void refreshAndBroadcast()
    }, cfg.pollIntervalSec * 1000)
  })
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  for (const res of sseClients) {
    try { res.end() } catch {}
  }
  sseClients.clear()
  if (wallServer) {
    try { wallServer.close() } catch {}
    wallServer = null
    wallPort = 0
    wallToken = ''
  }
}
