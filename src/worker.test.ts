import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRunner, MetricsRunner, RelayCliRunner, VideoSaver, WallOpener } from './worker'
import * as main from './worker'

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
      main.default(orca, mockCli, mockMetrics, mockVideoSaver, mockWallOpener),
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
    default: (orca: Parameters<typeof main.default>[0]) => main.default(orca, mockCli, mockMetrics),
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
      main.default(orca, mockCli, mockMetrics, undefined, undefined, mockRelayCli),
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
