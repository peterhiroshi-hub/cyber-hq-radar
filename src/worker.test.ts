import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRunner, HubRelayClient, MetricsRunner, RelayCliRunner, VideoSaver, WallOpener } from './worker'
import * as main from './worker'

const noopHubRelay: HubRelayClient = {
  async fetchSnapshot() { return null },
  async activateWorktree() { return false }
}

test('collects multi-host bots, workers, and performance metrics, jumps sessions, exports video, and opens fullscreen wall', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-local',
            kind: 'worktree',
            name: 'main',
            project: 'cyber-hq-radar',
            projectId: 'p1',
            path: '/Users/dev/workspaces/cyber-hq-radar',
            branch: 'main',
            hostId: 'local',
            status: { state: 'active', unread: false, terminalCount: 1, lastActivityAt: 100 }
          }
        ],
        truncated: false
      },
      'workspace.open': { opened: true },
      'agents.list': {
        agents: [{ terminalId: 'term_live_1', title: 'Alpha Task', agent: 'antigravity', state: 'working', stateStartedAt: 100 }]
      },
      'terminal.focus': { focused: true }
    }
  })

  const mockCli: CliRunner = async (args) => {
    const key = args.slice(0, 3).join(' ')
    if (key === 'bot list --json') {
      return {
        bots: [
          { id: 'b1', name: 'Orion Copilot', agent: 'antigravity', chats: { count: 1 } },
          { id: 'b2', name: 'Alpha Delivery', agent: 'codex', chats: { count: 14 } },
          { id: 'b3', name: 'Alpha QA', agent: 'opencode', chats: { count: 22 } }
        ]
      }
    }
    if (key === 'environment list --json') {
      return {
        environments: [
          { id: 'e1', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.64.0.10:6768' }] },
          { id: 'e2', name: 'qa-box', endpoints: [{ endpoint: 'ws://100.64.0.20:6768' }] }
        ]
      }
    }
    if (key === 'worktree ps --since') {
      return {
        worktrees: [
          {
            worktreeId: 'folder:copilot',
            repo: 'Bots',
            bot: 'Orion Copilot',
            botHome: true,
            status: 'working',
            lastActivityAt: 200
          }
        ]
      }
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list' && args[3] === 'gpu-box') {
      return {
        workers: [
          {
            dispatchId: 'ctx_1',
            state: 'working',
            liveness: 'live',
            agent: 'antigravity/gemini-4-neon',
            workspace: 'repo1::/home/worker/orca/workspaces/alpha/feat-x'
          }
        ]
      }
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list' && args[3] === 'qa-box') {
      return {
        workers: [
          {
            dispatchId: 'ctx_2',
            state: 'succeeded',
            liveness: 'exited',
            agent: 'codex',
            workspace: 'repo2::/home/worker/orca/workspaces/alpha/qa-y'
          }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'activate') {
      return { activated: true }
    }
    return null
  }

  const mockMetrics: MetricsRunner = async (hostId) => {
    if (hostId === 'gpu-box') {
      return {
        cpuPct: 42,
        ramPct: 35,
        ramUsedGb: 11.0,
        ramTotalGb: 32.0,
        diskPct: 55,
        diskFreeGb: 240.0,
        load1: 3.2,
        cores: 16,
        osName: 'Linux',
        gpu: { name: 'RTX 4070', utilPct: 18, vramUsedMiB: 512, vramTotalMiB: 12282, tempC: 41, powerW: 22.5 }
      }
    }
    return {
      cpuPct: 15,
      ramPct: 50,
      ramUsedGb: 8.0,
      ramTotalGb: 16.0,
      diskPct: 60,
      diskFreeGb: 120.0,
      load1: 1.1,
      cores: 10,
      osName: hostId === 'local' ? 'macOS' : 'Linux',
      gpu: null
    }
  }

  const mockVideoSaver: VideoSaver = async (input) => ({
    saved: true,
    path: `/Users/dev/Downloads/${input.filename || 'cyber-hq.mp4'}`,
    bytes: 4096,
    format: input.mimeType.includes('mp4') ? 'mp4' : 'webm'
  })

  let openedWallUrl = ''
  const mockWallOpener: WallOpener = async (url) => {
    openedWallUrl = url
    return true
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, mockVideoSaver, mockWallOpener, undefined, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(snap.controlHostId, 'local')
  assert.equal(snap.summary.totalBots, 3)
  assert.equal(snap.summary.onlineHosts, 3)
  assert.equal(snap.summary.activeWorkers, 1)
  assert.equal(snap.hosts.find((h) => h.id === 'gpu-box')?.metrics?.gpu?.name, 'RTX 4070')
  assert.equal(snap.hosts.find((h) => h.id === 'local')?.metrics?.cpuPct, 15)

  const deliveryBot = snap.bots.find((b) => b.name === 'Alpha Delivery')
  const qaBot = snap.bots.find((b) => b.name === 'Alpha QA')
  assert.equal(deliveryBot?.squad, 'alpha')
  assert.equal(deliveryBot?.primaryHost, 'gpu-box')
  assert.equal(deliveryBot?.activeDispatchCount, 1)
  assert.equal(deliveryBot?.state, 'working')
  assert.equal(qaBot?.primaryHost, 'qa-box')
  assert.equal(snap.workers.find((w) => w.id === 'ctx_1')?.bot, 'Alpha Delivery')
  assert.equal(snap.workers.find((w) => w.id === 'ctx_2')?.bot, 'Alpha QA')

  await worker.emit('agent.status.changed', {
    workspaceId: 'ws-local',
    paneKey: 'p1',
    terminalId: 't1',
    title: 'Cyber Worker',
    state: 'working',
    receivedAt: 300
  })

  const refreshed = await worker.request('hq.refresh')
  assert.ok(refreshed.events.some((e) => e.message.includes('Cyber Worker')))
  assert.equal((await worker.request('hq.openWorkspace', { workspaceId: 'ws-local' })).opened, true)

  const localJump = await worker.request('hq.openSession', { workspaceId: 'ws-local', host: 'local' })
  assert.equal(localJump.opened, true)
  assert.equal(localJump.mode, 'focused')

  const remoteJump = await worker.request('hq.openSession', {
    workspaceId: 'repo1::/home/worker/orca/workspaces/alpha/feat-x',
    host: 'gpu-box'
  })
  assert.equal(remoteJump.opened, true)
  assert.equal(remoteJump.mode, 'activated')

  const savedVid = await worker.request('hq.saveVideo', {
    base64: 'AAAA',
    mimeType: 'video/mp4',
    filename: 'cyber-hq-demo.mp4',
    reveal: false
  })
  assert.equal(savedVid.saved, true)
  assert.equal(savedVid.format, 'mp4')

  // Verify chunked upload reassembly for large 1080p video exports
  const c0 = await worker.request('hq.saveVideo', {
    uploadId: 'u1',
    chunkIndex: 0,
    totalChunks: 3,
    base64: 'AA',
    mimeType: 'video/webm',
    filename: 'cyber-hq-chunked.webm',
    reveal: false
  })
  assert.equal(c0.chunkAccepted, true)
  assert.equal(c0.saved, false)
  const c1 = await worker.request('hq.saveVideo', {
    uploadId: 'u1',
    chunkIndex: 1,
    totalChunks: 3,
    base64: 'BB',
    mimeType: 'video/webm',
    filename: 'cyber-hq-chunked.webm',
    reveal: false
  })
  assert.equal(c1.chunkAccepted, true)
  const c2 = await worker.request('hq.saveVideo', {
    uploadId: 'u1',
    chunkIndex: 2,
    totalChunks: 3,
    base64: 'CC',
    mimeType: 'video/webm',
    filename: 'cyber-hq-chunked.webm',
    reveal: false
  })
  assert.equal(c2.saved, true)
  assert.equal(c2.format, 'webm')

  // Verify stripBase64DataUrl correctly strips data URLs containing ;codecs=...;base64,
  const sampleBytes = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex')
  const codecDataUrl = `data:video/mp4;codecs=avc1.640028;base64,${sampleBytes.toString('base64')}`
  const stripped = main.stripBase64DataUrl(codecDataUrl)
  assert.equal(Buffer.from(stripped, 'base64').length, sampleBytes.length)

  const wall = await worker.request('hq.openFullscreenWall')
  assert.equal(wall.opened, true)
  assert.ok(wall.url && wall.url.startsWith('http://127.0.0.1:'))
  assert.equal(openedWallUrl, wall.url)
  assert.equal(worker.refusals.length, 0)

  await worker.deactivate()
})

test('remote console mode monitors a paired control host and hides local laptop when showLocalHost is false', async () => {
  const host = mockHost({
    results: {
      'settings.get': {
        settings: {
          controlEnvironment: 'ctrl-mac',
          sshTargets: 'ctrl-mac=user@100.64.0.1,gpu-box=user@100.64.0.2',
          showLocalHost: false
        }
      },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const seenSshTargets: Record<string, string | null | undefined> = {}
  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'e0', name: 'ctrl-mac', endpoints: [{ endpoint: 'ws://100.64.0.1:6768' }] },
          { id: 'e1', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.64.0.2:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list' && args[3] === 'ctrl-mac') {
      return {
        bots: [{ id: 'b1', name: 'Core Copilot', agent: 'antigravity', chats: { count: 3 } }]
      }
    }
    return null
  }

  const mockMetrics: MetricsRunner = async (hostId, sshTarget) => {
    seenSshTargets[hostId] = sshTarget
    return {
      cpuPct: 22,
      ramPct: 45,
      ramUsedGb: 7.2,
      ramTotalGb: 16.0,
      diskPct: 50,
      diskFreeGb: 200.0,
      load1: 1.5,
      cores: 10,
      osName: hostId === 'ctrl-mac' ? 'macOS' : 'Linux',
      gpu: null
    }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(snap.controlHostId, 'ctrl-mac')
  assert.equal(snap.controlHostLabel, 'CTRL-MAC')
  assert.equal(snap.hosts.some((h) => h.id === 'local'), false)
  assert.equal(snap.hosts.length, 2)
  assert.equal(seenSshTargets['ctrl-mac'], 'user@100.64.0.1')
  assert.equal(seenSshTargets['gpu-box'], 'user@100.64.0.2')
  assert.equal(snap.summary.totalBots, 1)

  await worker.deactivate()
})

test('discovers downstream servers via hub SSH relay, attributes multi-host bot ownership accurately, and relays session activation', async () => {
  const host = mockHost({
    results: {
      'settings.get': {
        settings: {
          sshTargets: 'HUB-MAC=hubuser@100.64.0.1'
        }
      },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-hub', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.64.0.1:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list') {
      if (args.includes('hub-mac')) {
        return {
          bots: [
            { id: 'b-del', name: 'Alpha Delivery', agent: 'antigravity', chats: { count: 8 } },
            { id: 'b-qa', name: 'Alpha QA', agent: 'codex', chats: { count: 5 } }
          ]
        }
      }
      return {
        bots: [
          { id: 'b-local', name: 'Laptop Bot', agent: 'opencode', chats: { count: 2 } },
          { id: 'b-del', name: 'Alpha Delivery', agent: 'antigravity', chats: { count: 8 } },
          { id: 'b-qa', name: 'Alpha QA', agent: 'codex', chats: { count: 5 } }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && !args.includes('--environment')) {
      return {
        worktrees: [
          {
            worktreeId: 'folder:laptop-bot',
            repo: 'Bots',
            bot: 'Laptop Bot',
            botHome: true,
            status: 'idle',
            lastActivityAt: 100
          }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && args.includes('hub-mac')) {
      return {
        worktrees: [
          {
            worktreeId: 'folder:alpha-del',
            repo: 'Bots',
            bot: 'Alpha Delivery',
            botHome: true,
            status: 'working',
            lastActivityAt: 300
          },
          {
            worktreeId: 'folder:alpha-qa',
            repo: 'Bots',
            bot: 'Alpha QA',
            botHome: true,
            status: 'idle',
            lastActivityAt: 200
          }
        ]
      }
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list') {
      return { workers: [] }
    }
    return null
  }

  const relayedCalls: string[] = []
  const mockRelayCli: RelayCliRunner = async (hubSsh, args) => {
    relayedCalls.push(`${hubSsh}:${args.join(' ')}`)
    if (hubSsh !== 'hubuser@100.64.0.1') return null
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-gpu', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.64.0.10:6768' }] },
          { id: 'env-qa', name: 'qa-box', endpoints: [{ endpoint: 'ws://100.64.0.20:6768' }] }
        ]
      }
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list' && args.includes('gpu-box')) {
      return {
        workers: [
          {
            dispatchId: 'ctx_relayed_1',
            state: 'working',
            liveness: 'live',
            agent: 'antigravity/gemini-4-neon',
            workspace: 'repo1::/home/worker/orca/workspaces/alpha/feat-relay'
          }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && args.includes('gpu-box')) {
      return {
        worktrees: [
          {
            worktreeId: 'repo1::/home/worker/orca/workspaces/alpha/feat-relay',
            repo: 'alpha',
            displayName: 'feat-relay',
            path: '/home/worker/orca/workspaces/alpha/feat-relay',
            status: 'working',
            crossStoreParent: { parent: { workspaceKey: 'folder:alpha-del' } },
            lastActivityAt: 400
          }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'activate') {
      return { activated: true }
    }
    return { workers: [], worktrees: [] }
  }

  const seenHubRelays: Record<string, string | null | undefined> = {}
  const mockMetrics: MetricsRunner = async (hostId, _sshTarget, hubSshTarget) => {
    seenHubRelays[hostId] = hubSshTarget
    return {
      cpuPct: 30,
      ramPct: 40,
      ramUsedGb: 12,
      ramTotalGb: 32,
      diskPct: 45,
      diskFreeGb: 200,
      load1: 1.4,
      cores: 16,
      osName: hostId === 'local' || hostId === 'hub-mac' ? 'macOS' : 'Linux',
      gpu:
        hostId === 'gpu-box'
          ? { name: 'RTX 4070', utilPct: 25, vramUsedMiB: 1024, vramTotalMiB: 12282, tempC: 45, powerW: 35 }
          : null
    }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, mockRelayCli, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  // All 4 hosts visible: local laptop + hub-mac + relayed gpu-box & qa-box
  assert.equal(snap.hosts.length, 4)
  assert.ok(snap.hosts.some((h) => h.id === 'gpu-box' && h.metrics?.gpu?.name === 'RTX 4070'))
  assert.ok(snap.hosts.some((h) => h.id === 'qa-box'))
  assert.equal(snap.hosts.find((h) => h.id === 'hub-mac')?.isControlPlane, true)
  assert.equal(seenHubRelays['gpu-box'], 'hubuser@100.64.0.1')
  assert.equal(seenHubRelays['qa-box'], 'hubuser@100.64.0.1')

  // True multi-host Bot ownership
  const laptopBot = snap.bots.find((b) => b.name === 'Laptop Bot')
  const delBot = snap.bots.find((b) => b.name === 'Alpha Delivery')
  const qaBot = snap.bots.find((b) => b.name === 'Alpha QA')
  assert.equal(laptopBot?.botHost, 'local')
  assert.equal(delBot?.botHost, 'hub-mac')
  assert.equal(delBot?.primaryHost, 'gpu-box')
  assert.equal(qaBot?.botHost, 'hub-mac')
  assert.equal(qaBot?.primaryHost, 'qa-box')

  // Relayed worker resolved to Alpha Delivery via crossStoreParent on hub-mac
  const relayedWorker = snap.workers.find((w) => w.id === 'ctx_relayed_1')
  assert.equal(relayedWorker?.bot, 'Alpha Delivery')
  assert.equal(relayedWorker?.host, 'gpu-box')

  // Clicking relayed downstream worker relays worktree activate through hub-mac
  const jump = await worker.request('hq.openSession', {
    workspaceId: 'repo1::/home/worker/orca/workspaces/alpha/feat-relay',
    host: 'gpu-box'
  })
  assert.equal(jump.opened, true)
  assert.equal(jump.mode, 'activated')
  assert.ok(relayedCalls.some((c) => c.includes('worktree activate') && c.includes('gpu-box')))

  await worker.deactivate()
})

test('supports zero-SSH HTTP hub relay for hub metrics, downstream GPU/QA discovery, and worktree activation', async () => {
  const host = mockHost({
    results: {
      'settings.get': {
        settings: {
          hubRelays: 'HUB-MAC=http://100.64.0.1:19768#secret-token-xyz'
        }
      },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-hub', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.64.0.1:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list') {
      return {
        bots: [
          { id: 'b-hub', name: 'Alpha Delivery', agent: 'antigravity', chats: { count: 4 } }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && args.includes('hub-mac')) {
      return {
        worktrees: [
          { worktreeId: 'folder:alpha-del', repo: 'Bots', bot: 'Alpha Delivery', botHome: true, status: 'idle', lastActivityAt: 200 }
        ]
      }
    }
    return { workers: [], worktrees: [] }
  }

  let sshCalledForRemote = false
  const mockMetrics: MetricsRunner = async (hostId) => {
    if (hostId !== 'local') {
      sshCalledForRemote = true
      return null
    }
    return { cpuPct: 12, ramPct: 40, ramUsedGb: 25, ramTotalGb: 64, diskPct: 50, diskFreeGb: 200, load1: 1.2, cores: 16, osName: 'macOS', gpu: null }
  }

  let activatedArgs: { host: string; selector: string } | null = null
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot(target) {
      assert.equal(target.baseUrl, 'http://100.64.0.1:19768')
      assert.equal(target.token, 'secret-token-xyz')
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: { cpuPct: 27, ramPct: 62, ramUsedGb: 9.9, ramTotalGb: 16, diskPct: 78, diskFreeGb: 40, load1: 2.3, cores: 10, osName: 'macOS', gpu: null }
        },
        children: [
          {
            env: { id: 'c1', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.64.0.10:6768' }] },
            envName: 'gpu-box',
            ok: true,
            workers: [
              { dispatchId: 'ctx_http_1', state: 'working', liveness: 'live', agent: 'antigravity/gemini-4-neon', workspace: 'r1::/work/alpha/gpu-task' }
            ],
            remotePs: [
              { worktreeId: 'r1::/work/alpha/gpu-task', repo: 'alpha', displayName: 'gpu-task', path: '/work/alpha/gpu-task', status: 'working', crossStoreParent: { parent: { workspaceKey: 'folder:alpha-del' } }, lastActivityAt: 500 }
            ],
            metrics: {
              cpuPct: 44, ramPct: 38, ramUsedGb: 12, ramTotalGb: 31, diskPct: 33, diskFreeGb: 88, load1: 3.1, cores: 20, osName: 'Linux',
              gpu: { name: 'RTX 4070', utilPct: 55, vramUsedMiB: 3200, vramTotalMiB: 12282, tempC: 54, powerW: 95 }
            }
          },
          {
            env: { id: 'c2', name: 'qa-box', endpoints: [{ endpoint: 'ws://100.64.0.20:6768' }] },
            envName: 'qa-box',
            ok: true,
            workers: [],
            remotePs: [],
            metrics: { cpuPct: 14, ramPct: 31, ramUsedGb: 4.3, ramTotalGb: 14, diskPct: 25, diskFreeGb: 48, load1: 0.7, cores: 16, osName: 'Linux', gpu: null }
          }
        ]
      }
    },
    async activateWorktree(_target, h, selector) {
      activatedArgs = { host: h, selector }
      return true
    }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(sshCalledForRemote, false)
  assert.equal(snap.hosts.length, 4)
  assert.equal(snap.hosts.find((h) => h.id === 'hub-mac')?.metrics?.cpuPct, 27)
  assert.equal(snap.hosts.find((h) => h.id === 'gpu-box')?.metrics?.gpu?.name, 'RTX 4070')
  assert.equal(snap.hosts.find((h) => h.id === 'qa-box')?.metrics?.cpuPct, 14)
  assert.equal(snap.workers.find((w) => w.id === 'ctx_http_1')?.bot, 'Alpha Delivery')

  const jump = await worker.request('hq.openSession', {
    workspaceId: 'r1::/work/alpha/gpu-task',
    host: 'gpu-box'
  })
  assert.equal(jump.opened, true)
  assert.equal(jump.mode, 'activated')
  assert.deepEqual(activatedArgs, { host: 'gpu-box', selector: 'id:r1::/work/alpha/gpu-task' })

  await worker.deactivate()
})

test('auto-discovers Tailscale hub relay with zero config and accurately attributes hub-hosted bots and multi-hop children', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-hub', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.80.1.2:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list' && !args.includes('--environment')) {
      return {
        bots: [
          { id: 'b-local', name: 'Laptop Bot', agent: 'opencode', chats: { count: 1 } },
          { id: 'b-cop', name: 'Orion Copilot', agent: 'antigravity', chats: { count: 5 } },
          { id: 'b-del', name: 'Alpha Delivery', agent: 'antigravity', chats: { count: 3 } }
        ]
      }
    }
    return { workers: [], worktrees: [] }
  }

  const mockMetrics: MetricsRunner = async (hostId) => {
    if (hostId !== 'local') return null
    return { cpuPct: 10, ramPct: 45, ramUsedGb: 28, ramTotalGb: 64, diskPct: 50, diskFreeGb: 200, load1: 1.0, cores: 16, osName: 'macOS', gpu: null }
  }

  let probedUrl = ''
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot(target) {
      probedUrl = target.baseUrl
      assert.equal(target.token, '')
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: { cpuPct: 21, ramPct: 55, ramUsedGb: 8.8, ramTotalGb: 16, diskPct: 80, diskFreeGb: 40, load1: 1.5, cores: 10, osName: 'macOS', gpu: null },
          bots: [
            { id: 'b-cop', name: 'Orion Copilot', agent: 'antigravity' },
            { id: 'b-del', name: 'Alpha Delivery', agent: 'antigravity' }
          ],
          worktrees: [
            { worktreeId: 'folder:cop', repo: 'Bots', bot: 'Orion Copilot', botHome: true, status: 'working', lastActivityAt: 900 },
            { worktreeId: 'r1::/work/alpha/task-1', hostId: 'runtime:c1', repo: 'alpha', bot: 'Alpha Delivery', displayName: 'task-1', path: '/work/alpha/task-1', status: 'working', lastActivityAt: 950 }
          ]
        },
        children: [
          {
            env: { id: 'c1', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.80.2.3:6768' }] },
            envName: 'gpu-box',
            ok: true,
            workers: [
              { dispatchId: 'ctx_auto_1', state: 'working', liveness: 'live', agent: 'antigravity', workspace: 'r1::/work/alpha/task-1' }
            ],
            remotePs: [],
            metrics: { cpuPct: 15, ramPct: 30, ramUsedGb: 10, ramTotalGb: 32, diskPct: 40, diskFreeGb: 100, load1: 1.2, cores: 20, osName: 'Linux', gpu: { name: 'RTX 4070', utilPct: 10, vramUsedMiB: 200, vramTotalMiB: 12282, tempC: 40, powerW: 20 } }
          },
          {
            env: { id: 'c2', name: 'tier3-rack', endpoints: [{ endpoint: 'ws://100.80.3.4:6768' }] },
            envName: 'tier3-rack',
            viaChain: 'edge-hub',
            ok: true,
            workers: [],
            remotePs: [],
            metrics: { cpuPct: 8, ramPct: 22, ramUsedGb: 14, ramTotalGb: 64, diskPct: 20, diskFreeGb: 400, load1: 0.5, cores: 32, osName: 'Linux', gpu: null }
          }
        ]
      }
    },
    async activateWorktree() { return true }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(probedUrl, 'http://100.80.1.2:19768')
  assert.equal(snap.hosts.length, 4)
  assert.equal(snap.bots.find((b) => b.name === 'Laptop Bot')?.botHost, 'local')
  assert.equal(snap.bots.find((b) => b.name === 'Orion Copilot')?.botHost, 'hub-mac')
  assert.equal(snap.bots.find((b) => b.name === 'Orion Copilot')?.primaryHost, 'hub-mac')
  assert.equal(snap.bots.find((b) => b.name === 'Alpha Delivery')?.botHost, 'hub-mac')
  assert.equal(snap.bots.find((b) => b.name === 'Alpha Delivery')?.primaryHost, 'gpu-box')
  assert.equal(snap.workers.find((w) => w.id === 'ctx_auto_1')?.bot, 'Alpha Delivery')
  assert.ok(snap.hosts.find((h) => h.id === 'tier3-rack')?.role.includes('HUB-MAC → EDGE-HUB'))

  await worker.deactivate()
})

test('isolates QA/Delivery routing per host domain and prevents OS username path collisions across hosts', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-hub', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.80.1.2:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list' && !args.includes('--environment')) {
      return {
        bots: [
          { id: 'b-mqa', name: 'Studio QA', agent: 'opencode', chats: { count: 2 } },
          { id: 'b-alex', name: 'Alex Local Bot', agent: 'antigravity', chats: { count: 1 } },
          { id: 'b-adel', name: 'Alpha Delivery', agent: 'antigravity', chats: { count: 4 } },
          { id: 'b-aqa', name: 'Alpha QA', agent: 'antigravity', chats: { count: 3 } }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && !args.includes('--environment')) {
      return {
        worktrees: [
          { worktreeId: 'folder:mqa', repo: 'Bots', bot: 'Studio QA', botHome: true, status: 'idle', lastActivityAt: 100 },
          { worktreeId: 'folder:alex', repo: 'Bots', bot: 'Alex Local Bot', botHome: true, status: 'idle', lastActivityAt: 100 }
        ]
      }
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list' && args.includes('hub-mac')) {
      return {
        workers: [
          {
            dispatchId: 'ctx_hub_fe',
            state: 'succeeded',
            liveness: 'exited',
            agent: 'antigravity',
            workspace: 'r1::/Users/alex/orca/workspaces/frontend/alph-490-frontend'
          }
        ]
      }
    }
    return { workers: [], worktrees: [] }
  }

  const mockMetrics: MetricsRunner = async (hostId) => {
    if (hostId !== 'local') return null
    return { cpuPct: 20, ramPct: 50, ramUsedGb: 32, ramTotalGb: 64, diskPct: 70, diskFreeGb: 100, load1: 2.0, cores: 16, osName: 'macOS', gpu: null }
  }

  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: { cpuPct: 18, ramPct: 52, ramUsedGb: 8.3, ramTotalGb: 16, diskPct: 75, diskFreeGb: 45, load1: 1.3, cores: 10, osName: 'macOS', gpu: null },
          bots: [
            { id: 'b-adel', name: 'Alpha Delivery', agent: 'antigravity' },
            { id: 'b-aqa', name: 'Alpha QA', agent: 'antigravity' }
          ],
          worktrees: []
        },
        children: [
          {
            env: { id: 'c-qa', name: 'qa-linux', endpoints: [{ endpoint: 'ws://100.80.2.5:6768' }] },
            envName: 'qa-linux',
            ok: true,
            workers: [],
            remotePs: [],
            metrics: { cpuPct: 12, ramPct: 30, ramUsedGb: 4.5, ramTotalGb: 15, diskPct: 20, diskFreeGb: 60, load1: 0.8, cores: 16, osName: 'Linux', gpu: null }
          }
        ]
      }
    },
    async activateWorktree() { return true }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  // Local QA bot on laptop must NOT heuristically connect to hub-mac's downstream qa-linux
  const studioQa = snap.bots.find((b) => b.name === 'Studio QA')
  assert.equal(studioQa?.botHost, 'local')
  assert.equal(studioQa?.primaryHost, 'local')
  assert.equal(studioQa?.secondaryHost, null)

  // Hub-hosted QA bot DOES connect to hub-mac's downstream qa-linux
  const alphaQa = snap.bots.find((b) => b.name === 'Alpha QA')
  assert.equal(alphaQa?.botHost, 'hub-mac')
  assert.equal(alphaQa?.primaryHost, 'qa-linux')

  // Worker on hub-mac under /Users/alex/... must NOT be misattributed to Alex Local Bot on laptop
  const hubFeWorker = snap.workers.find((w) => w.id === 'ctx_hub_fe')
  assert.equal(hubFeWorker?.bot, 'Alpha Delivery')
  const alexBot = snap.bots.find((b) => b.name === 'Alex Local Bot')
  assert.equal(alexBot?.botHost, 'local')
  assert.equal(alexBot?.primaryHost, 'local')

  await worker.deactivate()
})
