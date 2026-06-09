# Hive Architecture

This document describes how data flows through Hive, from agent process discovery to the dashboard tile turning green.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Primary Mac                          │
│                                                             │
│  Terminal.app                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ claude   │ │ codex    │ │ claude   │ │ openclaw │      │
│  │ (Q1)     │ │ (Q2)     │ │ (Q3)     │ │ (Q4)     │      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      │
│       │             │            │             │             │
│       ▼             ▼            ▼             ▼             │
│  ┌──────────────────────────────────────────────────┐       │
│  │                 Hive Daemon                       │       │
│  │                                                   │       │
│  │  Discovery ──► Telemetry ──► WebSocket Server     │       │
│  │  (ps/lsof)     (state)       (port 3002)    ◄────┼──┐    │
│  │                    │                              │  │    │
│  │  Auto-Pilot    REST API      Satellite Relay      │  │    │
│  │  (unstick)    (port 3001)    (federation)         │  │    │
│  │                    │                              │  │    │
│  │  Coordination  Review Manager                     │  │    │
│  │  (locks/pad)   (auto-detect)                      │  │    │
│  └──────────────────────────────────────────────────┘  │    │
│                                                         │    │
│                              ┌───────────────────┐      │    │
│                              │  ngrok/cloudflared │      │    │
│                              │  (public tunnel)   │──────┘    │
│                              └───────────────────┘           │
└─────────────────────────────────────────────────────────────┘
         │                              │
         │ WebSocket (wss://)           │ WebSocket (wss://)
         ▼                              ▼
  ┌──────────────┐              ┌──────────────┐
  │  Dashboard   │              │  Satellite   │
  │  (Vercel)    │              │  Mac         │
  │  Phone/Web   │              │  (more       │
  │              │              │   agents)    │
  └──────────────┘              └──────────────┘
```

## Data Flow: Agent Discovery → Dashboard

### 1. Process Discovery (`discovery.ts`)

Every 3 seconds, the daemon scans for AI agent processes:

```
ps -eo pid,pcpu,lstart,tty,command
```

This finds any process matching known patterns (`claude`, `codex`, `openclaw`, or custom agents defined in `~/.hive/agents.json`).

For each discovered process:
- `lsof -p PID` extracts the working directory, TTY device, and open file handles
- Session file resolution finds the agent's JSONL log (6-step priority chain)
- JSONL tail analysis determines initial status (working/idle)

New agents appear on the dashboard within 3-6 seconds.

### 2. Status Detection (Seven JSONL/Hook Layers + CPU/PTY Corroboration)

The status detection system determines whether an agent is working (green), idle (red), or stuck (yellow). Seven cooperating JSONL/hook layers plus a CPU/PTY corroboration signal prevent phantom green (false working state):

| Layer | Where | What it does |
|-------|-------|-------------|
| 1. Noise filtering | `analyzeJsonlTail` | Filters progress/system/file-history entries before scanning |
| 2. High confidence | `analyzeJsonlTail` | Marks tool_use as high-confidence, mid-stream heuristics as low |
| 3. Corroboration | `runJsonlAnalysis` | Low-confidence working blocked unless hooks or input confirm |
| 4. Confidence-gated cooldown | `runJsonlAnalysis` | Only high-confidence signals set the 25s working timer |
| 5. Extended cooldown | `runJsonlAnalysis` | 25s green holdover after genuine tool calls (covers API thinking) |
| 6. Idle lock | `runJsonlAnalysis` | Hysteresis-confirmed idle is locked until real evidence of work |
| 7. Input override | `runJsonlAnalysis` | Dashboard message clears idle lock immediately |

On top of those seven, the **CPU/PTY corroboration signal** (Layer 8a: process CPU usage, Layer 8b: terminal output byte offsets) checks for real activity when the other signals are ambiguous.

### 3. Hook Events (`telemetry.ts`)

Claude Code sends hook events via HTTP POST to the daemon:

- **PreToolUse**  --  Agent is about to call a tool (fastest signal, ~350ms)
- **PostToolUse**  --  Tool call completed
- **Notification**  --  Permission prompt or idle state
- **UserPromptSubmit**  --  New prompt received (triggers identity injection)
- **Stop**  --  Session ended

Hooks are routed to workers via session ID → worker ID mapping. A pending hook queue handles the race condition where hooks arrive before discovery registers the session.

### 4. WebSocket Broadcasting (`ws-server.ts`)

The WebSocket server pushes state to connected clients:

- **Dashboard clients** receive `workers` (full state), `worker_update` (single change), `chat_history` (conversation stream), and `reviews` (auto-detected push/PR/deploy events)
- **Satellite clients** exchange bidirectional worker state and command relay

### 5. Dashboard Rendering (`apps/dashboard/`)

The dashboard is a Next.js static export deployed to Vercel. It connects via WebSocket and renders:

- Agent tiles in a grid (green/yellow/red status dots)
- Chat panel for sending messages to any agent
- Spawn dialog for creating new agents
- Review drawer for git push/PR/deploy notifications
- Presence bar showing connected users
- Message attribution (who sent each message)
- Activity feed (human actions visible to all)

## Multiplayer

Hive supports multiple humans on the same dashboard with role-based access.

### User Registry (`user-registry.ts`)

Named users with per-user tokens and four roles:
- **Admin**: full control (spawn, kill, message, revert, manage users and reviews)
- **Operator**: can message agents and manage tasks, cannot kill/spawn/revert/manage users
- **Voice**: same WebSocket rights as operator (message, selection, prompt approval, context transfer, file upload, subscriptions, all reads), minus the admin-gated types; intended for voice-driven clients
- **Viewer**: read-only dashboard access

Users are stored at `~/.hive/users.json`. The existing single admin token from `~/.hive/token` is backwards-compatible: on first load, a bootstrap admin user is created from it. The legacy viewer token (SHA-256 derived) also continues to work.

### WebSocket Admin Gating

Role enforcement applies to the WebSocket control plane, not just REST. Over WS, the message types `spawn`, `kill`, `revert`, `review_dismiss`, `review_clear_all`, `user_list`, `user_create`, and `user_remove` require the admin role and return `{type: "error", error: "Admin access required"}` for operator and voice tokens, mirroring REST's `requireAdmin` routes (`POST /api/spawn`, `/api/kill`, `/api/revert`, `DELETE /api/reviews[/:id]`, `/api/users`). Operator and voice retain `message`, `selection`, `approve_prompt`, `context_transfer`, `upload_file`, subscriptions, and all reads. Two operator-visible consequences: listing users (`user_list`, used by the Invite dialog) and dismissing or clearing reviews are admin-only over WS. Viewers are unchanged: a read-only allowlist of `list`, `worker_context`, `push_subscribe`, and `push_unsubscribe`.

### Presence

The WebSocket server tracks which users are connected and broadcasts presence to all clients. The dashboard shows who is watching in real time.

### Activity Feed

Human actions (messages sent, agents spawned, prompts approved) are broadcast as activity events to all connected clients with the user's name attached.

### REST API

- `GET /api/users` -- list all users (admin only, no tokens in response)
- `POST /api/users { name, role }` -- create user, returns token (admin only)
- `DELETE /api/users/:id` -- remove user (admin only)

## Module Map

### Core (daemon)

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `telemetry.ts` | Worker state, hooks, dispatch, context building | coordination, review-manager, swarm-controller |
| `discovery.ts` | Process scanning, JSONL analysis, status detection | telemetry, session-stream |
| `tty-input.ts` | Send text/keystrokes to Terminal.app tabs | AppleScript, CGEvent (macOS-specific) |
| `ws-server.ts` | WebSocket, dashboard commands, satellite federation | telemetry, tty-input, discovery |
| `session-stream.ts` | JSONL tail following, chat history parsing | fs.watch, multi-format (Claude/Codex/Gemini) |
| `auto-pilot.ts` | Auto-respond to stuck prompts (3s grace) | telemetry, tty-input |
| `user-registry.ts` | Named users, role-based tokens, presence tracking | standalone |

### Extracted Modules

| Module | Responsibility | Extracted from |
|--------|---------------|---------------|
| `review-manager.ts` | Auto-detect git push/PR/deploy, review lifecycle | telemetry.ts |
| `coordination.ts` | Scratchpad, file locks, artifact tracking, conflicts | telemetry.ts |
| `swarm-controller.ts` | Cross-machine spawn/kill/exec/repair routing | telemetry.ts |

### Platform Layer

| Module | Purpose |
|--------|---------|
| `platform/interfaces.ts` | Cross-platform interfaces (TerminalIO, ProcessDiscoverer, WindowManager) |
| `platform/macos/index.ts` | Thin adapter wrapping existing macOS-specific daemon modules |
| `platform/linux/` | tmux + /proc implementation for pane-based Linux runtime control |
| `platform/index.ts` | Auto-detect OS and load the correct platform at startup |

### Packages

| Package | Purpose |
|---------|---------|
| `@rohitmangtani/hive` | CLI package for `hive init` and `hive doctor` flows (not yet published to npm; run via `npm run hive` from a clone) |
| `@hive/types` | Shared TypeScript interfaces (WorkerState, etc.) |

## Multi-Machine Federation

Satellite machines connect to the primary daemon via WebSocket tunnel:

1. Primary runs ngrok/cloudflared tunnel exposing port 3002
2. Satellite connects with `--satellite wss://tunnel-url TOKEN`
3. Satellite runs local discovery + session streaming
4. Every 3 seconds, satellite sends `satellite_workers` with local worker states
5. Primary merges satellite workers into the dashboard alongside local ones
6. Commands (message, spawn, kill) are relayed bidirectionally

Satellite self-healing: disconnected satellites escalate from reconnect → local repair → local reinstall using stored credentials at `~/.hive/primary-url` and `~/.hive/primary-token`. Federation dials time out after 15 seconds instead of waiting for the OS TCP timeout, so URL rotation proceeds promptly during outages. Tunnel restarts only target the actual tunnel spawn signatures, never arbitrary processes whose command line happens to mention ngrok or cloudflared.

### Machine Identity and Update Safety

- **Machine identity** is persisted in `~/.hive/machine-id` (hostname plus a 4-character random suffix, generated once), so identically named machines never collide. Deleting the file changes the satellite's identity.
- **Auto-updates are gated and validated.** After `git pull`, the satellite runs `npm install` (600-second timeout) and `npx tsc --noEmit` before restarting. Failures roll back to the pre-pull commit via `git reset --keep` and report `ok:false` to the primary. Nothing restarts on a no-op pull.
- **Update-loop protection.** Repeated failed updates from the same running version back off exponentially (5m/20m/80m) and give up loudly after 4 attempts with a 6-hour auto-retry. State lives in `~/.hive/update-state.json`; delete it to force an immediate retry.
- **URL history.** `~/.hive/primary-urls-history.txt` records every primary URL the satellite has ever learned (last 20).
- **Merged worker view.** On satellites, `~/.hive/workers.json` always contains the merged cross-machine view, so `identity.sh` peer summaries work on satellites too. Peers age out 2 minutes after federation loss.
- **Push key hygiene.** `~/.hive/vapid.json` and `~/.hive/push-subs.json` are mode 600. A corrupt or invalid `vapid.json` no longer crash-loops the daemon: keys regenerate automatically, or push is disabled for the run.
- **Operator runbook.** When a satellite logs "Exhausted all known primary URL candidate(s)", read the current URL on the primary (`cat ~/.hive/tunnel-url.txt`) and re-run `bash scripts/install.sh --connect <url> <token>` on the satellite.

## Platform Abstraction

The daemon now loads its platform at startup through `apps/daemon/src/platform/` and routes discovery, terminal I/O, layout, local spawn/kill, and satellite-side control through that abstraction.

### Interfaces (`platform/interfaces.ts`)

- `TerminalIO`  --  send text, keystrokes, and selections to agent terminals; read terminal content
- `ProcessDiscoverer`  --  find running agent processes, get CPU usage, track PTY output
- `WindowManager`  --  spawn/close terminals, arrange window layout

### Implementations

| Platform | Location | Status |
|----------|----------|--------|
| macOS | `platform/macos/index.ts` | Thin wrapper over existing `tty-input.ts`, `discovery.ts`, `arrange-windows.ts` |
| Linux | `platform/linux/` | tmux-based: `send-keys`, `capture-pane`, `/proc` reads, pane-based layout. Wired into runtime, with live Linux host validation still pending. Discovery matches `claude` started with arguments (including Hive's own spawner command and `node .../cli.js` wrappers). |
| Windows | `platform/windows/` | PowerShell (`Get-CimInstance`) process discovery, file-based inbox delivery (`~/.hive/inbox/`): messages reach the agent via hooks on its next prompt or tool call. No keystroke delivery, so prompt approval/selection happens at the terminal. Window positions reported for separate-window (cmd.exe) installs; with Windows Terminal tabs, only the first agent per window reports a position. Agents whose working directory cannot be derived are attributed to HOME. |

### macOS-specific code (current direct imports)

| Module | macOS dependency |
|--------|-----------------|
| `tty-input.ts` | AppleScript `do script` + CGEvent `send-return` binary |
| `discovery.ts` | `ps -eo lstart`, `lsof -p PID` |
| `arrange-windows.ts` | AppleScript window positioning |
| `process-mgr.ts` | Terminal.app tab spawning |

### What remains for Linux hardening

The platform interfaces and Linux implementation are live in the daemon now. The remaining work is:
1. Integration test on a real Linux machine with tmux installed
2. Refine pane layout behavior to better match Hive's visual quadrant model under different terminal sizes
3. Harden Linux-specific failure modes around tmux session loss, reconnects, and process cleanup
4. Expand end-to-end coverage beyond the unit-tested tmux pane manager

See [GitHub issue #4](https://github.com/RohitMangtani/hive/issues/4).

## Measured Performance

Data from a 60-day period (Jan 23 - Mar 24, 2026) comparing single-agent workflows to Hive-managed multi-agent sessions across five repositories.

### Output

| | Pre-Hive (36 days) | With Hive (25 days) |
|---|---|---|
| Commits/day | 7.6 | 38.4 |
| Active coding days | 14 of 36 (39%) | 25 of 25 (100%) |
| Repos active per day | 1 | 4 |
| Total commits | 275 | 961 |

### Parallelism

Pre-Hive, 77% of active days had a single repository receiving commits. With Hive, 60% of active days had four or more repositories receiving commits simultaneously.

| Concurrent repos | Pre-Hive | With Hive |
|---|---|---|
| 1 (sequential) | 10 days | 1 day |
| 2-3 | 2 days | 9 days |
| 4+ (parallel) | 1 day | 15 days |

### What the system tracked

Over the Hive period, the daemon logged 48,372 tool call events, 7,298 status transitions, caught 51 cross-agent file conflicts, and recorded 451 hourly coordination snapshots. The detection pipeline described above (seven JSONL/hook layers plus a CPU/PTY corroboration signal) produced these signals without any manual instrumentation from the user.
