#!/usr/bin/env node
/**
 * Cyber HQ Radar — Zero-Config Recursive Hub Telemetry Relay
 *
 * Run on any paired hub machine (macOS or Linux) without sudo or an SSH daemon:
 *   node scripts/hub-relay.mjs --host <tailscale-ip>
 *
 * Features:
 * - Zero-config Tailscale WhoIs auth: automatically trusts requests from devices
 *   signed into the SAME Tailscale account (returns 403 for all other IPs/accounts).
 *   Also accepts Authorization: Bearer <token> (and --require-token to enforce token only).
 * - Zero idle polling: refreshes on-demand with stale-while-revalidate caching.
 * - Recursive multi-level discovery: automatically chains through downstream hubs
 *   running hub-relay on the same port (with visited-set loop guard & maxDepth=4).
 * - Full hub context: exports hub hardware metrics, hub-hosted Orca Bots, hub
 *   worktree ps attribution, and all downstream paired compute nodes.
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
    else if (a === '--require-token') out.requireToken = true
    else if (a === '--allow-any') out.allowAny = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const BIND_HOST = args.host || process.env.HQ_RELAY_HOST || '127.0.0.1'
const BIND_PORT = Number(args.port || process.env.HQ_RELAY_PORT || 19768)
const EXPLICIT_TOKEN = (args.token || process.env.HQ_RELAY_TOKEN || '').trim()
const TOKEN = EXPLICIT_TOKEN || crypto.randomBytes(24).toString('hex')
const REQUIRE_TOKEN = Boolean(args.requireToken || process.env.HQ_RELAY_REQUIRE_TOKEN === '1')
const ENV_HINT = args.envName || process.env.HQ_RELAY_ENV_NAME || os.hostname().replace(/\.local$/i, '')

if ((BIND_HOST === '0.0.0.0' || BIND_HOST === '::') && !args.allowAny) {
  console.error('Refusing to bind 0.0.0.0 without --allow-any. Pass your Tailscale or LAN IP via --host.')
  process.exit(1)
}

function isTailscaleIp(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '')
  const m = clean.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
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

const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
let resolvedTailscaleBin = null

async function runTailscaleJson(tsArgs) {
  const candidates = resolvedTailscaleBin ? [resolvedTailscaleBin] : TAILSCALE_BINS
  const tsEnv = { ...process.env, TERM: process.env.TERM || 'dumb' }
  delete tsEnv.XPC_SERVICE_NAME
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, tsArgs, { timeout: 4000, maxBuffer: 2 * 1024 * 1024, env: tsEnv })
      resolvedTailscaleBin = bin
      return JSON.parse(stdout.trim())
    } catch {}
  }
  return null
}

let selfTailscaleUserId = null
let selfTailscaleResolvedAt = 0
const whoisCache = new Map() // ip -> { allowed: boolean, expiresAt: number }

async function getSelfTailscaleUserId() {
  const now = Date.now()
  if (selfTailscaleUserId && now - selfTailscaleResolvedAt < 300_000) return selfTailscaleUserId
  const st = await runTailscaleJson(['status', '--json'])
  const uid = st?.Self?.UserID
  if (uid) {
    selfTailscaleUserId = String(uid)
    selfTailscaleResolvedAt = now
  }
  return selfTailscaleUserId
}

async function isSameTailscaleUser(remoteIp) {
  if (REQUIRE_TOKEN || !isTailscaleIp(BIND_HOST)) return false
  const ip = String(remoteIp || '').replace(/^::ffff:/, '')
  if (!isTailscaleIp(ip)) return false
  const now = Date.now()
  const cached = whoisCache.get(ip)
  if (cached && cached.expiresAt > now) return cached.allowed

  const [selfUid, whois] = await Promise.all([
    getSelfTailscaleUserId(),
    runTailscaleJson(['whois', '--json', ip])
  ])
  const peerUid = whois?.UserProfile?.ID ? String(whois.UserProfile.ID) : null
  const allowed = Boolean(selfUid && peerUid && selfUid === peerUid)
  whoisCache.set(ip, { allowed, expiresAt: now + (allowed ? 300_000 : 30_000) })
  return allowed
}

async function runOrcaJson(cliArgs, timeoutMs = 15000) {
  try {
    const cleanEnv = { ...process.env }
    delete cleanEnv.ORCA_BOT_TOOLS_TOKEN
    delete cleanEnv.ORCA_AGENT_SESSION_ID
    delete cleanEnv.ORCA_AGENT_SESSION_SPAWN_TOKEN
    const { stdout } = await execFileAsync(defaultOrcaBin(), cliArgs, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: cleanEnv
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

function fetchChildRelay(epHost, depth, visitedSet) {
  return new Promise((resolve) => {
    if (!epHost || depth > 4) { resolve(null); return }
    const visited = [...visitedSet].join(',')
    const url = `http://${epHost}:${BIND_PORT}/v1/relay-snapshot?depth=${depth}&visited=${encodeURIComponent(visited)}`
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const req = http.request(url, { method: 'GET', timeout: 2500 }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { done(null); return }
        let raw = ''
        res.on('data', (ch) => { raw += String(ch); if (raw.length > 8 * 1024 * 1024) done(null) })
        res.on('end', () => { try { done(JSON.parse(raw)) } catch { done(null) } })
      })
      req.on('error', () => done(null))
      req.on('timeout', () => { try { req.destroy() } catch {} done(null) })
      req.end()
    } catch {
      done(null)
    }
  })
}

let cachedSnapshot = null
let cachedAt = 0
let inflight = null
let lastKnownEnvs = []
let lastKnownBots = []
let lastKnownWorktrees = []
let lastKnownDispatches = []

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length)
  let nextIdx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const cur = nextIdx++
      results[cur] = await fn(items[cur], cur)
    }
  })
  await Promise.all(workers)
  return results
}

function refreshRelaySnapshot(depth = 0, visited = new Set()) {
  if (depth === 0 && inflight) return inflight

  const run = (async () => {
    const selfId = ENV_HINT.toLowerCase()
    const nextVisited = new Set([...visited, selfId, BIND_HOST.toLowerCase()])

    const [hubMetrics, envsRes, botsRes, localPsRes] = await Promise.all([
      collectLocalMetrics(),
      runOrcaJson(['environment', 'list', '--json'], 15000),
      runOrcaJson(['bot', 'list', '--json'], 15000),
      runOrcaJson(['worktree', 'ps', '--since', '7d', '--json'], 15000)
    ])
    const fetchedEnvs = Array.isArray(envsRes?.environments) ? envsRes.environments : []
    if (fetchedEnvs.length > 0) lastKnownEnvs = fetchedEnvs
    const rawEnvs = fetchedEnvs.length > 0 ? fetchedEnvs : lastKnownEnvs

    const fetchedBots = Array.isArray(botsRes?.bots) ? botsRes.bots : []
    if (fetchedBots.length > 0) lastKnownBots = fetchedBots
    const hubBots = fetchedBots.length > 0 ? fetchedBots : lastKnownBots

    const fetchedWorktrees = Array.isArray(localPsRes?.worktrees) ? localPsRes.worktrees : []
    if (fetchedWorktrees.length > 0) lastKnownWorktrees = fetchedWorktrees
    const hubWorktrees = fetchedWorktrees.length > 0 ? fetchedWorktrees : lastKnownWorktrees

    // Collect authoritative per-Bot dispatch records (real dispatchId -> Bot + server + title) with bounded concurrency
    const fetchedDispatches = []
    const workLists = await mapConcurrent(hubBots, 3, async (b) => {
      if (!b?.name) return []
      const wl = await runOrcaJson(['bot', 'work', 'list', '--bot', b.name, '--json'], 10000)
      const items = Array.isArray(wl?.items) ? wl.items : []
      return items.slice(0, 20).map((it) => ({
        bot: b.name,
        dispatchId: it.dispatchId || null,
        workspace: it.workspace || null,
        server: it.server || null,
        title: it.title || null,
        state: it.state || null,
        startedAt: typeof it.startedAt === 'number' ? it.startedAt : null
      }))
    })
    for (const rows of workLists) fetchedDispatches.push(...rows)
    if (fetchedDispatches.length > 0) lastKnownDispatches = fetchedDispatches
    const hubDispatches = fetchedDispatches.length > 0 ? fetchedDispatches : lastKnownDispatches

    const directChildren = await Promise.all(
      rawEnvs.map(async (env) => {
        const envName = env.name || env.id || 'remote'
        const epHost = extractEndpointHost(env.endpoints?.[0]?.endpoint)
        if (nextVisited.has(envName.toLowerCase()) || (epHost && nextVisited.has(epHost.toLowerCase()))) {
          return { child: null, nested: [] }
        }
        nextVisited.add(envName.toLowerCase())
        if (epHost) nextVisited.add(epHost.toLowerCase())

        // Probe if this child is itself a downstream hub running hub-relay (recursive multi-level mesh)
        const childRelay = depth < 4 && epHost ? await fetchChildRelay(epHost, depth + 1, nextVisited) : null
        const [workersRes, psRes, sshMetrics] = await Promise.all([
          runOrcaJson(['orchestration', 'worker-list', '--environment', envName, '--json'], 10000),
          runOrcaJson(['worktree', 'ps', '--environment', envName, '--since', '24h', '--json'], 10000),
          childRelay?.host?.metrics
            ? Promise.resolve(null)
            : collectRemoteMetrics(envName).then((m) => m || (epHost && epHost !== envName ? collectRemoteMetrics(epHost) : null))
        ])

        const workers = Array.isArray(workersRes?.workers) ? workersRes.workers : []
        const remotePs = [
          ...(Array.isArray(psRes?.worktrees) ? psRes.worktrees : []),
          ...(Array.isArray(childRelay?.host?.worktrees) ? childRelay.host.worktrees : [])
        ]
        const metrics = childRelay?.host?.metrics ?? sshMetrics ?? null
        const childBots = Array.isArray(childRelay?.host?.bots) ? childRelay.host.bots : []
        const nested = Array.isArray(childRelay?.children)
          ? childRelay.children.map((nc) => ({
              ...nc,
              viaChain: nc.viaChain ? `${envName} -> ${nc.viaChain}` : envName
            }))
          : []

        return {
          child: {
            env,
            envName,
            ok: workersRes !== null || psRes !== null || metrics !== null || childRelay !== null,
            workers,
            remotePs,
            bots: childBots,
            metrics
          },
          nested
        }
      })
    )

    const children = []
    const seenChild = new Set()
    for (const item of directChildren) {
      if (item.child && !seenChild.has(item.child.envName.toLowerCase())) {
        seenChild.add(item.child.envName.toLowerCase())
        children.push(item.child)
      }
      for (const nc of item.nested) {
        const key = String(nc.envName || '').toLowerCase()
        if (key && !seenChild.has(key)) {
          seenChild.add(key)
          children.push(nc)
        }
      }
    }

    const out = {
      ok: true,
      generatedAt: Date.now(),
      host: {
        hostname: os.hostname().replace(/\.local$/i, ''),
        metrics: hubMetrics,
        bots: hubBots,
        worktrees: hubWorktrees,
        dispatches: hubDispatches
      },
      children
    }
    if (depth === 0) {
      cachedSnapshot = out
      cachedAt = Date.now()
    }
    return out
  })()

  if (depth === 0) {
    inflight = run
    run.finally(() => { inflight = null })
  }
  return run
}

async function buildRelaySnapshot(depth = 0, visited = new Set()) {
  if (depth > 0) return refreshRelaySnapshot(depth, visited)
  const now = Date.now()
  if (cachedSnapshot) {
    if (now - cachedAt >= 8000) void refreshRelaySnapshot(0)
    return cachedSnapshot
  }
  return refreshRelaySnapshot(0)
}

function hasValidBearer(req) {
  const hdr = String(req.headers.authorization || '')
  const match = hdr.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const given = Buffer.from(match[1].trim(), 'utf8')
  const expected = Buffer.from(TOKEN, 'utf8')
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}

async function isAuthorized(req) {
  if (hasValidBearer(req)) return true
  if (await isSameTailscaleUser(req.socket?.remoteAddress)) return true
  return false
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
  void isAuthorized(req).then((ok) => {
    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"error":"forbidden"}')
      return
    }

    const reqUrl = req.url || '/'
    const qIdx = reqUrl.indexOf('?')
    const pathname = qIdx >= 0 ? reqUrl.slice(0, qIdx) : reqUrl
    const params = new URLSearchParams(qIdx >= 0 ? reqUrl.slice(qIdx + 1) : '')

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, hostname: os.hostname(), platform: os.platform(), tailscaleAutoAuth: !REQUIRE_TOKEN && isTailscaleIp(BIND_HOST) }))
      return
    }

    if (pathname === '/v1/relay-snapshot' && req.method === 'GET') {
      const depth = Math.max(0, Math.min(4, parseInt(params.get('depth') || '0', 10) || 0))
      const visitedRaw = params.get('visited') || ''
      const visited = new Set(visitedRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
      void buildRelaySnapshot(depth, visited)
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
          const act = await runOrcaJson(['worktree', 'activate', '--environment', host, '--worktree', selector, '--json'], 8000)
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
})

server.listen(BIND_PORT, BIND_HOST, () => {
  console.log(`Cyber HQ Hub Relay listening on http://${BIND_HOST}:${BIND_PORT}`)
  if (!REQUIRE_TOKEN && isTailscaleIp(BIND_HOST)) {
    console.log('Zero-config Tailscale WhoIs auth enabled (same-account Tailnet peers connect automatically without token).')
  }
  if (!EXPLICIT_TOKEN) {
    console.log(`Optional explicit plugin setting (hubRelays): ${ENV_HINT}=http://${BIND_HOST}:${BIND_PORT}#${TOKEN}`)
  } else {
    console.log(`Optional explicit plugin setting (hubRelays): ${ENV_HINT}=http://${BIND_HOST}:${BIND_PORT}#<your-token>`)
  }
  void getSelfTailscaleUserId()
  void refreshRelaySnapshot(0)
})
