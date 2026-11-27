# Cyber HQ Radar (Orca Plugin)

An all-in-one cyberpunk fleet command dashboard for [Orca](https://orca.so) that makes your multi-agent Bots, distributed Workers, and paired machine performance transparent at a single glance.

## Features

- **All-in-One 3-Layer Live Topology**
  - **Left Bay (Bot Brains)**: Every Orca Bot grouped automatically by squad (`COMMAND` + discovered squads), showing live status (`LIVE` / `UNREAD` / `READY`), active tool & task summary, and color-coded engine/model badges with custom SVG icons (`AGY`, `CODEX`, `OPENCODE`, `CLAUDE`, `CURSOR`).
  - **Center Arena (Mesh Radar & Fiber Conduits)**: Smooth 60fps zero-reflow holographic radar with real-time animated Bezier conduits, neon comet packets, arrival shockwaves, and live oscilloscope heartbeat linking each Bot straight to its active Workers across paired servers.
  - **Right Bay (Compute Pods + Live Telemetry Gauges + Hosted Workers)**: Live SVG arc gauges (`CPU`, `RAM`, `DISK`, plus NVIDIA `GPU` / `VRAM` / Temp / Power via `nvidia-smi`), rolling `CPU/GPU WAVE` sparklines, and every Worker physically nested inside the machine executing it.
- **Engine Mix Chart**: Real-time segmented distribution bar & icon counters across all Bots and Workers (with exact sub-model tags like `AGY·4-NEON`).
- **One-Click Jump to Orca Session**: Click any Bot or Worker (local or remote paired server) to jump directly into its Orca workspace/session.
- **Fullscreen Wallboard (`⛶ FULLSCREEN`)**: Launches a dedicated loopback-only (`127.0.0.1` + random per-session token) live SSE command wall scaled to `100vw × 100vh` for secondary displays or TVs.
- **One-Click 1080p Showcase Video Export (`● REC 1080P`)**: Records an 8-second `1920×1080 @ 30fps` cinema capture of your real live fleet directly to `~/Downloads`.
- **Remote Console Mode (Zero Overhead on Your Control Host)**: Install Cyber HQ Radar on a separate monitoring laptop (e.g. MacBook Pro) to watch a remote Mac mini / Linux cluster over paired Orca environments + SSH without adding UI rendering load to your Bot host.

## Installation

Install directly from GitHub in Orca CLI:

```bash
orca plugin install PeterHiroshi/cyber-hq-radar
```

Orca will display the plugin's exact capabilities (`trusted-worker`, `workspace:read`, `workspace:write`, `agent:read`, `storage:own`, `settings:own`) and an approval fingerprint. Re-run with `--approve <fingerprint>` after reviewing:

```bash
orca plugin install PeterHiroshi/cyber-hq-radar --approve <fingerprint>
```

Then open the panel in Orca's right sidebar:

```bash
orca plugin open PeterHiroshi.cyber-hq-radar --panel cyber-hq-radar
```

## Remote Console Mode (Monitoring a Cluster from Another Machine)

To run Cyber HQ Radar on your laptop while keeping your Bot control plane on another machine (for example, a Mac mini + paired Linux servers):

1. Pair your control host (and worker servers) in Orca on your monitoring laptop (`orca environment add ...`).
2. Ensure passwordless SSH (e.g. via Tailscale or `~/.ssh/config`) works from your laptop to the servers you want hardware telemetry for.
3. Open **Orca Settings → Plugins → Cyber HQ Radar** and optionally configure:

| Setting | Default | Description |
| --- | --- | --- |
| `controlEnvironment` | `""` (auto) | Paired Orca environment name hosting your Bots (auto-detected if local Orca has no Bots). |
| `sshTargets` | `""` | Optional comma-separated `envName=user@host` overrides for SSH CPU/RAM/Disk/GPU telemetry. |
| `showLocalHost` | `true` | Turn `false` on a dedicated monitoring laptop to hide the laptop itself and show only remote cluster machines. |
| `pollIntervalSec` | `10` | Sweep interval in seconds (`5–120`). |

## Security & Permissions

- **Why `trusted-worker`**: Needed to invoke the local `orca` CLI for Bot/environment/worker status, collect host CPU/RAM/Disk/GPU metrics locally or via SSH (`BatchMode=yes`), save exported videos to `~/Downloads`, and serve the loopback-only (`127.0.0.1`) Fullscreen Wallboard with a random 128-bit per-session auth token.
- **No external network calls**: All telemetry stays strictly on your local machine and your own paired Orca/SSH hosts.

## Development

```bash
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin dev load . --json
```

## License

MIT © 2026 PeterHiroshi
