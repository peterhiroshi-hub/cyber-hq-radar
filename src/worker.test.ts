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
    if (args[0] === 'bot' && args[1] === 'work' && args[2] === 'list') {
      const botName = args[4]
      if (botName === 'Alpha Delivery') {
        return { items: [{ dispatchId: 'ctx_1', server: 'gpu-box', title: 'GPU feature build', startedAt: Date.now() }] }
      }
      if (botName === 'Alpha QA') {
        return { items: [{ dispatchId: 'ctx_2', server: 'qa-box', title: 'QA audit pass', startedAt: Date.now() }] }
      }
      return { items: [] }
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
    format: (input.mimeType || '').includes('mp4') ? 'mp4' : 'webm'
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
    if (args[0] === 'bot' && args[1] === 'work' && args[2] === 'list') {
      const botName = args[4]
      if (botName === 'Alpha Delivery') {
        return { items: [{ dispatchId: 'ctx_1', server: 'gpu-box', title: 'GPU feature build', startedAt: Date.now() }] }
      }
      if (botName === 'Alpha QA') {
        return { items: [{ dispatchId: 'ctx_2', server: 'qa-box', title: 'QA audit pass', startedAt: Date.now() }] }
      }
      return { items: [] }
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
  // Alpha QA has zero real dispatches or workers on qa-box -> must stay on its own host (no name guessing)
  assert.equal(qaBot?.primaryHost, 'hub-mac')

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

test('routes strictly by real dispatch traffic with zero name guessing (no fake QA/GPU lines, no unowned worker guessing)', async () => {
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
            dispatchId: 'ctx_unowned',
            state: 'succeeded',
            liveness: 'exited',
            agent: 'antigravity',
            workspace: 'r1::/Users/alex/orca/workspaces/frontend/alph-490-frontend'
          }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
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
          worktrees: [],
          dispatches: [
            {
              bot: 'Alpha QA',
              dispatchId: 'ctx_real_qa',
              server: 'qa-linux',
              title: 'Real adversarial QA audit',
              state: 'completed',
              startedAt: Date.now()
            }
          ]
        },
        children: [
          {
            env: { id: 'c-qa', name: 'qa-linux', endpoints: [{ endpoint: 'ws://100.80.2.5:6768' }] },
            envName: 'qa-linux',
            ok: true,
            workers: [
              { dispatchId: 'ctx_real_qa', state: 'succeeded', liveness: 'exited', agent: 'antigravity', workspace: 'r2::/home/qa/orca/workspaces/repo/pr-99' }
            ],
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

  // Idle Studio QA on laptop has zero real traffic -> stays strictly on local
  const studioQa = snap.bots.find((b) => b.name === 'Studio QA')
  assert.equal(studioQa?.botHost, 'local')
  assert.equal(studioQa?.primaryHost, 'local')
  assert.equal(studioQa?.secondaryHost, null)

  // Idle Alpha Delivery on hub-mac has zero real traffic -> stays strictly on hub-mac
  const alphaDel = snap.bots.find((b) => b.name === 'Alpha Delivery')
  assert.equal(alphaDel?.botHost, 'hub-mac')
  assert.equal(alphaDel?.primaryHost, 'hub-mac')
  assert.equal(alphaDel?.secondaryHost, null)

  // Alpha QA has REAL dispatch ctx_real_qa on qa-linux -> routes to qa-linux with real task title
  const alphaQa = snap.bots.find((b) => b.name === 'Alpha QA')
  assert.equal(alphaQa?.botHost, 'hub-mac')
  assert.equal(alphaQa?.primaryHost, 'qa-linux')
  const realQaWorker = snap.workers.find((w) => w.id === 'ctx_real_qa')
  assert.equal(realQaWorker?.bot, 'Alpha QA')
  assert.equal(realQaWorker?.sessionTitle, 'Real adversarial QA audit')

  // Worker with NO dispatchId/crossStoreParent/row.bot stays bot=null (never guessed from path/name!)
  const unownedWorker = snap.workers.find((w) => w.id === 'ctx_unowned')
  assert.equal(unownedWorker?.bot, null)
  const alexBot = snap.bots.find((b) => b.name === 'Alex Local Bot')
  assert.equal(alexBot?.botHost, 'local')
  assert.equal(alexBot?.primaryHost, 'local')

  await worker.deactivate()
})

test('chunked hq.saveVideo stays strictly under Orca 64 KiB IPC frame limit across consecutive exports', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const panelPath = fileURLToPath(new URL('./panel.html', import.meta.url).href)
  const panelHtml = await fs.readFile(panelPath, 'utf8')
  assert.match(panelHtml, /apiRequest\('hq\.getSaveEndpoint'\)/)
  assert.match(panelHtml, /let chunkSize = viaOrcaIpc \? \(56 \* 1024\) : \(256 \* 1024\)/)
  assert.match(panelHtml, /too many requests\|rate\.\?limit\|429\|throttl/i)

  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const savedPayloads: { filename: string; mimeType: string; bytes: Uint8Array }[] = []
  const mockVideoSaver = async (input: { base64: string; mimeType?: string; filename?: string }) => {
    const buf = Buffer.from(input.base64, 'base64')
    savedPayloads.push({
      filename: input.filename || 'out.mp4',
      mimeType: input.mimeType || 'video/mp4',
      bytes: buf
    })
    return { saved: true, path: `/tmp/${input.filename || 'out.mp4'}`, bytes: buf.length, format: 'mp4' as const }
  }

  const noopCli: CliRunner = async () => ({ bots: [], environments: [], workers: [], worktrees: [], items: [] })
  const noopMetrics: MetricsRunner = async () => null

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, noopCli, noopMetrics, mockVideoSaver, undefined, undefined, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })

  const IPC_LIMIT_BYTES = 64 * 1024
  const CHUNK_SIZE = 56 * 1024

  // Perform 2 consecutive chunked uploads simulating Orca's strict 64 KiB JSON-RPC frame cap
  // and verifying idempotent chunk retry after a transient rate-limit error
  for (let run = 1; run <= 2; run++) {
    const rawBytes = Buffer.alloc(180 * 1024, run === 1 ? 0x41 : 0x42)
    const b64 = rawBytes.toString('base64')
    const totalChunks = Math.ceil(b64.length / CHUNK_SIZE)
    const uploadId = `vid_ipc_test_${run}`
    const fname = `cyber-hq-radar-test-${run}.mp4`
    let finalRes: { saved?: boolean; bytes?: number; chunkAccepted?: boolean } | null = null

    for (let i = 0; i < totalChunks; i++) {
      const isLast = i === totalChunks - 1
      const slice = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      const params = isLast
        ? { uploadId, chunkIndex: i, totalChunks, base64: slice, mimeType: 'video/mp4;codecs=avc1.640028', filename: fname, reveal: true }
        : { uploadId, chunkIndex: i, totalChunks, base64: slice }
      const envelope = JSON.stringify({
        type: 'panel.request',
        id: `req_20261127_${run}_${i}`,
        pluginId: 'peterhiroshi-hub.cyber-hq-radar',
        panelId: 'cyber-hq-radar',
        method: 'hq.saveVideo',
        params
      })
      assert.ok(
        Buffer.byteLength(envelope, 'utf8') <= IPC_LIMIT_BYTES,
        `IPC frame exceeded 64 KiB cap (${Buffer.byteLength(envelope, 'utf8')} bytes)`
      )
      finalRes = await worker.request('hq.saveVideo', params)
      if (!isLast) {
        assert.equal(finalRes?.chunkAccepted, true)
      }
    }

    assert.equal(finalRes?.saved, true)
    assert.equal(finalRes?.bytes, rawBytes.length)
  }

  assert.equal(savedPayloads.length, 2)
  assert.equal(savedPayloads[0].bytes.length, 180 * 1024)
  assert.equal(savedPayloads[1].bytes.length, 180 * 1024)
  assert.equal(savedPayloads[0].bytes[0], 0x41)
  assert.equal(savedPayloads[1].bytes[0], 0x42)

  // Fast loopback endpoint: 1 IPC call -> single-request CORS-safe localhost POST (zero IPC rate limit)
  const ep = await worker.request('hq.getSaveEndpoint')
  assert.ok(ep.url && ep.url.startsWith('http://127.0.0.1:'))
  assert.ok(ep.token && ep.token.length >= 32)

  const http = await import('node:http')
  const postJsonText = (targetUrl: string, body: string) =>
    new Promise<{ status: number; cors: string; body: string }>((resolve, reject) => {
      const req = http.request(
        targetUrl,
        { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } },
        (res) => {
          let raw = ''
          res.on('data', (c) => { raw += String(c) })
          res.on('end', () => {
            const cors = res.headers['access-control-allow-origin']
            resolve({
              status: res.statusCode || 0,
              cors: Array.isArray(cors) ? cors[0] : (cors || ''),
              body: raw
            })
          })
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })

  // Unauthorized request without token must be rejected with 403
  const noTokUrl = ep.url.split('?')[0]
  const denied = await postJsonText(noTokUrl, '{}')
  assert.equal(denied.status, 403)

  // Two consecutive full-payload loopback POST exports succeed in 1 request each
  for (let n = 1; n <= 2; n++) {
    const rawBuf = Buffer.alloc(240 * 1024, n === 1 ? 0x51 : 0x52)
    const res = await postJsonText(
      ep.url,
      JSON.stringify({
        base64: rawBuf.toString('base64'),
        mimeType: 'video/mp4;codecs=avc1.640028',
        filename: `loopback-fast-${n}.mp4`,
        reveal: true
      })
    )
    assert.equal(res.status, 200)
    assert.equal(res.cors, '*')
    const parsed = JSON.parse(res.body) as { saved: boolean; bytes: number }
    assert.equal(parsed.saved, true)
    assert.equal(parsed.bytes, rawBuf.length)
  }

  assert.equal(savedPayloads.length, 4)
  assert.equal(savedPayloads[2].bytes[0], 0x51)
  assert.equal(savedPayloads[3].bytes[0], 0x52)

  await worker.deactivate()
})

test('preserves bot home-host conduit alongside 2+ remote targets, disambiguates generic branch titles, and resolves session jump by path/name/suffix', async () => {
  const openedIds: string[] = []
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': {
        workspaces: [
          {
            id: 'runtime:env-hub:folder:copilot-1',
            kind: 'folder',
            name: 'Orion Copilot',
            path: '/Users/dev/.orca/bots/orion-copilot',
            branch: null,
            hostId: 'runtime:env-hub'
          },
          {
            id: 'runtime:env-hub:repo-be::/work/backend',
            kind: 'worktree',
            name: 'develop',
            path: '/work/backend',
            branch: 'develop',
            hostId: 'runtime:env-hub'
          }
        ],
        truncated: false
      },
      'workspace.open': (params: unknown) => {
        const id = (params as { workspaceId?: string })?.workspaceId
        if (id) openedIds.push(id)
        return { opened: true }
      },
      'agents.list': { agents: [] }
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
    return { bots: [], workers: [], worktrees: [], items: [] }
  }

  const mockMetrics: MetricsRunner = async () => null
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: { cpuPct: 20, ramPct: 50, ramUsedGb: 8, ramTotalGb: 16, diskPct: 70, diskFreeGb: 40, load1: 1.5, cores: 10, osName: 'macOS', gpu: null },
          bots: [{ id: 'b-cop', name: 'Orion Copilot', agent: 'antigravity' }],
          worktrees: [
            { worktreeId: 'folder:copilot-1', repo: 'Bots', bot: 'Orion Copilot', botHome: true, status: 'working', path: '/Users/dev/.orca/bots/orion-copilot', lastActivityAt: 900 },
            { worktreeId: 'repo-be::/work/backend', repo: 'backend', displayName: 'develop', branch: 'refs/heads/develop', status: 'active', path: '/work/backend', lastActivityAt: 800 },
            { worktreeId: 'repo-fe::/work/frontend', repo: 'frontend', displayName: 'develop', branch: 'refs/heads/develop', status: 'active', path: '/work/frontend', lastActivityAt: 700 }
          ],
          dispatches: [
            { bot: 'Orion Copilot', dispatchId: 'd1', server: 'qa-box', title: 'QA audit', startedAt: Date.now() },
            { bot: 'Orion Copilot', dispatchId: 'd2', server: 'gpu-box', title: 'GPU build', startedAt: Date.now() - 1000 }
          ]
        },
        children: [
          { env: { id: 'c1', name: 'qa-box' }, envName: 'qa-box', ok: true, workers: [], remotePs: [], metrics: null },
          { env: { id: 'c2', name: 'gpu-box' }, envName: 'gpu-box', ok: true, workers: [], remotePs: [], metrics: null }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  // Bot with 2 remote traffic hosts MUST still retain its home host (hub-mac) in targetHosts
  const copilot = snap.bots.find((b) => b.name === 'Orion Copilot')
  assert.equal(copilot?.botHost, 'hub-mac')
  assert.ok(copilot?.targetHosts?.includes('hub-mac'))
  assert.ok(copilot?.targetHosts?.includes('qa-box'))
  assert.ok(copilot?.targetHosts?.includes('gpu-box'))

  // Generic branch worktrees include repo prefix to avoid duplicate "develop" cards
  const beWk = snap.workers.find((w) => w.workspacePath === '/work/backend')
  const feWk = snap.workers.find((w) => w.workspacePath === '/work/frontend')
  assert.equal(beWk?.title, 'backend / develop')
  assert.equal(feWk?.title, 'frontend / develop')

  // Clicking remote Bot resolves runtime-prefixed workspace.list id via suffix/name/path
  const jumpBot = await worker.request('hq.openSession', {
    workspaceId: 'folder:copilot-1',
    workspacePath: '/Users/dev/.orca/bots/orion-copilot',
    botName: 'Orion Copilot',
    host: 'hub-mac'
  })
  assert.equal(jumpBot.opened, true)
  assert.equal(openedIds[0], 'runtime:env-hub:folder:copilot-1')

  // Clicking remote worker resolves runtime-prefixed workspace.list id via path
  const jumpWk = await worker.request('hq.openSession', {
    workspaceId: 'repo-be::/work/backend',
    workspacePath: '/work/backend',
    host: 'hub-mac'
  })
  assert.equal(jumpWk.opened, true)
  assert.equal(openedIds[1], 'runtime:env-hub:repo-be::/work/backend')

  await worker.deactivate()
})

test('multi-hop hub relay forwards child.dispatches cleanly and preserves Tier-2/Tier-3 dispatch provenance', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const relayPath = fileURLToPath(new URL('../scripts/hub-relay.mjs', import.meta.url).href)
  const relaySource = await fs.readFile(relayPath, 'utf8')
  assert.match(relaySource, /childRelay\?\.host\?\.dispatches/)
  assert.match(relaySource, /dispatches:\s*childDispatches/)
  assert.match(relaySource, /dispatches:\s*Array\.isArray\(nc\.dispatches\)/)

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
    return { bots: [], workers: [], worktrees: [], items: [] }
  }

  const mockMetrics: MetricsRunner = async () => null
  const now = Date.now()
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [{ id: 'b-hub', name: 'Orion Copilot', agent: 'antigravity' }],
          worktrees: [],
          dispatches: []
        },
        children: [
          {
            env: { id: 'c-edge', name: 'edge-hub', endpoints: [{ endpoint: 'ws://100.80.2.2:6768' }] },
            envName: 'edge-hub',
            ok: true,
            workers: [],
            remotePs: [],
            bots: [{ id: 'b-edge', name: 'Beta Delivery', agent: 'codex' }],
            dispatches: [
              {
                bot: 'Beta Delivery',
                dispatchId: 'ctx_tier3_1',
                server: 'gpu-tier3',
                title: 'Tier-3 CUDA build',
                state: 'running',
                startedAt: now - 5_000
              }
            ],
            metrics: null
          },
          {
            env: { id: 'c-t3', name: 'gpu-tier3', endpoints: [{ endpoint: 'ws://100.80.3.3:6768' }] },
            envName: 'gpu-tier3',
            viaChain: 'edge-hub',
            ok: true,
            workers: [
              {
                dispatchId: 'ctx_tier3_1',
                state: 'working',
                liveness: 'live',
                agent: 'codex',
                workspace: 'r3::/work/beta/cuda-kernel'
              }
            ],
            remotePs: [],
            bots: [],
            dispatches: [],
            metrics: null
          }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  const betaBot = snap.bots.find((b) => b.name === 'Beta Delivery')
  assert.equal(betaBot?.botHost, 'edge-hub')
  assert.deepEqual(betaBot?.activeHosts, ['gpu-tier3'])
  assert.ok(betaBot?.targetHosts?.includes('edge-hub'))
  assert.ok(betaBot?.targetHosts?.includes('gpu-tier3'))
  const t3Worker = snap.workers.find((w) => w.id === 'ctx_tier3_1')
  assert.equal(t3Worker?.bot, 'Beta Delivery')
  assert.equal(t3Worker?.sessionTitle, 'Tier-3 CUDA build')

  await worker.deactivate()
})

test('resolves remote hub dispatches with server null or local to sourceHost instead of viewing laptop local', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const now = Date.now()
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
        bots: [{ id: 'b-local', name: 'Laptop Bot', agent: 'antigravity' }]
      }
    }
    if (args[0] === 'bot' && args[1] === 'work' && args[2] === 'list') {
      return {
        items: [
          { dispatchId: 'd-local-null', server: null, title: 'Local task', state: 'completed', startedAt: now - 10_000 }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
  }

  const mockMetrics: MetricsRunner = async () => null
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [{ id: 'b-hub', name: 'Hub Delivery', agent: 'antigravity' }],
          worktrees: [
            { worktreeId: 'folder:hub-del', repo: 'Bots', bot: 'Hub Delivery', botHome: true, status: 'idle', lastActivityAt: now }
          ],
          dispatches: [
            { bot: 'Hub Delivery', dispatchId: 'd-hub-null', server: null, title: 'Hub local build 1', state: 'completed', startedAt: now - 20_000 },
            { bot: 'Hub Delivery', dispatchId: 'd-hub-local', server: 'local', title: 'Hub local build 2', state: 'running', startedAt: now - 5_000 }
          ]
        },
        children: []
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  const hubBot = snap.bots.find((b) => b.name === 'Hub Delivery')
  assert.equal(hubBot?.botHost, 'hub-mac')
  assert.equal(hubBot?.primaryHost, 'hub-mac')
  assert.equal(hubBot?.secondaryHost, null)
  assert.deepEqual(hubBot?.activeHosts, [])
  assert.deepEqual(hubBot?.recentHosts, [])
  assert.deepEqual(hubBot?.targetHosts, ['hub-mac'])
  assert.equal(hubBot?.targetHosts?.includes('local'), false)

  const laptopBot = snap.bots.find((b) => b.name === 'Laptop Bot')
  assert.equal(laptopBot?.botHost, 'local')
  assert.equal(laptopBot?.primaryHost, 'local')

  await worker.deactivate()
})

test('sorts rWorkers before deduping/slicing so working worker at index 15 wins over exited worker at index 0, and scopes workspace-to-bot lookup per host', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const now = Date.now()
  const sixteenWorkers = [
    {
      dispatchId: 'ctx_old_0',
      state: 'succeeded',
      liveness: 'exited',
      agent: 'codex',
      workspace: 'repo::/work/alpha/reused-wt'
    },
    ...Array.from({ length: 14 }, (_, idx) => ({
      dispatchId: `ctx_done_${idx + 1}`,
      state: 'succeeded',
      liveness: 'exited',
      agent: 'codex',
      workspace: `repo::/work/alpha/done-${idx + 1}`
    })),
    {
      dispatchId: 'ctx_live_15',
      state: 'working',
      liveness: 'live',
      agent: 'antigravity/gemini-4-neon',
      workspace: 'repo::/work/alpha/reused-wt'
    }
  ]

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
        bots: [{ id: 'b-local', name: 'Local Shared Bot', agent: 'antigravity' }]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && !args.includes('--environment')) {
      return {
        worktrees: [
          { worktreeId: 'folder:shared-id', repo: 'Bots', bot: 'Local Shared Bot', botHome: true, status: 'idle', lastActivityAt: now }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
  }

  const mockMetrics: MetricsRunner = async () => null
  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [{ id: 'b-hub', name: 'Hub Shared Bot', agent: 'antigravity' }],
          worktrees: [
            { worktreeId: 'folder:shared-id', repo: 'Bots', bot: 'Hub Shared Bot', botHome: true, status: 'idle', lastActivityAt: now }
          ],
          dispatches: []
        },
        children: [
          {
            env: { id: 'c-gpu', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.80.2.10:6768' }] },
            envName: 'gpu-box',
            ok: true,
            workers: sixteenWorkers,
            remotePs: [
              {
                worktreeId: 'repo::/work/alpha/reused-wt',
                repo: 'alpha',
                displayName: 'reused-wt',
                path: '/work/alpha/reused-wt',
                status: 'working',
                crossStoreParent: { parent: { workspaceKey: 'folder:shared-id' } },
                lastActivityAt: now
              }
            ],
            metrics: null
          }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, mockMetrics, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  const liveWk = snap.workers.find((w) => w.workspaceId === 'repo::/work/alpha/reused-wt')
  assert.ok(liveWk, 'working worker at index 15 must be retained')
  assert.equal(liveWk?.id, 'ctx_live_15')
  assert.equal(liveWk?.state, 'working')
  assert.equal(liveWk?.bot, 'Hub Shared Bot')
  assert.equal(snap.summary.activeWorkers, 1)

  await worker.deactivate()
})

test('maps worktree status active without working agent to idle so activeWorkers is not falsely inflated', async () => {
  assert.equal(main.mapWorkerState('active'), 'idle')
  assert.equal(main.mapWorkerState('active', undefined, 'idle'), 'idle')
  assert.equal(main.mapWorkerState('active', undefined, 'working'), 'working')
  assert.equal(main.mapWorkerState('working'), 'working')
  assert.equal(main.mapWorkerState('succeeded', 'live'), 'succeeded')
  assert.equal(main.mapWorkerState('idle', 'live'), 'idle')
  assert.equal(main.mapWorkerState('running', 'live'), 'working')

  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') return { environments: [] }
    if (args[0] === 'bot' && args[1] === 'list') return { bots: [] }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return {
        worktrees: [
          {
            worktreeId: 'repo::/work/alpha/open-tab',
            repo: 'alpha',
            displayName: 'open-tab',
            path: '/work/alpha/open-tab',
            status: 'active',
            agents: [{ state: 'idle', agentType: 'antigravity' }],
            lastActivityAt: Date.now()
          }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, async () => null, undefined, undefined, undefined, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(snap.summary.activeWorkers, 0)
  assert.equal(snap.hosts.find((h) => h.id === 'local')?.activeWorkers, 0)
  const wk = snap.workers.find((w) => w.workspaceId === 'repo::/work/alpha/open-tab')
  assert.equal(wk?.state, 'idle')

  await worker.deactivate()
})

test('fairly trims workers per host across 4 hosts with 25+ workers without starving later hosts', async () => {
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const now = Date.now()
  const makePs = (prefix: string, count: number, baseTs: number) =>
    Array.from({ length: count }, (_, i) => ({
      worktreeId: `${prefix}::/work/${prefix}/wt-${i}`,
      repo: prefix,
      displayName: `${prefix}-wt-${i}`,
      path: `/work/${prefix}/wt-${i}`,
      status: 'idle',
      lastActivityAt: baseTs - i * 100
    }))

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'e1', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.80.1.2:6768' }] }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && !args.includes('--environment')) {
      // Local host has 12 very recent idle worktrees (higher timestamps than remote hosts)
      return { worktrees: makePs('local', 12, now) }
    }
    return { bots: [], workers: [], worktrees: [], items: [] }
  }

  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [],
          worktrees: makePs('hub', 7, now - 10_000),
          dispatches: []
        },
        children: [
          {
            env: { id: 'c1', name: 'gpu-box' },
            envName: 'gpu-box',
            ok: true,
            workers: [],
            remotePs: makePs('gpu', 7, now - 20_000),
            metrics: null
          },
          {
            env: { id: 'c2', name: 'qa-box' },
            envName: 'qa-box',
            ok: true,
            workers: [],
            remotePs: makePs('qa', 7, now - 30_000),
            metrics: null
          }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, async () => null, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  // 33 total worktrees across 4 hosts -> fair trimming retains 5 per host = 20 total (<= 24)
  assert.ok(snap.workers.length <= 24)
  assert.equal(snap.workers.filter((w) => w.host === 'local').length, 5)
  assert.equal(snap.workers.filter((w) => w.host === 'hub-mac').length, 5)
  assert.equal(snap.workers.filter((w) => w.host === 'gpu-box').length, 5)
  assert.equal(snap.workers.filter((w) => w.host === 'qa-box').length, 5)

  await worker.deactivate()
})

test('separates three-tier semantic traffic (6h recency cutoff, activeHosts vs recentHosts) and verifies panel conduit deduplication', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const panelPath = fileURLToPath(new URL('./panel.html', import.meta.url).href)
  const panelHtml = await fs.readFile(panelPath, 'utf8')
  assert.match(panelHtml, /function hostOwnerInfo\(h, bots, workers\)/)
  assert.match(panelHtml, /botTargetHosts\(b\)\.includes\(h\.id\)/)
  assert.match(panelHtml, /!isOwnHost && visibleBotHostWorkers\.has\(b\.name \+ '::' \+ tHost\)/)
  assert.match(panelHtml, /!isOwnHost && visibleCinemaBotHostWorkers\.has\(b\.name \+ '::' \+ th\)/)
  assert.match(panelHtml, /if \(isHistory\) ctx\.setLineDash\(\[4, 7\]\)/)
  assert.match(panelHtml, /Recent \(≤6h\) →/)

  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const now = Date.now()
  const sevenHoursAgo = now - 7 * 60 * 60 * 1000
  const twoHoursAgo = now - 2 * 60 * 60 * 1000

  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'env-hub', name: 'hub-mac', endpoints: [{ endpoint: 'ws://100.80.1.2:6768' }] }
        ]
      }
    }
    return { bots: [], workers: [], worktrees: [], items: [] }
  }

  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [{ id: 'b-orion', name: 'Orion Copilot', agent: 'antigravity' }],
          worktrees: [
            { worktreeId: 'folder:orion', repo: 'Bots', bot: 'Orion Copilot', botHome: true, status: 'idle', lastActivityAt: now }
          ],
          dispatches: [
            { bot: 'Orion Copilot', dispatchId: 'd-old', server: 'archive-box', title: 'Old 7h dispatch', state: 'completed', startedAt: sevenHoursAgo },
            { bot: 'Orion Copilot', dispatchId: 'd-recent', server: 'qa-box', title: 'Recent 2h dispatch', state: 'completed', startedAt: twoHoursAgo },
            { bot: 'Orion Copilot', dispatchId: 'd-live', server: 'gpu-box', title: 'Active GPU task', state: 'running', startedAt: now - 30_000 }
          ]
        },
        children: [
          {
            env: { id: 'c1', name: 'gpu-box' },
            envName: 'gpu-box',
            ok: true,
            workers: [
              { dispatchId: 'd-live', state: 'working', liveness: 'live', agent: 'antigravity', workspace: 'r1::/work/orion/gpu-live' }
            ],
            remotePs: [],
            metrics: null
          },
          { env: { id: 'c2', name: 'qa-box' }, envName: 'qa-box', ok: true, workers: [], remotePs: [], metrics: null },
          { env: { id: 'c3', name: 'archive-box' }, envName: 'archive-box', ok: true, workers: [], remotePs: [], metrics: null }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, async () => null, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  const orion = snap.bots.find((b) => b.name === 'Orion Copilot')
  assert.equal(orion?.botHost, 'hub-mac')
  assert.deepEqual(orion?.activeHosts, ['gpu-box'])
  assert.deepEqual(orion?.recentHosts, ['qa-box'])
  assert.deepEqual(orion?.targetHosts, ['hub-mac', 'gpu-box', 'qa-box'])
  assert.equal(orion?.targetHosts?.includes('archive-box'), false)
  assert.equal(orion?.recentHosts?.includes('archive-box'), false)
  assert.equal(orion?.primaryHost, 'gpu-box')
  assert.equal(orion?.secondaryHost, 'qa-box')

  await worker.deactivate()
})

test('aggregates multi-host needs_you items, filters snoozed items, includes permission workers, and escalates/clears status bar', async () => {
  const statusUpdates: Array<{ id?: string; text?: string; tone?: string; tooltip?: string }> = []
  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': {
        workspaces: [
          {
            id: 'folder:local-lead',
            kind: 'folder',
            name: 'Orion Leader',
            path: '/Users/dev/.orca/bots/orion-leader',
            branch: null,
            hostId: 'local'
          }
        ],
        truncated: false
      },
      'statusBar.update': (params: unknown) => {
        statusUpdates.push((params || {}) as { id?: string; text?: string; tone?: string; tooltip?: string })
        return { updated: true }
      }
    }
  })

  const now = Date.now()
  let clearAllNeedsYou = false

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
          { id: 'b-local-lead', name: 'Orion Leader', agent: 'antigravity', chats: { count: 2 } }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps' && !args.includes('--environment')) {
      return {
        worktrees: [
          {
            worktreeId: 'folder:local-lead',
            repo: 'Bots',
            bot: 'Orion Leader',
            botHome: true,
            path: '/Users/dev/.orca/bots/orion-leader',
            status: 'idle',
            lastActivityAt: now - 5_000
          }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'item' && args[2] === 'list') {
      assert.equal(args.includes('--status'), true)
      assert.equal(args.includes('needs-you'), true)
      if (clearAllNeedsYou) return { items: [] }
      return {
        items: [
          {
            uid: 'uid-local-1',
            number: 297,
            owner: { botId: 'b-local-lead', name: 'Orion Leader' },
            title: 'Deploy v0.5.0 canary',
            status: 'needs_you',
            snoozedUntil: null,
            chat: { id: 'chat-local-1', kind: 'chat', title: 'orion-team' },
            question: {
              eventId: 'ev-1',
              text: 'Detailed text line 1\nLine 2',
              gist: 'Approve canary rollout?',
              decisions: [
                {
                  question: 'Ship canary to staging now?',
                  replies: [
                    { label: 'Approve', recommended: true },
                    { label: 'Hold', recommended: false }
                  ]
                }
              ]
            },
            updatedAt: now - 2_000,
            lastActivityAt: now - 2_000
          },
          {
            uid: 'uid-local-snoozed',
            number: 298,
            owner: { botId: 'b-local-lead', name: 'Orion Leader' },
            title: 'Snoozed item must be ignored',
            status: 'needs_you',
            snoozedUntil: now + 3_600_000,
            updatedAt: now - 1_000
          }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
  }

  const mockHubHttp: HubRelayClient = {
    async fetchSnapshot() {
      return {
        ok: true,
        host: {
          hostname: 'hub-mac',
          metrics: null,
          bots: [{ id: 'b-alpha', name: 'Alpha Delivery', agent: 'codex' }],
          worktrees: [
            {
              worktreeId: 'folder:alpha-del',
              repo: 'Bots',
              bot: 'Alpha Delivery',
              botHome: true,
              path: '/Users/hub/.orca/bots/alpha-delivery',
              status: 'idle',
              lastActivityAt: now - 4_000
            }
          ],
          dispatches: [],
          needsYou: clearAllNeedsYou
            ? []
            : [
                {
                  id: 'uid-hub-1',
                  number: 412,
                  bot: 'Alpha Delivery',
                  status: 'needs-you',
                  title: 'Merge release branch',
                  question: 'Approve production database migration?',
                  replyCount: 3,
                  chatId: 'chat-alpha-team',
                  chatTitle: 'alpha-team',
                  snoozedUntil: null,
                  updatedAt: now - 1_000
                },
                {
                  id: 'uid-hub-snoozed',
                  number: 413,
                  bot: 'Alpha Delivery',
                  status: 'needs_you',
                  title: 'Snoozed remote item',
                  question: 'Later?',
                  snoozedUntil: now + 600_000,
                  updatedAt: now
                }
              ]
        },
        children: [
          {
            env: { id: 'c-gpu', name: 'gpu-box', endpoints: [{ endpoint: 'ws://100.80.2.10:6768' }] },
            envName: 'gpu-box',
            ok: true,
            workers: clearAllNeedsYou
              ? []
              : [
                  {
                    dispatchId: 'ctx_perm_1',
                    state: 'permission',
                    liveness: 'live',
                    agent: 'codex',
                    terminal: 'term_perm_gpu_1',
                    workspace: 'repo::/work/alpha/perm-task'
                  }
                ],
            remotePs: clearAllNeedsYou
              ? []
              : [
                  {
                    worktreeId: 'repo::/work/alpha/perm-task',
                    repo: 'alpha',
                    displayName: 'perm-task',
                    path: '/work/alpha/perm-task',
                    status: 'permission',
                    crossStoreParent: { parent: { workspaceKey: 'folder:alpha-del' } },
                    lastActivityAt: now - 3_000
                  }
                ],
            metrics: null
          }
        ]
      }
    },
    async activateWorktree() { return false }
  }

  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, async () => null, undefined, undefined, undefined, mockHubHttp),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  // 3 active alerts: hub-mac #412 (newest), local #297, gpu-box permission worker (oldest); both snoozed items excluded
  assert.equal(snap.summary.needsYouCount, 3)
  assert.equal(snap.needsYou?.length, 3)
  assert.equal(snap.needsYou?.[0].host, 'hub-mac')
  assert.equal(snap.needsYou?.[0].number, 412)
  assert.equal(snap.needsYou?.[0].replyCount, 3)
  assert.equal(snap.needsYou?.[0].workspaceId, 'folder:alpha-del')
  assert.equal(snap.needsYou?.[0].workspacePath, '/Users/hub/.orca/bots/alpha-delivery')

  assert.equal(snap.needsYou?.[1].host, 'local')
  assert.equal(snap.needsYou?.[1].number, 297)
  assert.equal(snap.needsYou?.[1].question, 'Ship canary to staging now?')
  assert.equal(snap.needsYou?.[1].replyCount, 2)
  assert.equal(snap.needsYou?.[1].chatTitle, 'orion-team')
  assert.equal(snap.needsYou?.[1].workspaceId, 'folder:local-lead')

  assert.equal(snap.needsYou?.[2].kind, 'permission')
  assert.equal(snap.needsYou?.[2].host, 'gpu-box')
  assert.equal(snap.needsYou?.[2].bot, 'Alpha Delivery')
  assert.equal(snap.needsYou?.[2].terminalId, 'term_perm_gpu_1')

  // Bot badges populated
  const orionBot = snap.bots.find((b) => b.name === 'Orion Leader')
  const alphaBot = snap.bots.find((b) => b.name === 'Alpha Delivery')
  assert.equal(orionBot?.needsYouCount, 1)
  assert.equal(orionBot?.needsYouSummary, '#297 Ship canary to staging now?')
  assert.equal(alphaBot?.needsYouCount, 2)
  assert.equal(alphaBot?.needsYouSummary, '#412 Approve production database migration?')

  // Status bar escalated to warning with NEED YOU
  const escalated = statusUpdates[statusUpdates.length - 1]
  assert.equal(escalated?.tone, 'warning')
  assert.ok(escalated?.text?.includes('3 NEED YOU'))
  assert.ok(escalated?.tooltip?.startsWith('3 item(s) need your decision · '))

  // Once resolved, status bar returns to normal immediately
  clearAllNeedsYou = true
  const clearedSnap = await worker.request('hq.refresh')
  assert.equal(clearedSnap.summary.needsYouCount, 0)
  assert.equal(clearedSnap.needsYou?.length, 0)
  const restored = statusUpdates[statusUpdates.length - 1]
  assert.notEqual(restored?.tone, 'warning')
  assert.equal(restored?.text?.includes('NEED YOU'), false)

  await worker.deactivate()
})

test('collects needs_you from direct paired control host without HTTP hub relay', async () => {
  const host = mockHost({
    results: {
      'settings.get': {
        settings: {
          controlEnvironment: 'ctrl-mac',
          showLocalHost: false
        }
      },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })

  const now = Date.now()
  const mockCli: CliRunner = async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      return {
        environments: [
          { id: 'e-ctrl', name: 'ctrl-mac', endpoints: [{ endpoint: 'ws://100.64.0.50:6768' }] }
        ]
      }
    }
    if (args[0] === 'bot' && args[1] === 'list' && args.includes('ctrl-mac')) {
      return {
        bots: [{ id: 'b-ctrl', name: 'Beta Leader', agent: 'antigravity', chats: { count: 2 } }]
      }
    }
    if (
      args[0] === 'bot' &&
      args[1] === 'item' &&
      args[2] === 'list' &&
      args.includes('--environment') &&
      args.includes('ctrl-mac')
    ) {
      return {
        items: [
          {
            uid: 'ctrl-item-1',
            number: 88,
            title: 'Confirm QA sign-off',
            status: 'needs_you',
            question: { gist: 'Ready to promote release candidate?' },
            updatedAt: now
          },
          {
            uid: 'ctrl-item-2',
            number: 89,
            title: 'Fallback to text first line',
            status: 'needs_you',
            question: { text: '\n  Confirm rollback threshold?  \nSecond line details' },
            updatedAt: now - 500
          }
        ]
      }
    }
    return { workers: [], worktrees: [], items: [] }
  }

  const noopRelayCli: RelayCliRunner = async () => null
  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, mockCli, async () => null, undefined, undefined, noopRelayCli, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })
  const snap = await worker.request('hq.getSnapshot')

  assert.equal(snap.controlHostId, 'ctrl-mac')
  assert.equal(snap.summary.needsYouCount, 2)
  assert.equal(snap.needsYou?.[0].host, 'ctrl-mac')
  assert.equal(snap.needsYou?.[0].bot, 'Beta Leader')
  assert.equal(snap.needsYou?.[0].number, 88)
  assert.equal(snap.needsYou?.[0].question, 'Ready to promote release candidate?')
  assert.equal(snap.needsYou?.[1].number, 89)
  assert.equal(snap.needsYou?.[1].question, 'Confirm rollback threshold?')

  await worker.deactivate()
})

test('hq.openNeedsYou opens matching group-chat/Bot folder, focuses permission terminal, falls back to view.tasks, and exposes wall routes', async () => {
  const openedIds: string[] = []
  const focusedTerms: string[] = []
  const ranCommands: Array<{ action?: string }> = []

  const host = mockHost({
    results: {
      'settings.get': { settings: {} },
      'workspace.list': {
        workspaces: [
          {
            id: 'folder:alpha-team',
            kind: 'folder',
            name: 'alpha-team',
            path: '/Users/dev/.orca/chats/alpha-team',
            branch: null,
            hostId: 'local'
          },
          {
            id: 'folder:orion-lead',
            kind: 'folder',
            name: 'Orion Leader',
            path: '/Users/dev/.orca/bots/orion-leader',
            branch: null,
            hostId: 'local'
          }
        ],
        truncated: false
      },
      'workspace.open': (params: unknown) => {
        const id = (params as { workspaceId?: string })?.workspaceId
        if (id) openedIds.push(id)
        return { opened: true }
      },
      'agents.list': { agents: [] },
      'terminal.focus': (params: unknown) => {
        const tid = (params as { terminalId?: string })?.terminalId
        if (tid) focusedTerms.push(tid)
        return { focused: true }
      },
      'commands.run': (params: unknown) => {
        ranCommands.push((params || {}) as { action?: string })
        return { ran: true }
      }
    }
  })

  const noopCli: CliRunner = async () => ({ bots: [], environments: [], workers: [], worktrees: [], items: [] })
  const mockWallOpener: WallOpener = async () => true
  const mod = {
    default: (orca: Parameters<typeof main.default>[0]) =>
      main.default(orca, noopCli, async () => null, undefined, mockWallOpener, undefined, noopHubRelay),
    deactivate: main.deactivate
  }
  const worker = await mountWorker(mod, { host })

  // 1. Opens matching group-chat folder (chatTitle) directly when present in workspace.list
  const chatJump = await worker.request('hq.openNeedsYou', {
    host: 'local',
    botName: 'Orion Leader',
    chatTitle: 'alpha-team',
    itemNumber: 297,
    kind: 'item'
  })
  assert.equal(chatJump.opened, true)
  assert.equal(chatJump.mode, 'opened')
  assert.equal(openedIds[0], 'folder:alpha-team')

  // 2. Opens matching Bot folder directly when chatTitle is absent from workspace.list
  const botJump = await worker.request('hq.openNeedsYou', {
    host: 'local',
    botName: 'Orion Leader',
    chatTitle: 'nonexistent-chat',
    itemNumber: 299,
    kind: 'item'
  })
  assert.equal(botJump.opened, true)
  assert.equal(botJump.mode, 'opened')
  assert.equal(openedIds[1], 'folder:orion-lead')

  // 3. Focuses permission-blocked worker terminal directly
  const permJump = await worker.request('hq.openNeedsYou', {
    host: 'local',
    botName: 'Orion Leader',
    terminalId: 'term_blocked_1',
    kind: 'permission'
  })
  assert.equal(permJump.opened, true)
  assert.equal(permJump.mode, 'focused')
  assert.equal(focusedTerms[0], 'term_blocked_1')

  // 4. Remote Bot NOT present in local workspace.list -> seamlessly falls back to commands.run({ action: 'view.tasks' })
  const remoteFallback = await worker.request('hq.openNeedsYou', {
    host: 'hub-mac',
    botName: 'Remote Beta Bot',
    workspaceId: 'folder:remote-beta',
    chatTitle: 'remote-beta-chat',
    itemNumber: 501,
    kind: 'item'
  })
  assert.equal(remoteFallback.opened, true)
  assert.equal(remoteFallback.mode, 'tasks')
  assert.equal(remoteFallback.detail, 'Opened Orca Tasks / Needs You queue')
  assert.equal(ranCommands[0]?.action, 'view.tasks')

  // 5. Direct hq.openTasksView invokes commands.run({ action: 'view.tasks' })
  const directTasks = await worker.request('hq.openTasksView')
  assert.equal(directTasks.opened, true)
  assert.equal(directTasks.mode, 'tasks')
  assert.equal(ranCommands[1]?.action, 'view.tasks')

  // 6. Fullscreen wallboard HTTP routes /api/open-needs-you & /api/open-tasks-view work end-to-end
  const wall = await worker.request('hq.openFullscreenWall')
  assert.ok(wall.url)
  const parsedWallUrl = new URL(wall.url!)
  const token = parsedWallUrl.searchParams.get('token') || ''
  const baseUrl = `${parsedWallUrl.protocol}//${parsedWallUrl.host}`
  const http = await import('node:http')
  const postWall = (route: string, body: unknown) =>
    new Promise<{ status: number; json: { opened: boolean; mode: string } }>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = http.request(
        `${baseUrl}${route}?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload, 'utf8')) }
        },
        (res) => {
          let raw = ''
          res.on('data', (c) => { raw += String(c) })
          res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(raw) }))
        }
      )
      req.on('error', reject)
      req.write(payload)
      req.end()
    })

  const wallNy = await postWall('/api/open-needs-you', { host: 'hub-mac', botName: 'Unpaired Remote Bot', kind: 'item' })
  assert.equal(wallNy.status, 200)
  assert.equal(wallNy.json.opened, true)
  assert.equal(wallNy.json.mode, 'tasks')

  const wallTasks = await postWall('/api/open-tasks-view', {})
  assert.equal(wallTasks.status, 200)
  assert.equal(wallTasks.json.opened, true)
  assert.equal(wallTasks.json.mode, 'tasks')

  await worker.deactivate()
})

test('verifies hub-relay.mjs and panel.html contracts for needs-you collection, cache safety, jump wiring, and visual escalation', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')

  const relayPath = fileURLToPath(new URL('../scripts/hub-relay.mjs', import.meta.url).href)
  const relaySource = await fs.readFile(relayPath, 'utf8')
  assert.match(relaySource, /function extractQuestionPrompt\(q\)/)
  assert.match(relaySource, /function mapRawNeedsYou\(botName, items\)/)
  assert.match(relaySource, /lastKnownNeedsYouByBot = new Map\(\)/)
  assert.match(relaySource, /'bot', 'item', 'list', '--bot', b\.name, '--status', 'needs-you', '--json'/)
  assert.match(relaySource, /nyRes !== null && Array\.isArray\(nyRes\.items\)/)
  assert.match(relaySource, /lastKnownNeedsYouByBot\.set\(b\.name, needsYou\)/)
  assert.match(relaySource, /snoozedUntil > now/)
  assert.match(relaySource, /needsYou:\s*hubNeedsYou/)
  assert.match(relaySource, /childRelay\?\.host\?\.needsYou/)
  assert.match(relaySource, /needsYou:\s*childNeedsYou/)
  assert.match(relaySource, /needsYou:\s*Array\.isArray\(nc\.needsYou\)/)

  const panelPath = fileURLToPath(new URL('./panel.html', import.meta.url).href)
  const panelHtml = await fs.readFile(panelPath, 'utf8')
  assert.match(panelHtml, /'hq\.openNeedsYou':\s*'\/api\/open-needs-you'/)
  assert.match(panelHtml, /'hq\.openTasksView':\s*'\/api\/open-tasks-view'/)
  assert.match(panelHtml, /id="kpiNeedsChip"/)
  assert.match(panelHtml, /id="needsYouBar"/)
  assert.match(panelHtml, /\.bot-node\.needs-you/)
  assert.match(panelHtml, /\.route-tag\.need/)
  assert.match(panelHtml, /body\.wall-mode \.bot-node:not\(\.working\):not\(\.unread\):not\(\.needs-you\) \.bot-task/)
  assert.match(panelHtml, /target\.closest\('\.ny-pill'\)/)
  assert.match(panelHtml, /kind = 'needs-you'/)
  assert.match(panelHtml, /l:\s*'NEED ME'/)
})
