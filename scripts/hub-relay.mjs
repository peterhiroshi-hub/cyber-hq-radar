#!/usr/bin/env node
/**
 * Cyber HQ Radar — Lightweight Zero-SSH Hub Telemetry Relay
 *
 * Run on a paired hub machine (macOS or Linux) without sudo or an SSH daemon.
 * - Zero idle polling: collects metrics and downstream Orca nodes only on authenticated requests (with 4s cache).
 * - Binds strictly to the interface you pass via --host (e.g. your Tailscale IP, defaults to 127.0.0.1).
 * - Requires Authorization: Bearer <token> (timing-safe comparison).
 *
 * Usage:
 *   node scripts/hub-relay.mjs --host 100.x.y.z --port 19768 --token <secret>
 */
import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as os from 'node:os'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i])
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i]
    else if (a === '--env-name' && argv[i + 1]) out.envName = argv[++i]
    else if (a === '--allow-any') out.allowAny = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const BIND_HOST = args.host || process.env.HQ_RELAY_HOST || '127.0.0.1'
const BIND_PORT = Number(args.port || process.env.HQ_RELAY_PORT || 19768)
const TOKEN = (args.token || process.env.HQ_RELAY_TOKEN || crypto.randomBytes(24).toString('hex')).trim()
const ENV_HINT = args.envName || process.env.HQ_RELAY_ENV_NAME || os.hostname().replace(/\.local$/i, '')

if ((BIND_HOST === '0.0.0.0' || BIND_HOST === '::') && !args.allowAny) {
  console.error('Refusing to bind 0.0.0.0 without --allow-any. Pass your Tailscale or LAN IP via --host.')
  process.exit(1)
}

function execFileAsync(file, fileArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, fileArgs, options, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function defaultOrcaBin() {
  return process.env.ORCA_CLI_COMMAND || '/Applications/Orca.app/Contents/Resources/bin/orca'
}

async function runOrcaJson(cliArgs, timeoutMs = 15000) {
  try {
    const { stdout } = await execFileAsync(defaultOrcaBin(), cliArgs, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env }
    })
    const trimmed = stdout.trim()
    if (!trimmed) return null
    const parsed = JSON.parse(trimmed)
    return parsed && parsed.ok !== false ? (parsed.result ?? parsed) : null
  } catch {
    return null
  }
}

async function collectLocalMetrics() {
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
        if (last) cpuPct = Math.max(0, Math.min(100, Math.round(100 - Number(last[1]))))
      }

      let ramUsedGb = Number(((totalBytes - os.freemem()) / 1024 ** 3).toFixed(1))
      if (vmRes?.stdout) {
        const psMatch = vmRes.stdout.match(/page size of (\d+) bytes/)
        const pageSize = psMatch ? Number(psMatch[1]) : 16384
        const grab = (lbl) => {
          const m = vmRes.stdout.match(new RegExp(`${lbl}:\\s+(\\d+)\\.`))
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
        const capStr = cols.find((c) => c.endsWith('%')) || '0%'
        diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
        diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
      }
      return { cpuPct, ramPct, ramUsedGb, ramTotalGb: totalGb, diskPct, diskFreeGb, load1, cores, osName: 'macOS', gpu: null }
    }

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
      const capStr = cols.find((c) => c.endsWith('%')) || '0%'
      diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
      diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
    }
    return { cpuPct, ramPct, ramUsedGb, ramTotalGb: totalGb, diskPct, diskFreeGb, load1, cores, osName: plat, gpu: null }
  } catch {
    return null
  }
}

async function collectRemoteMetrics(sshTarget) {
  if (!sshTarget || !/^[a-zA-Z0-9._@-]+$/.test(sshTarget)) return null
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

  try {
    const { stdout } = await execFileAsync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=2',
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPersist=120',
        '-o', 'ControlPath=/tmp/orca-hq-relay-ssh-%C',
        sshTarget,
        remoteScript
      ],
      { timeout: 6000 }
    )
    const lines = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
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
      const capStr = dfCols.find((col) => col.endsWith('%')) || '0%'
      const diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
      const diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))
      return { cpuPct, ramPct, ramUsedGb, ramTotalGb, diskPct, diskFreeGb, load1, cores, osName: 'macOS', gpu: null }
    }

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
    const capStr = dfCols.find((col) => col.endsWith('%')) || '0%'
    const diskPct = Math.min(100, Math.max(0, parseInt(capStr, 10) || 0))
    const diskFreeGb = Number((availKb / 1024 ** 2).toFixed(1))

    let gpu = null
    const gpuLine = lines[7] || 'NO_GPU'
    if (gpuLine && gpuLine !== 'NO_GPU') {
      const parts = gpuLine.split(',').map((s) => s.trim())
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

function extractEndpointHost(ep) {
  if (!ep) return null
  const m = String(ep).match(/^[a-z]+:\/\/([^:/]+)/i)
  return m ? m[1] : null
}

let cachedSnapshot = null
let cachedAt = 0
let inflight = null
let lastKnownEnvs = []

function refreshRelaySnapshot() {
  if (inflight) return inflight

  inflight = (async () => {
    const [hubMetrics, envsRes] = await Promise.all([
      collectLocalMetrics(),
      runOrcaJson(['environment', 'list', '--json'], 15000)
    ])
    const fetchedEnvs = Array.isArray(envsRes?.environments) ? envsRes.environments : []
    if (fetchedEnvs.length > 0) lastKnownEnvs = fetchedEnvs
    const rawEnvs = fetchedEnvs.length > 0 ? fetchedEnvs : lastKnownEnvs
    const children = await Promise.all(
      rawEnvs.map(async (env) => {
        const envName = env.name || env.id || 'remote'
        const epHost = extractEndpointHost(env.endpoints?.[0]?.endpoint)
        const [workersRes, psRes, metrics] = await Promise.all([
          runOrcaJson(['orchestration', 'worker-list', '--environment', envName, '--json'], 10000),
          runOrcaJson(['worktree', 'ps', '--environment', envName, '--since', '24h', '--json'], 10000),
          collectRemoteMetrics(envName).then((m) => m || (epHost && epHost !== envName ? collectRemoteMetrics(epHost) : null))
        ])
        const workers = Array.isArray(workersRes?.workers) ? workersRes.workers : []
        const remotePs = Array.isArray(psRes?.worktrees) ? psRes.worktrees : []
        return {
          env,
          envName,
          ok: workersRes !== null || psRes !== null || metrics !== null,
          workers,
          remotePs,
          metrics
        }
      })
    )
    const out = {
      ok: true,
      generatedAt: Date.now(),
      host: {
        hostname: os.hostname().replace(/\.local$/i, ''),
        metrics: hubMetrics
      },
      children
    }
    cachedSnapshot = out
    cachedAt = Date.now()
    return out
  })()

  inflight.finally(() => { inflight = null })
  return inflight
}

async function buildRelaySnapshot() {
  const now = Date.now()
  if (cachedSnapshot) {
    if (now - cachedAt >= 8000) void refreshRelaySnapshot()
    return cachedSnapshot
  }
  return refreshRelaySnapshot()
}

function isAuthorized(req) {
  const hdr = String(req.headers.authorization || '')
  const match = hdr.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const given = Buffer.from(match[1].trim(), 'utf8')
  const expected = Buffer.from(TOKEN, 'utf8')
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 256 * 1024) reject(new Error('Body too large'))
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch (e) { reject(e) }
    })
  })
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"error":"forbidden"}')
    return
  }

  const pathname = (req.url || '/').split('?')[0]

  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, hostname: os.hostname(), platform: os.platform() }))
    return
  }

  if (pathname === '/v1/relay-snapshot' && req.method === 'GET') {
    void buildRelaySnapshot()
      .then((snap) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(snap))
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"snapshot_failed"}')
      })
    return
  }

  if (pathname === '/v1/activate-worktree' && req.method === 'POST') {
    void readJsonBody(req)
      .then(async (body) => {
        const host = typeof body?.host === 'string' ? body.host : ''
        const selector = typeof body?.selector === 'string' ? body.selector : ''
        if (!/^[a-zA-Z0-9._-]+$/.test(host) || !/^[a-zA-Z0-9._:/@-]+$/.test(selector)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false,"error":"invalid_params"}')
          return
        }
        const act = await runOrcaJson(['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: Boolean(act), activated: Boolean(act && act.activated !== false) }))
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"bad_request"}')
      })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"ok":false,"error":"not_found"}')
})

server.listen(BIND_PORT, BIND_HOST, () => {
  console.log(`Cyber HQ Hub Relay listening on http://${BIND_HOST}:${BIND_PORT}`)
  if (!args.token && !process.env.HQ_RELAY_TOKEN) {
    console.log(`Generated plugin setting (hubRelays): ${ENV_HINT}=http://${BIND_HOST}:${BIND_PORT}#${TOKEN}`)
  } else {
    console.log(`Plugin setting (hubRelays): ${ENV_HINT}=http://${BIND_HOST}:${BIND_PORT}#<your-token>`)
  }
  void refreshRelaySnapshot()
})
