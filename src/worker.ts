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
  NeedsYouItem,
  OpenNeedsYouInput,
  OpenNeedsYouOutput,
  OpenSessionInput,
  OpenSessionOutput,
  OpenWallOutput,
  SaveEndpointOutput,
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

export type RawBotDispatch = {
  bot: string
  dispatchId?: string | null
  workspace?: string | null
  server?: string | null
  title?: string | null
  state?: string | null
  startedAt?: number | null
}

export type RawNeedsYouItem = {
  id?: string | null
  uid?: string | null
  number?: number | null
  bot?: string | null
  owner?: { botId?: string | null; name?: string | null } | null
  title?: string | null
  status?: string | null
  question?:
    | string
    | {
        eventId?: string | null
        text?: string | null
        gist?: string | null
        decisions?: Array<{
          question?: string | null
          replies?: Array<{ label?: string | null; recommended?: boolean }> | null
        }> | null
      }
    | null
  replyCount?: number | null
  chatId?: string | null
  chatTitle?: string | null
  chat?: { id?: string | null; kind?: string | null; title?: string | null } | null
  snoozedUntil?: number | null
  updatedAt?: number | null
  lastActivityAt?: number | null
}

export type HubRelayChildPayload = {
  env?: RawEnv
  envName?: string
  viaChain?: string
  ok?: boolean
  workers?: RawRemoteWorker[]
  remotePs?: RawWorktreePs[]
  bots?: RawBot[]
  dispatches?: RawBotDispatch[]
  needsYou?: RawNeedsYouItem[]
  metrics?: HostMetrics | null
}

export type HubRelaySnapshotPayload = {
  ok?: boolean
  host?: {
    hostname?: string
    metrics?: HostMetrics | null
    bots?: RawBot[]
    worktrees?: RawWorktreePs[]
    dispatches?: RawBotDispatch[]
    needsYou?: RawNeedsYouItem[]
  }
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

function isTailscaleIp(ip: string | null | undefined): boolean {
  if (!ip) return false
  const m = ip.trim().match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
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
    const baseUrl = (sepIdx > 0 ? rest.slice(0, sepIdx) : rest).trim().replace(/\/+$/, '')
    const token = sepIdx > 0 ? rest.slice(sepIdx + 1).trim() : ''
    if (!key || !/^https?:\/\/[^/\s]+/i.test(baseUrl)) continue
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
      Accept: 'application/json'
    }
    if (token) headers.Authorization = `Bearer ${token}`
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
    const res = await httpJsonRequest(`${target.baseUrl}/v1/relay-snapshot`, 'GET', target.token, undefined, 10000)
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
    const cleanEnv: Record<string, string | undefined> = { ...process.env }
    delete cleanEnv.ORCA_BOT_TOOLS_TOKEN
    delete cleanEnv.ORCA_AGENT_SESSION_ID
    delete cleanEnv.ORCA_AGENT_SESSION_SPAWN_TOKEN
    const { stdout } = await execFileAsync(defaultOrcaBin(), args, {
      timeout: 4500,
      maxBuffer: 4 * 1024 * 1024,
      env: cleanEnv
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
  const now = new Date()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
  const cleanName = input.filename
    ? path.basename(input.filename).replace(/[^a-zA-Z0-9._-]/g, '_')
    : `cyber-hq-radar-${stamp}.${format}`
  const finalName = cleanName.endsWith(`.${format}`) ? cleanName : `${cleanName}.${format}`
  const candidateDirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'CyberHQ-Videos')
  ]
  let outPath = ''
  let lastErr: unknown = null
  for (const dir of candidateDirs) {
    try {
      await fs.mkdir(dir, { recursive: true })
      const targetPath = path.join(dir, finalName)
      await fs.writeFile(targetPath, bytesBuf)
      outPath = targetPath
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!outPath) {
    return {
      saved: false,
      path: null,
      bytes: 0,
      format,
      error: lastErr instanceof Error ? lastErr.message : 'Unable to write video file to disk'
    }
  }
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
    'OS=$(uname -s); echo "OS:$OS";',
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

export function stripOsHomePrefix(rawPath: string | null | undefined): string {
  const s = String(rawPath || '')
  const wsIdx = s.toLowerCase().indexOf('/workspaces/')
  if (wsIdx >= 0) return s.slice(wsIdx + '/workspaces/'.length)
  return s.replace(/^\/(?:Users|home)\/[^/]+\/?/i, '')
}

export function classifySquad(name: string | null | undefined, knownSquads?: Iterable<string>): BotSquad {
  const raw = (name || '').trim()
  if (!raw) return 'fleet'
  const lower = raw.toLowerCase()
  if (lower.includes('copilot') || lower.includes('orchestrator') || lower.includes('hq')) return 'command'
  if (knownSquads) {
    const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
    for (const sq of knownSquads) {
      if (!sq || sq === 'command' || sq === 'fleet') continue
      if (tokens.includes(sq) || lower.includes(sq)) return sq
      // Match abbreviated repo/ticket prefixes (e.g. 4+ char prefix of a known squad name)
      if (tokens.some((t) => t.length >= 4 && sq.startsWith(t))) return sq
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

export function formatWorktreeTitle(
  displayName?: string | null,
  repo?: string | null,
  branch?: string | null,
  fallback = 'workspace'
): string {
  const cleanBranch = branch ? branch.replace(/^refs\/heads\//, '').trim() : ''
  const dn = (displayName || '').trim()
  const rp = (repo || '').trim()
  const base = dn || cleanBranch || rp || fallback
  if (
    rp &&
    base &&
    rp.toLowerCase() !== base.toLowerCase() &&
    (/^(?:main|master|develop|dev|staging|prod|release)$/i.test(base) || (cleanBranch && base === cleanBranch))
  ) {
    return `${rp} / ${base}`
  }
  return base
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

export function mapWorkerState(
  rawState: string | undefined,
  liveness?: string,
  agentState?: string
): WorkerNodeInfo['state'] {
  if (agentState === 'working' || rawState === 'working') return 'working'
  if (rawState === 'permission' || rawState === 'blocked' || agentState === 'blocked') return 'permission'
  if (rawState === 'succeeded' || rawState === 'done') return 'succeeded'
  if (rawState === 'failed') return 'failed'
  if (rawState === 'stopped') return 'stopped'
  if (
    liveness === 'live' &&
    rawState !== 'inactive' &&
    rawState !== 'idle' &&
    rawState !== 'succeeded' &&
    rawState !== 'done' &&
    rawState !== 'failed' &&
    rawState !== 'stopped'
  ) {
    return 'working'
  }
  return 'idle'
}

function normalizeNeedsYouText(raw: string | null | undefined, maxLen = 110): string | null {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s
}

function extractNeedsYouQuestion(q: RawNeedsYouItem['question']): { question: string | null; replyCount: number } {
  if (!q) return { question: null, replyCount: 0 }
  if (typeof q === 'string') {
    return { question: normalizeNeedsYouText(q, 110), replyCount: 0 }
  }
  const decisions = Array.isArray(q.decisions) ? q.decisions : []
  const replyCount = decisions.reduce(
    (acc, d) => acc + (Array.isArray(d?.replies) ? d.replies.length : 0),
    0
  )
  const firstDecQ = decisions[0]?.question
  if (typeof firstDecQ === 'string' && firstDecQ.trim()) {
    return { question: normalizeNeedsYouText(firstDecQ, 110), replyCount }
  }
  if (typeof q.gist === 'string' && q.gist.trim()) {
    return { question: normalizeNeedsYouText(q.gist, 110), replyCount }
  }
  if (typeof q.text === 'string' && q.text.trim()) {
    const firstLine = q.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (firstLine) return { question: normalizeNeedsYouText(firstLine, 110), replyCount }
  }
  return { question: null, replyCount }
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
        cli(['worktree', 'ps', '--since', '7d', '--json']),
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
    hostedBots: RawBot[]
    dispatches: RawBotDispatch[]
    needsYou: RawNeedsYouItem[]
    metrics: HostMetrics | null
  }

  const directRemoteResults: RemoteHostResult[] = await Promise.all(
    rawEnvs.map(async (env) => {
      const envName = env.name || env.id || 'remote'
      const endpointHost = extractEndpointHost(env.endpoints?.[0]?.endpoint)
      const sshTarget = lookupSshTarget(cfg, envName, endpointHost)
      const explicitRelay = cfg.hubRelays[envName] || cfg.hubRelays[envName.toLowerCase()] || null
      // Zero-config Tailscale WhoIs auto-discovery on default relay port 19768
      const probeRelay: HubRelayTarget | null =
        explicitRelay || (isTailscaleIp(endpointHost) ? { baseUrl: `http://${endpointHost}:19768`, token: '' } : null)
      const [res, remotePsRes, envBotsRes, httpRelaySnap] = await Promise.all([
        cli(['orchestration', 'worker-list', '--environment', envName, '--json']),
        cli(['worktree', 'ps', '--environment', envName, '--since', '7d', '--json']),
        cli(['bot', 'list', '--environment', envName, '--json']),
        probeRelay ? hubRelayClient.fetchSnapshot(probeRelay).catch(() => null) : Promise.resolve(null)
      ])
      const activeHttpRelay = httpRelaySnap ? probeRelay : null
      const metrics =
        httpRelaySnap?.host?.metrics ?? (await metricsRunner(envName, sshTarget, null).catch(() => null))
      const workers = Array.isArray((res as { workers?: unknown })?.workers)
        ? ((res as { workers: RawRemoteWorker[] }).workers)
        : []
      const cliRemotePs = Array.isArray((remotePsRes as { worktrees?: unknown })?.worktrees)
        ? ((remotePsRes as { worktrees: RawWorktreePs[] }).worktrees)
        : []
      const relayWorktrees = Array.isArray(httpRelaySnap?.host?.worktrees) ? httpRelaySnap.host.worktrees : []
      const remotePs = relayWorktrees.length > 0 ? [...relayWorktrees, ...cliRemotePs] : cliRemotePs
      const relayBots = Array.isArray(httpRelaySnap?.host?.bots) ? httpRelaySnap.host.bots : []
      const cliBots = Array.isArray((envBotsRes as { bots?: unknown })?.bots)
        ? ((envBotsRes as { bots: RawBot[] }).bots)
        : []
      const hostedBots = relayBots.length > 0 ? relayBots : cliBots
      const dispatches = Array.isArray(httpRelaySnap?.host?.dispatches) ? httpRelaySnap.host.dispatches : []
      const needsYou = Array.isArray(httpRelaySnap?.host?.needsYou) ? httpRelaySnap.host.needsYou : []
      return {
        env,
        envName,
        sshTarget,
        httpRelay: activeHttpRelay,
        httpRelaySnap,
        viaHub: null,
        viaHubSsh: null,
        ok: res !== null || remotePsRes !== null || httpRelaySnap !== null,
        workers,
        remotePs,
        hostedBots,
        dispatches,
        needsYou,
        metrics
      }
    })
  )

  // Hub Relay Discovery: prefer Zero-SSH HTTP Hub Relay (explicit or Tailscale auto-discovered), else fall back to SSH Hub Relay
  const seenEnvNames = new Set<string>(['local', ...directRemoteResults.map((r) => r.envName.toLowerCase())])
  const localHostNorm = cleanLocalHostLabel().toLowerCase()
  const relayedResults: RemoteHostResult[] = []

  for (const hub of directRemoteResults) {
    if (!hub.httpRelay || !hub.httpRelaySnap) continue
    if (hubHttpByHostOut) hubHttpByHostOut.set(hub.envName, hub.httpRelay)
    if (!Array.isArray(hub.httpRelaySnap.children)) continue
    for (const ch of hub.httpRelaySnap.children) {
      const childName = ch.envName || ch.env?.name || ch.env?.id || ''
      if (!childName) continue
      const lower = childName.toLowerCase()
      if (seenEnvNames.has(lower) || lower === localHostNorm) continue
      seenEnvNames.add(lower)
      if (hubHttpByHostOut) hubHttpByHostOut.set(childName, hub.httpRelay)
      const viaLabel = ch.viaChain ? `${hub.envName} → ${ch.viaChain}` : hub.envName
      relayedResults.push({
        env: ch.env || { name: childName },
        envName: childName,
        sshTarget: childName,
        httpRelay: null,
        httpRelaySnap: null,
        viaHub: viaLabel,
        viaHubSsh: null,
        ok: Boolean(ch.ok || ch.metrics || (ch.workers && ch.workers.length) || (ch.remotePs && ch.remotePs.length)),
        workers: Array.isArray(ch.workers) ? ch.workers : [],
        remotePs: Array.isArray(ch.remotePs) ? ch.remotePs : [],
        hostedBots: Array.isArray(ch.bots) ? ch.bots : [],
        dispatches: Array.isArray(ch.dispatches) ? ch.dispatches : [],
        needsYou: Array.isArray(ch.needsYou) ? ch.needsYou : [],
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
            hostedBots: [],
            dispatches: [],
            needsYou: [],
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

  // Merge any Bots reported by remote hubs that weren't in local rawBots
  const knownBotNames = new Set(rawBots.map((b) => (b.name || '').toLowerCase()))
  for (const r of remoteResults) {
    for (const hb of r.hostedBots) {
      const k = (hb.name || '').toLowerCase()
      if (k && !knownBotNames.has(k)) {
        knownBotNames.add(k)
        rawBots.push(hb)
      }
    }
  }

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

  // Index Bot Homes & Environment IDs across ALL machines (stripping runtime: prefix)
  const envNameById = new Map<string, string>()
  for (const r of remoteResults) {
    const name = r.envName
    if (!name) continue
    envNameById.set(name.toLowerCase(), name)
    if (r.env.id) {
      envNameById.set(r.env.id.toLowerCase(), name)
      envNameById.set(`runtime:${r.env.id.toLowerCase()}`, name)
    }
  }
  const resolveHostId = (rawHostId?: string | null): HostId => {
    if (!rawHostId || rawHostId === 'local') return 'local'
    const lower = rawHostId.toLowerCase()
    const stripped = lower.replace(/^runtime:/, '')
    return envNameById.get(lower) || envNameById.get(stripped) || rawHostId
  }

  const psByBotHome = new Map<string, RawWorktreePs>()
  const botHostByName = new Map<string, HostId>()
  const botNameByWorkspaceId = new Map<string, string>()
  const ambiguousBareWorkspaces = new Set<string>()
  const hostWsByBotName = new Map<string, string>()
  const globalPsByWorkspace = new Map<string, RawWorktreePs>()

  const registerBotWorkspace = (ownerHost: HostId, worktreeId: string, botName: string) => {
    if (!worktreeId || !botName) return
    botNameByWorkspaceId.set(`${ownerHost}::${worktreeId}`, botName)
    if (!ambiguousBareWorkspaces.has(worktreeId)) {
      const existingBare = botNameByWorkspaceId.get(worktreeId)
      if (!existingBare) {
        botNameByWorkspaceId.set(worktreeId, botName)
      } else if (existingBare !== botName) {
        ambiguousBareWorkspaces.add(worktreeId)
        botNameByWorkspaceId.delete(worktreeId)
      }
    }
  }

  const lookupBotByWorkspaceId = (
    worktreeId: string | null | undefined,
    ...preferredHosts: (HostId | null | undefined)[]
  ): string | null => {
    if (!worktreeId) return null
    for (const h of preferredHosts) {
      if (!h) continue
      const scoped = botNameByWorkspaceId.get(`${h}::${worktreeId}`)
      if (scoped) return scoped
    }
    return botNameByWorkspaceId.get(worktreeId) || null
  }

  for (const ws of hostWorkspaces) {
    if (ws.kind === 'folder' && ws.name) {
      hostWsByBotName.set(ws.name.toLowerCase(), ws.id)
      const ownerHost = resolveHostId(ws.hostId)
      registerBotWorkspace(ownerHost, ws.id, ws.name)
    }
  }

  const localBotHomes = new Set<string>()
  for (const row of rawLocalPs) {
    if (row.worktreeId && !globalPsByWorkspace.has(row.worktreeId)) {
      globalPsByWorkspace.set(row.worktreeId, row)
    }
    if (row.botHome && row.bot) {
      const ownerHost = resolveHostId(row.hostId)
      psByBotHome.set(row.bot, row)
      botHostByName.set(row.bot, ownerHost)
      if (ownerHost === 'local') localBotHomes.add(row.bot)
      if (row.worktreeId) registerBotWorkspace(ownerHost, row.worktreeId, row.bot)
    }
  }

  // Authoritative Bot ownership from each remote/relayed host's own bot list & botHome records
  for (const { envName, remotePs, hostedBots, httpRelay } of remoteResults) {
    for (const hb of hostedBots) {
      if (hb.name && (httpRelay || !localBotHomes.has(hb.name))) {
        botHostByName.set(hb.name, envName)
      }
    }
    for (const row of remotePs) {
      if (row.worktreeId) {
        const existing = globalPsByWorkspace.get(row.worktreeId)
        if (!existing || (row.bot && !existing.bot) || (row.lastActivityAt ?? 0) > (existing.lastActivityAt ?? 0)) {
          globalPsByWorkspace.set(row.worktreeId, row)
        }
      }
      if (row.botHome && row.bot) {
        const ownerHost = row.hostId && row.hostId !== 'local' ? resolveHostId(row.hostId) : envName
        const existingHost = botHostByName.get(row.bot)
        const existingTs = psByBotHome.get(row.bot)?.lastActivityAt ?? -1
        const nextTs = row.lastActivityAt ?? 0
        if (!existingHost || existingHost === 'local' || existingHost === envName || nextTs >= existingTs) {
          psByBotHome.set(row.bot, row)
          botHostByName.set(row.bot, envName)
        }
        if (row.worktreeId) registerBotWorkspace(ownerHost, row.worktreeId, row.bot)
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

  // Collect authoritative real dispatch records (dispatchId -> Bot + server + title) from local Bots + remote hubs
  const dispatchById = new Map<string, RawBotDispatch>()
  const dispatchByWorkspace = new Map<string, RawBotDispatch>()
  const botTrafficServers = new Map<string, { server: string; startedAt: number; state: string | null }[]>()

  const ingestDispatch = (d: RawBotDispatch, sourceHost: HostId) => {
    if (!d?.bot) return
    if (d.dispatchId && !dispatchById.has(d.dispatchId)) {
      dispatchById.set(d.dispatchId, d)
    }
    if (d.workspace && !dispatchByWorkspace.has(d.workspace)) {
      dispatchByWorkspace.set(d.workspace, d)
    }
    const rawSrv = typeof d.server === 'string' ? d.server.trim() : ''
    const resolvedSrv = (!rawSrv || rawSrv.toLowerCase() === 'local') ? sourceHost : resolveHostId(rawSrv)
    if (resolvedSrv) {
      const list = botTrafficServers.get(d.bot) || []
      list.push({ server: resolvedSrv, startedAt: d.startedAt ?? 0, state: d.state || null })
      botTrafficServers.set(d.bot, list)
    }
  }

  const rawNeedsYouEntries: Array<{ raw: RawNeedsYouItem; sourceHost: HostId; fallbackBot?: string }> = []

  for (const r of remoteResults) {
    for (const d of r.dispatches) ingestDispatch(d, r.envName)
    for (const ny of r.needsYou) rawNeedsYouEntries.push({ raw: ny, sourceHost: r.envName })
  }

  // Also query local Bot work lists & needs-you queues for Bots hosted locally (never guessing from names)
  const localOwnedBots = rawBots.filter((b) => {
    if (!b.name) return false
    const owner = botHostByName.get(b.name) || controlHostId
    return owner === 'local'
  })
  if (includeLocal && localOwnedBots.length > 0) {
    const localBotPolls = await Promise.all(
      localOwnedBots.map(async (b) => {
        const [res, nyRes] = await Promise.all([
          cli(['bot', 'work', 'list', '--bot', b.name!, '--json']).catch(() => null),
          cli(['bot', 'item', 'list', '--bot', b.name!, '--status', 'needs-you', '--json']).catch(() => null)
        ])
        const items = Array.isArray((res as { items?: unknown })?.items)
          ? ((res as { items: Array<{ dispatchId?: string | null; workspace?: string | null; server?: string | null; title?: string | null; state?: string | null; startedAt?: number | null }> }).items)
          : []
        const dispatches = items.slice(0, 20).map((it): RawBotDispatch => ({
          bot: b.name!,
          dispatchId: it.dispatchId || null,
          workspace: it.workspace || null,
          server: it.server || null,
          title: it.title || null,
          state: it.state || null,
          startedAt: typeof it.startedAt === 'number' ? it.startedAt : null
        }))
        const nyItems = Array.isArray((nyRes as { items?: unknown })?.items)
          ? ((nyRes as { items: RawNeedsYouItem[] }).items)
          : []
        return { botName: b.name!, dispatches, nyItems }
      })
    )
    for (const row of localBotPolls) {
      for (const d of row.dispatches) ingestDispatch(d, 'local')
      for (const ny of row.nyItems) {
        rawNeedsYouEntries.push({ raw: ny, sourceHost: 'local', fallbackBot: row.botName })
      }
    }
  }

  // Direct paired control host without HTTP hub relay: query needs-you items via paired CLI
  if (controlHostId !== 'local') {
    const ctrlRemote = directRemoteResults.find((r) => r.envName === controlHostId)
    if (!ctrlRemote?.httpRelay) {
      const ctrlOwnedBots = rawBots.filter((b) => {
        if (!b.name) return false
        const owner = botHostByName.get(b.name) || controlHostId
        return owner === controlHostId
      })
      if (ctrlOwnedBots.length > 0) {
        const ctrlNyPolls = await Promise.all(
          ctrlOwnedBots.map(async (b) => {
            const nyRes = await cli([
              'bot', 'item', 'list', '--environment', controlHostId, '--bot', b.name!, '--status', 'needs-you', '--json'
            ]).catch(() => null)
            const nyItems = Array.isArray((nyRes as { items?: unknown })?.items)
              ? ((nyRes as { items: RawNeedsYouItem[] }).items)
              : []
            return { botName: b.name!, nyItems }
          })
        )
        for (const row of ctrlNyPolls) {
          for (const ny of row.nyItems) {
            rawNeedsYouEntries.push({ raw: ny, sourceHost: controlHostId, fallbackBot: row.botName })
          }
        }
      }
    }
  }

  const knownSquads = new Set<string>(rawBots.map((b) => classifySquad(b.name)))

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
      const host = resolveHostId(row.hostId)
      const parentWsKey = row.crossStoreParent?.parent?.workspaceKey || null
      const dispatchRec = (row.worktreeId && dispatchByWorkspace.get(row.worktreeId)) || null
      // Strictly real Orca provenance: crossStoreParent, explicit row.bot, or real bot work dispatch
      const bot = lookupBotByWorkspaceId(parentWsKey, host, 'local', controlHostId) || row.bot || dispatchRec?.bot || null
      const cleanLocalPath = stripOsHomePrefix(row.path)
      const squad = classifySquad(bot || `${row.displayName || ''} ${row.repo || ''} ${row.branch || ''} ${cleanLocalPath}`, knownSquads)
      workers.push({
        id: wtId || `${row.repo}:${row.displayName}`,
        title: formatWorktreeTitle(row.displayName, row.repo, row.branch, 'workspace'),
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
        sessionTitle: pickAgentSummary(bestAgent) || dispatchRec?.title || null,
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: row.lastActivityAt ?? dispatchRec?.startedAt ?? null
      })
    }
  }

  const terminalOrIdleStates = new Set(['inactive', 'idle', 'succeeded', 'done', 'failed', 'stopped'])
  const workerStateScore = (s: WorkerNodeInfo['state']) =>
    s === 'working' ? 3 : s === 'permission' ? 2 : s === 'succeeded' ? 1 : 0

  for (const { envName, viaHub, workers: rWorkers, remotePs } of remoteResults) {
    const hubChainHosts = viaHub
      ? viaHub.split(/\s*(?:→|->)\s*/).map((s) => s.trim()).filter(Boolean).reverse()
      : []
    const psByWorkspace = new Map<string, RawWorktreePs>()
    for (const rps of remotePs) {
      if (!rps.worktreeId) continue
      const existing = psByWorkspace.get(rps.worktreeId)
      if (!existing || (rps.bot && !existing.bot) || (rps.lastActivityAt ?? 0) > (existing.lastActivityAt ?? 0)) {
        psByWorkspace.set(rps.worktreeId, rps)
      }
    }

    // Sort rWorkers BEFORE deduplicating/trimming so active working/live workers always win over older exited entries
    const remoteWorkerPriority = (w: RawRemoteWorker): number => {
      if (w.state === 'working') return 4
      if (w.state === 'permission' || w.state === 'blocked') return 3
      if (w.liveness === 'live' && (!w.state || !terminalOrIdleStates.has(w.state))) return 2
      if (w.state === 'succeeded' || w.state === 'done') return 1
      return 0
    }
    const sortedRWorkers = [...rWorkers].sort((a, b) => {
      const pDiff = remoteWorkerPriority(b) - remoteWorkerPriority(a)
      if (pDiff !== 0) return pDiff
      const aPs = a.workspace ? (psByWorkspace.get(a.workspace) || globalPsByWorkspace.get(a.workspace)) : undefined
      const bPs = b.workspace ? (psByWorkspace.get(b.workspace) || globalPsByWorkspace.get(b.workspace)) : undefined
      const aAgentWorking = pickBestAgent(aPs?.agents)?.state === 'working' ? 1 : 0
      const bAgentWorking = pickBestAgent(bPs?.agents)?.state === 'working' ? 1 : 0
      if (bAgentWorking !== aAgentWorking) return bAgentWorking - aAgentWorking
      const aTs = Number(
        (a.dispatchId ? dispatchById.get(a.dispatchId)?.startedAt : null) ??
          aPs?.lastActivityAt ??
          (a.workspace ? dispatchByWorkspace.get(a.workspace)?.startedAt : null) ??
          0
      )
      const bTs = Number(
        (b.dispatchId ? dispatchById.get(b.dispatchId)?.startedAt : null) ??
          bPs?.lastActivityAt ??
          (b.workspace ? dispatchByWorkspace.get(b.workspace)?.startedAt : null) ??
          0
      )
      return bTs - aTs
    })

    const seenRemoteWs = new Set<string>()
    for (const w of sortedRWorkers) {
      const ws = w.workspace || ''
      if (ws && seenRemoteWs.has(ws)) continue
      if (ws) seenRemoteWs.add(ws)
      const matchedPs = ws ? (psByWorkspace.get(ws) || globalPsByWorkspace.get(ws)) : undefined
      if (matchedPs?.botHome || matchedPs?.repo === 'Bots') continue
      const bestAgent = pickBestAgent(matchedPs?.agents)
      const wsPath = matchedPs?.path || (ws.includes('::') ? ws.split('::')[1] : ws)
      const shortName = formatWorktreeTitle(
        matchedPs?.displayName,
        matchedPs?.repo,
        matchedPs?.branch,
        wsPath.split('/').filter(Boolean).pop() || w.dispatchId || 'worker'
      )
      const mapped = mapWorkerState(w.state, w.liveness, bestAgent?.state)
      if (mapped !== 'working' && workers.filter((x) => x.host === envName).length >= 5) continue

      const parentWsKey = matchedPs?.crossStoreParent?.parent?.workspaceKey || null
      const dispatchRec = (w.dispatchId && dispatchById.get(w.dispatchId)) || (ws && dispatchByWorkspace.get(ws)) || null
      // Strictly real Orca provenance: real dispatchId, crossStoreParent, or explicit matchedPs.bot (zero name guessing)
      const bot =
        dispatchRec?.bot ||
        lookupBotByWorkspaceId(parentWsKey, envName, ...hubChainHosts, controlHostId) ||
        matchedPs?.bot ||
        null
      const cleanRemotePath = stripOsHomePrefix(wsPath)
      const squad = classifySquad(bot || `${shortName} ${matchedPs?.repo || ''} ${cleanRemotePath}`, knownSquads)

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
        sessionTitle: pickAgentSummary(bestAgent) || dispatchRec?.title || null,
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: matchedPs?.lastActivityAt ?? dispatchRec?.startedAt ?? null
      })
    }

    const sortedRemotePs = [...remotePs].sort((a, b) => {
      const aState = mapWorkerState(a.status, undefined, pickBestAgent(a.agents)?.state)
      const bState = mapWorkerState(b.status, undefined, pickBestAgent(b.agents)?.state)
      const diff = workerStateScore(bState) - workerStateScore(aState)
      if (diff !== 0) return diff
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })

    for (const rps of sortedRemotePs) {
      const ws = rps.worktreeId || ''
      if (!ws || seenRemoteWs.has(ws)) continue
      if (rps.botHome || rps.repo === 'Bots') continue
      // Skip worktrees whose resolved runtime host belongs to a different paired node (e.g. hub's ps listing a downstream Ubuntu worker)
      const rpsResolvedHost = rps.hostId && rps.hostId !== 'local' ? resolveHostId(rps.hostId) : envName
      if (rpsResolvedHost !== envName) continue
      seenRemoteWs.add(ws)
      const bestAgent = pickBestAgent(rps.agents)
      const mapped = mapWorkerState(rps.status, undefined, bestAgent?.state)
      if (mapped !== 'working' && workers.filter((x) => x.host === envName).length >= 5) continue
      const parentWsKey = rps.crossStoreParent?.parent?.workspaceKey || null
      const dispatchRec = dispatchByWorkspace.get(ws) || null
      const bot =
        lookupBotByWorkspaceId(parentWsKey, envName, ...hubChainHosts, controlHostId) ||
        rps.bot ||
        dispatchRec?.bot ||
        null
      const cleanRpsPath = stripOsHomePrefix(rps.path)
      const squad = classifySquad(bot || `${rps.displayName || ''} ${rps.repo || ''} ${cleanRpsPath}`, knownSquads)
      workers.push({
        id: ws,
        title: formatWorktreeTitle(rps.displayName, rps.repo, rps.branch, 'workspace'),
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
        sessionTitle: pickAgentSummary(bestAgent) || dispatchRec?.title || null,
        activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
        lastActivityAt: rps.lastActivityAt ?? dispatchRec?.startedAt ?? null
      })
    }
  }

  if (includeLocal && rawLocalPs.length === 0 && hostWorkspaces.length > 0) {
    for (const ws of hostWorkspaces) {
      if (ws.kind !== 'worktree' || seenWorkspaces.has(ws.id)) continue
      const mapped = mapWorkerState(ws.status?.state)
      const host = ws.hostId || 'local'
      const dispatchRec = dispatchByWorkspace.get(ws.id) || null
      const squad = classifySquad(dispatchRec?.bot || ws.project || ws.name || ws.path, knownSquads)
      workers.push({
        id: ws.id,
        title: ws.name || ws.branch || 'worktree',
        host,
        bot: dispatchRec?.bot || null,
        parentBotWorkspaceId: null,
        squad,
        agent: 'antigravity',
        state: mapped,
        branch: ws.branch,
        workspaceId: ws.id,
        workspacePath: ws.path,
        sessionId: null,
        terminalId: null,
        sessionTitle: dispatchRec?.title || null,
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

  workers.sort((a, b) => {
    const diff = workerStateScore(b.state) - workerStateScore(a.state)
    if (diff !== 0) return diff
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })

  // Fair per-host trimming: always preserve EVERY working worker across all hosts,
  // plus recent workers up to 5 per host, capped at 24 total via round-robin across hosts.
  const hostOrderForTrim = hosts.map((h) => h.id)
  for (const w of workers) {
    if (!hostOrderForTrim.includes(w.host)) hostOrderForTrim.push(w.host)
  }
  const workingWorkers: WorkerNodeInfo[] = []
  const workingCountByHost = new Map<string, number>()
  const recentQueueByHost = new Map<string, WorkerNodeInfo[]>()
  for (const hid of hostOrderForTrim) recentQueueByHost.set(hid, [])
  for (const w of workers) {
    if (w.state === 'working') {
      workingWorkers.push(w)
      workingCountByHost.set(w.host, (workingCountByHost.get(w.host) || 0) + 1)
    } else {
      const q = recentQueueByHost.get(w.host) || []
      q.push(w)
      recentQueueByHost.set(w.host, q)
    }
  }
  const perHostRecentQueues: WorkerNodeInfo[][] = hostOrderForTrim.map((hid) => {
    const wkWorking = workingCountByHost.get(hid) || 0
    const recentAllowance = Math.max(0, 5 - wkWorking)
    return (recentQueueByHost.get(hid) || []).slice(0, recentAllowance)
  })
  const trimmedWorkers: WorkerNodeInfo[] = [...workingWorkers]
  const nonWorkingBudget = Math.max(0, 24 - workingWorkers.length)
  let addedNonWorking = 0
  for (let slot = 0; slot < 5 && addedNonWorking < nonWorkingBudget; slot++) {
    for (const q of perHostRecentQueues) {
      if (addedNonWorking >= nonWorkingBudget) break
      if (slot < q.length) {
        trimmedWorkers.push(q[slot])
        addedNonWorking += 1
      }
    }
  }
  trimmedWorkers.sort((a, b) => {
    const diff = workerStateScore(b.state) - workerStateScore(a.state)
    if (diff !== 0) return diff
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })

  const validHostIds = new Set(hosts.map((h) => h.id))
  const recentCutoffMs = Date.now() - 6 * 60 * 60 * 1000
  const isLiveDispatchState = (s?: string | null): boolean => {
    const v = (s || '').toLowerCase()
    return v === 'running' || v === 'working'
  }

  // Aggregate fleet-wide Needs You items (real bot item list + permission-blocked workers), deduped & sorted newest first
  const nowMs = Date.now()
  const botMetaByNameLower = new Map<string, { name: string; workspaceId: string | null; workspacePath: string | null }>()
  for (const b of rawBots) {
    if (!b.name) continue
    const home = psByBotHome.get(b.name)
    const wsId = home?.worktreeId ?? hostWsByBotName.get(b.name.toLowerCase()) ?? null
    const wsPath = home?.path ?? null
    botMetaByNameLower.set(b.name.toLowerCase(), { name: b.name, workspaceId: wsId, workspacePath: wsPath })
  }

  const dedupedNeedsYou = new Map<string, NeedsYouItem>()
  const upsertNeedsYou = (item: NeedsYouItem) => {
    const key = `${item.host}:${item.kind}:${item.number ?? item.id}`
    const existing = dedupedNeedsYou.get(key)
    if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      dedupedNeedsYou.set(key, item)
    }
  }

  for (let idx = 0; idx < rawNeedsYouEntries.length; idx++) {
    const { raw, sourceHost, fallbackBot } = rawNeedsYouEntries[idx]
    if (!raw || typeof raw !== 'object') continue
    const st = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : ''
    if (st && st !== 'needs_you' && st !== 'needs-you') continue
    if (typeof raw.snoozedUntil === 'number' && raw.snoozedUntil > nowMs) continue
    const botName =
      (typeof raw.bot === 'string' && raw.bot.trim())
        ? raw.bot.trim()
        : (typeof raw.owner?.name === 'string' && raw.owner.name.trim())
          ? raw.owner.name.trim()
          : (fallbackBot || 'Bot')
    const botMeta = botMetaByNameLower.get(botName.toLowerCase())
    const extracted = extractNeedsYouQuestion(raw.question)
    const replyCount = typeof raw.replyCount === 'number' && raw.replyCount > 0 ? raw.replyCount : extracted.replyCount
    const title = normalizeNeedsYouText(raw.title, 110) || 'Needs your decision'
    const num = typeof raw.number === 'number' ? raw.number : null
    const id = String(raw.uid || raw.id || (num !== null ? `item-${num}` : `${botName}-${idx}`))
    const updatedAt =
      typeof raw.updatedAt === 'number'
        ? raw.updatedAt
        : (typeof raw.lastActivityAt === 'number' ? raw.lastActivityAt : null)
    upsertNeedsYou({
      id,
      kind: 'item',
      number: num,
      bot: botMeta?.name || botName,
      host: sourceHost,
      title,
      question: extracted.question,
      replyCount,
      chatId: raw.chatId || raw.chat?.id || null,
      chatTitle: raw.chatTitle || raw.chat?.title || null,
      workspaceId: botMeta?.workspaceId ?? null,
      workspacePath: botMeta?.workspacePath ?? null,
      terminalId: null,
      updatedAt
    })
  }

  for (const w of trimmedWorkers) {
    if (w.state !== 'permission') continue
    const botMeta = w.bot ? botMetaByNameLower.get(w.bot.toLowerCase()) : undefined
    upsertNeedsYou({
      id: `perm:${w.host}:${w.id}`,
      kind: 'permission',
      number: null,
      bot: botMeta?.name || w.bot || w.title,
      host: w.host,
      title: w.title,
      question: normalizeNeedsYouText(w.sessionTitle, 110) || 'Worker awaiting permission approval',
      replyCount: 0,
      chatId: null,
      chatTitle: null,
      workspaceId: w.workspaceId || botMeta?.workspaceId || null,
      workspacePath: w.workspacePath || botMeta?.workspacePath || null,
      terminalId: w.terminalId || null,
      updatedAt: w.lastActivityAt
    })
  }

  const needsYou: NeedsYouItem[] = [...dedupedNeedsYou.values()].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  )
  const needsYouByBot = new Map<string, NeedsYouItem[]>()
  for (const ny of needsYou) {
    const k = ny.bot.toLowerCase()
    const list = needsYouByBot.get(k) || []
    list.push(ny)
    needsYouByBot.set(k, list)
  }

  const bots: BotNodeInfo[] = rawBots.map((b) => {
    const name = b.name || 'Bot'
    const role = classifyRole(name)
    const home = psByBotHome.get(name)
    const actualBotHost = botHostByName.get(name) || controlHostId
    const bestAgent = pickBestAgent(home?.agents)
    const botWorkers = trimmedWorkers.filter((w) => w.bot === name)
    const activeDispatchCount = botWorkers.filter((w) => w.state === 'working').length

    // Three-tier 100% real traffic provenance (zero name heuristics):
    // 1. botHost (own Brain host)
    // 2. activeHosts (remote hosts with a live working worker or running/working dispatch)
    // 3. recentHosts (remote hosts with a visible recent worker or completed real dispatch within 6h)
    const activeHosts: HostId[] = []
    const recentHostsRaw: HostId[] = []
    const visibleWorkerHosts: HostId[] = []
    const addUniqueValid = (arr: HostId[], hid: HostId, excludeHost?: HostId) => {
      if (!hid || !validHostIds.has(hid) || (excludeHost && hid === excludeHost) || arr.includes(hid)) return
      arr.push(hid)
    }

    const sortedBotWorkers = [...botWorkers].sort((a, b) => {
      const aLive = a.state === 'working' ? 1 : 0
      const bLive = b.state === 'working' ? 1 : 0
      if (bLive !== aLive) return bLive - aLive
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
    for (const w of sortedBotWorkers) {
      addUniqueValid(visibleWorkerHosts, w.host)
      if (w.host !== actualBotHost) {
        if (w.state === 'working') addUniqueValid(activeHosts, w.host, actualBotHost)
        else addUniqueValid(recentHostsRaw, w.host, actualBotHost)
      }
    }

    const botDispatches = [...(botTrafficServers.get(name) || [])].sort((a, b) => b.startedAt - a.startedAt)
    for (const rd of botDispatches) {
      if (isLiveDispatchState(rd.state)) {
        addUniqueValid(activeHosts, rd.server, actualBotHost)
      } else if (!rd.startedAt || rd.startedAt >= recentCutoffMs) {
        addUniqueValid(recentHostsRaw, rd.server, actualBotHost)
      }
    }
    const recentHosts = recentHostsRaw.filter((h) => !activeHosts.includes(h))

    const orderedPrefHosts: HostId[] = []
    for (const h of [...activeHosts, ...visibleWorkerHosts, ...recentHosts, actualBotHost]) {
      addUniqueValid(orderedPrefHosts, h)
    }
    const primaryHost: HostId = activeHosts[0] || visibleWorkerHosts[0] || recentHosts[0] || actualBotHost
    const secondaryHost: HostId | null = orderedPrefHosts.find((h) => h !== primaryHost) || null

    // Always retain the Bot's own hosting machine (actualBotHost) PLUS activeHosts and recentHosts
    const targetHosts: HostId[] = []
    addUniqueValid(targetHosts, actualBotHost)
    for (const h of activeHosts) addUniqueValid(targetHosts, h)
    for (const h of recentHosts) addUniqueValid(targetHosts, h)
    if (targetHosts.length === 0 && primaryHost) targetHosts.push(primaryHost)

    let state: BotNodeInfo['state'] = 'idle'
    if (b.paused) state = 'paused'
    else if (home?.status === 'working' || bestAgent?.state === 'working' || activeDispatchCount > 0) state = 'working'
    else if (home?.unread) state = 'unread'

    const workspaceId = home?.worktreeId ?? hostWsByBotName.get(name.toLowerCase()) ?? null
    const botNeeds = needsYouByBot.get(name.toLowerCase()) || []
    const topNeed = botNeeds[0] || null
    const needsYouSummary = topNeed
      ? (topNeed.kind === 'permission'
          ? `[PERM] ${topNeed.question || topNeed.title}`
          : `${topNeed.number !== null ? `#${topNeed.number} ` : ''}${topNeed.question || topNeed.title}`)
      : null

    return {
      id: b.id || name,
      name,
      shortName: shortBotLabel(name),
      squad: classifySquad(name),
      role,
      botHost: actualBotHost,
      primaryHost,
      secondaryHost,
      targetHosts,
      activeHosts,
      recentHosts,
      agent: b.agent || 'antigravity',
      state,
      chatsCount: b.chats?.count ?? 1,
      workspaceId,
      workspacePath: home?.path ?? null,
      activeDispatchCount,
      activeSessionTitle: pickAgentSummary(bestAgent),
      activeToolName: bestAgent?.state === 'working' ? (bestAgent.toolName || null) : null,
      lastActivityAt: home?.lastActivityAt ?? null,
      needsYouCount: botNeeds.length,
      needsYouSummary
    }
  })

  const controlHostLabel = hosts.find((h) => h.id === controlHostId)?.label || controlHostId.toUpperCase()

  return {
    generatedAt: Date.now(),
    controlHostId,
    controlHostLabel,
    hosts,
    bots,
    workers: trimmedWorkers,
    needsYou,
    events: eventLog.slice(0, 18),
    summary: {
      totalBots: bots.length,
      workingBots: bots.filter((b) => b.state === 'working').length,
      onlineHosts: hosts.filter((h) => h.online).length,
      activeWorkers: workers.filter((w) => w.state === 'working').length,
      recentWorkers: trimmedWorkers.length,
      needsYouCount: needsYou.length
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
    const now = Date.now()
    if (eventLog[0] && eventLog[0].kind === kind && eventLog[0].message === message && now - eventLog[0].ts < 15_000) {
      eventLog[0].ts = now
      return
    }
    eventLog.unshift({ ts: now, kind, message })
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
    const ny = snap.summary.needsYouCount ?? 0
    const activeTotal = snap.summary.activeWorkers + snap.summary.workingBots
    const tone = ny > 0 ? 'warning' : activeTotal > 0 ? 'accent' : 'success'
    const text =
      ny > 0
        ? `HQ · ! ${ny} NEED YOU · ${snap.summary.activeWorkers}W`
        : `HQ · ${snap.summary.onlineHosts}N · ${snap.summary.activeWorkers}W`
    const baseTooltip = `${snap.summary.totalBots} Bots (${snap.summary.workingBots} working) · ${snap.summary.onlineHosts} Hosts online · ${snap.summary.activeWorkers} active workers`
    const tooltip = ny > 0 ? `${ny} item(s) need your decision · ${baseTooltip}` : baseTooltip
    await orca.host
      .call('statusBar.update', {
        id: 'hq-status',
        text,
        tone,
        tooltip
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

  const hostMatches = (wHostId: string | null | undefined, targetHost: string): boolean => {
    if (targetHost === 'local') return !wHostId || wHostId === 'local'
    if (!wHostId) return false
    const normW = wHostId.toLowerCase().replace(/^runtime:/, '')
    const normT = targetHost.toLowerCase().replace(/^runtime:/, '')
    return normW === normT || wHostId.toLowerCase() === targetHost.toLowerCase()
  }

  type ListedWorkspace = {
    id: string
    kind?: string
    name: string
    path?: string
    branch?: string | null
    hostId?: string | null
  }

  const findWorkspaceInList = (
    allWorkspaces: ListedWorkspace[],
    candidateId: string | null,
    candidatePath: string | null,
    candidateBotName: string | null,
    candidateTitle: string | null,
    targetHost: string
  ): ListedWorkspace | null => {
    if (allWorkspaces.length === 0) return null
    if (candidateId) {
      const exact = allWorkspaces.find((w) => w.id === candidateId)
      if (exact) return exact
      const suffix = allWorkspaces.find(
        (w) =>
          w.id.endsWith(`:${candidateId}`) ||
          w.id.endsWith(`::${candidateId}`) ||
          candidateId.endsWith(`:${w.id}`)
      )
      if (suffix) return suffix
    }
    if (candidatePath) {
      const byPathHost = allWorkspaces.find((w) => w.path === candidatePath && hostMatches(w.hostId, targetHost))
      if (byPathHost) return byPathHost
      const byPath = allWorkspaces.find((w) => w.path === candidatePath)
      if (byPath) return byPath
    }
    if (candidateBotName) {
      const lowerBot = candidateBotName.toLowerCase()
      const byBotHost = allWorkspaces.find(
        (w) => w.kind === 'folder' && w.name.toLowerCase() === lowerBot && hostMatches(w.hostId, targetHost)
      )
      if (byBotHost) return byBotHost
      const byBot = allWorkspaces.find((w) => w.kind === 'folder' && w.name.toLowerCase() === lowerBot)
      if (byBot) return byBot
    }
    if (candidateTitle) {
      const cleanTitle = candidateTitle.includes(' / ')
        ? candidateTitle.split(' / ').slice(-1)[0].trim().toLowerCase()
        : candidateTitle.trim().toLowerCase()
      const byTitleHost = allWorkspaces.find(
        (w) =>
          hostMatches(w.hostId, targetHost) &&
          (w.name.toLowerCase() === cleanTitle || (w.branch && w.branch.toLowerCase() === cleanTitle))
      )
      if (byTitleHost) return byTitleHost
    }
    return null
  }

  const openResolvedWorkspace = async (
    resolvedWsId: string,
    label: string,
    preferredTermId: string | null
  ): Promise<OpenSessionOutput | null> => {
    const opened = await orca.host.call('workspace.open', { workspaceId: resolvedWsId }).catch((err) => {
      orca.log(`workspace.open(${resolvedWsId}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    let targetTerm = preferredTermId && preferredTermId.startsWith('term_') ? preferredTermId : null
    if (!targetTerm) {
      const agentsRes = await orca.host.call('agents.list', { workspaceId: resolvedWsId }).catch(() => null)
      const activeAgent = agentsRes?.agents?.find((a) => a.terminalId && a.state === 'working')
        || agentsRes?.agents?.find((a) => a.terminalId)
      if (activeAgent?.terminalId) targetTerm = activeAgent.terminalId
    }
    if (targetTerm) {
      const foc = await orca.host.call('terminal.focus', { terminalId: targetTerm }).catch(() => null)
      if (foc?.focused) {
        pushLog('workspace', `FOCUSED SESSION :: ${label}`)
        return { opened: true, mode: 'focused', detail: 'Focused live Orca session pane' }
      }
    }
    if (opened?.opened) {
      pushLog('workspace', `OPENED WORKSPACE :: ${label}`)
      return { opened: true, mode: 'opened', detail: `Opened ${label} in Orca` }
    }
    return null
  }

  const handleOpenSession = async (input: OpenSessionInput): Promise<OpenSessionOutput> => {
    const host = input?.host || 'local'
    const wsId = input?.workspaceId || null
    const wsPath = input?.workspacePath || null
    const botName = input?.botName || null
    const title = input?.title || null
    const termId = input?.terminalId || null
    const fallbackWs = input?.fallbackWorkspaceId || null

    const listRes = await orca.host.call('workspace.list', { includeStatus: false }).catch(() => null)
    const allWorkspaces = (listRes?.workspaces ?? []) as ListedWorkspace[]

    // 1. Try resolving directly against this Orca window's workspace.list (works for local AND directly paired remote workspaces)
    const matched = findWorkspaceInList(allWorkspaces, wsId, wsPath, botName, title, host)
    if (matched) {
      const res = await openResolvedWorkspace(matched.id, matched.name || wsPath || matched.id, host === 'local' ? termId : null)
      if (res) return res
    }

    // 2. Direct workspace.open attempt (for local workspaces or folder workspaces that CLI activate cannot open)
    if (wsId && (host === 'local' || wsId.startsWith('folder:'))) {
      const direct = await openResolvedWorkspace(wsId, botName || wsPath || wsId, host === 'local' ? termId : null)
      if (direct) return direct
    }

    // 3. Direct remote terminal switch if a live remote terminal handle is known
    if (host !== 'local' && termId && termId.startsWith('term_')) {
      const switched = await cli(['terminal', 'switch', '--environment', host, '--terminal', termId, '--json'])
      if (switched) {
        pushLog('workspace', `SWITCHED REMOTE SESSION :: ${host} · ${termId}`)
        return { opened: true, mode: 'focused', detail: `Switched to ${host} terminal` }
      }
    }

    // 4. Remote/relayed worktree activation (non-folder worktrees only; folder workspaces cannot be activated via CLI)
    const isFolder = Boolean(wsId && wsId.startsWith('folder:'))
    const selector = !isFolder && wsId ? `id:${wsId}` : !isFolder && wsPath ? `path:${wsPath}` : null
    let activatedRemotely = false
    if (host !== 'local' && selector) {
      const hubHttp = hubHttpByHost.get(host)
      if (hubHttp) {
        const activated = await hubRelayClient.activateWorktree(hubHttp, host, selector).catch(() => false)
        if (activated) {
          activatedRemotely = true
          pushLog('workspace', `ACTIVATED VIA HUB RELAY :: ${host} · ${wsPath || wsId}`)
        }
      }
      if (!activatedRemotely) {
        const hubSsh = hubSshByHost.get(host)
        const act = hubSsh
          ? await relayCli(hubSsh, ['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'])
          : await cli(['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'])
        if (act && (act as { activated?: boolean }).activated !== false) {
          activatedRemotely = true
          pushLog('workspace', `ACTIVATED REMOTE WORKTREE :: ${host} · ${wsPath || wsId}`)
        }
      }
    }

    // 5. Fallback to opening the dispatching parent Bot in this Orca window (always helpful for relayed workers not directly paired locally)
    if (fallbackWs || (!matched && botName)) {
      const fbMatch = findWorkspaceInList(allWorkspaces, fallbackWs, null, botName, null, host)
      const fbId = fbMatch?.id || fallbackWs
      if (fbId) {
        const fb = await orca.host.call('workspace.open', { workspaceId: fbId }).catch(() => null)
        if (fb?.opened) {
          const fbLabel = fbMatch?.name || botName || fbId
          pushLog('workspace', `OPENED PARENT BOT :: ${fbLabel}`)
          return {
            opened: true,
            mode: activatedRemotely ? 'activated' : 'fallback',
            detail: activatedRemotely
              ? `Activated on ${host} & opened ${fbLabel}`
              : `Opened ${fbLabel} session`
          }
        }
      }
    }

    if (activatedRemotely) {
      return { opened: true, mode: 'activated', detail: `Activated on ${host}` }
    }

    orca.log(`hq.openSession unresolved: host=${host} wsId=${wsId || ''} path=${wsPath || ''} bot=${botName || ''} listed=${allWorkspaces.length}`)
    return {
      opened: false,
      mode: 'none',
      detail: host === 'local'
        ? 'No matching local session'
        : `Not paired in this Orca window (${host})`
    }
  }

  const handleOpenTasksView = async (): Promise<OpenNeedsYouOutput> => {
    try {
      const res = await orca.host.call('commands.run', { action: 'view.tasks' })
      const failed =
        res && typeof res === 'object' &&
        ((res as { ok?: boolean }).ok === false || (res as { ran?: boolean }).ran === false)
      if (!failed) {
        pushLog('system', 'OPENED ORCA TASKS / NEEDS YOU QUEUE')
        return { opened: true, mode: 'tasks', detail: 'Opened Orca Tasks / Needs You queue' }
      }
    } catch (err) {
      orca.log(`commands.run(view.tasks) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { opened: false, mode: 'none', detail: 'Unable to open Orca Tasks queue' }
  }

  const handleOpenNeedsYou = async (input: OpenNeedsYouInput): Promise<OpenNeedsYouOutput> => {
    const host = input?.host || 'local'
    const botName = input?.botName || null
    const wsId = input?.workspaceId || null
    const wsPath = input?.workspacePath || null
    const chatTitle = input?.chatTitle || null
    const termId = input?.terminalId || null
    const kind = input?.kind || 'item'

    // 1. Permission-blocked worker with live terminal -> focus directly first
    if (kind === 'permission') {
      if (termId && termId.startsWith('term_')) {
        const foc = await orca.host.call('terminal.focus', { terminalId: termId }).catch(() => null)
        if (foc?.focused) {
          pushLog('workspace', `FOCUSED PERMISSION WORKER :: ${botName || termId}`)
          return { opened: true, mode: 'focused', detail: 'Focused worker awaiting permission' }
        }
      }
      const sess = await handleOpenSession({
        workspaceId: wsId,
        workspacePath: wsPath,
        botName,
        host,
        terminalId: termId
      })
      if (sess.opened) return sess
    }

    // 2. Try resolving in this Orca window's workspace.list (prefer matching group chat folder, then Bot folder)
    const listRes = await orca.host.call('workspace.list', { includeStatus: false }).catch(() => null)
    const allWorkspaces = (listRes?.workspaces ?? []) as ListedWorkspace[]
    let matched: ListedWorkspace | null = null
    if (chatTitle && allWorkspaces.length > 0) {
      const lowerChat = chatTitle.trim().toLowerCase()
      matched =
        allWorkspaces.find(
          (w) => w.kind === 'folder' && w.name.toLowerCase() === lowerChat && hostMatches(w.hostId, host)
        ) ||
        allWorkspaces.find((w) => w.kind === 'folder' && w.name.toLowerCase() === lowerChat) ||
        null
    }
    if (!matched) {
      matched = findWorkspaceInList(allWorkspaces, wsId, wsPath, botName, null, host)
    }
    if (matched) {
      const res = await openResolvedWorkspace(
        matched.id,
        matched.name || chatTitle || botName || matched.id,
        host === 'local' ? termId : null
      )
      if (res) return res
    }

    // 3. Seamless fallback to Orca's built-in Tasks / Needs You queue (works across unpaired remote Bots)
    const tasksRes = await handleOpenTasksView()
    if (tasksRes.opened) return tasksRes

    // 4. Final fallback to handleOpenSession (headless / non-desktop)
    return handleOpenSession({
      workspaceId: wsId,
      workspacePath: wsPath,
      botName,
      host,
      terminalId: termId
    })
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
        if (total > 4096 || idx < 0 || idx >= total) {
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
        slot.createdAt = now
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
      } else if (out.error) {
        pushLog('system', `EXPORT VIDEO FAILED :: ${out.error}`)
      }
      return out
    } catch (err) {
      if (input?.uploadId) pendingVideoUploads.delete(input.uploadId)
      const errMsg = err instanceof Error ? err.message : 'Save video failed'
      pushLog('system', `EXPORT VIDEO FAILED :: ${errMsg}`)
      return {
        saved: false,
        path: null,
        bytes: 0,
        format,
        error: errMsg
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
      const saveCorsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-HQ-Token'
      }
      if (pathname === '/api/save-video' && req.method === 'OPTIONS') {
        res.writeHead(204, saveCorsHeaders)
        res.end('')
        return
      }
      if (tok !== wallToken) {
        const denyHeaders: Record<string, string> = pathname === '/api/save-video'
          ? { 'Content-Type': 'text/plain', ...saveCorsHeaders }
          : { 'Content-Type': 'text/plain' }
        res.writeHead(403, denyHeaders)
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
            if (out.opened && os.platform() === 'darwin') {
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

      if (pathname === '/api/open-needs-you' && req.method === 'POST') {
        void readJsonBody(req)
          .then(async (body) => {
            const out = await handleOpenNeedsYou((body || {}) as OpenNeedsYouInput)
            if (out.opened && os.platform() === 'darwin') {
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

      if (pathname === '/api/open-tasks-view' && req.method === 'POST') {
        void readJsonBody(req)
          .then(async () => {
            const out = await handleOpenTasksView()
            if (out.opened && os.platform() === 'darwin') {
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
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...saveCorsHeaders })
            res.end(JSON.stringify(out))
          })
          .catch(() => {
            res.writeHead(400, { 'Content-Type': 'application/json', ...saveCorsHeaders })
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
  orca.panels.handle('hq.openNeedsYou', handleOpenNeedsYou)
  orca.panels.handle('hq.openTasksView', handleOpenTasksView)
  orca.panels.handle('hq.saveVideo', handleSaveVideo)
  orca.panels.handle('hq.getSaveEndpoint', async (): Promise<SaveEndpointOutput> => {
    try {
      await ensureWallServer()
      if (!wallPort || !wallToken) {
        return { url: null, token: null, error: 'Loopback save server unavailable' }
      }
      return {
        url: `http://127.0.0.1:${wallPort}/api/save-video?token=${encodeURIComponent(wallToken)}`,
        token: wallToken
      }
    } catch (err) {
      return {
        url: null,
        token: null,
        error: err instanceof Error ? err.message : 'Failed to start loopback save server'
      }
    }
  })
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
