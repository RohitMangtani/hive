# Hive

Multi-agent orchestration layer for LLM-based development workflows. One dashboard across multiple models, multiple machines, multiple people, and every handoff in plain English. macOS, Windows, and Linux.

![Hive stacked dashboard diagram](docs/hive-stack.svg)

When multiple AI agents are working at the same time, the bottleneck quickly becomes coordination rather than generation. Terminal logs are manageable for a single process, but once several agents are active across different projects, it becomes difficult to track state, progress, and dependencies across sessions.

Hive is a lightweight visual coordination layer that mirrors active agent sessions as a grid of tiles with real-time status. The dashboard maps 1:1 to your terminal layout. Green means working. Red means done. Yellow means it needs you. You look at your phone and know exactly which terminal needs attention without reading output.

One person or a team. Multiple models. Multiple machines. The output of a company.

### One person built five projects in 25 days

Measured over 60 days across five repositories. The first 36 days used a single AI agent with manual terminal management. The last 25 days used Hive.

| | Before Hive | With Hive | Change |
|---|---|---|---|
| **Output** | 275 commits in 36 days | 961 commits in 25 days | **5x throughput** |
| **Parallelism** | 1 project at a time (77% of days) | 4+ projects simultaneously (60% of days) | **Sequential → parallel** |
| **Scope** | 2 repos touched in 36 days | 5 repos shipped in 25 days | **More in less time** |
| **Coordination** | Alt-tab between terminals, copy-paste context, check if each agent is working or stuck | Glance at phone — green means working, red means done, yellow means it needs you | **Automated** |
| **Visibility** | Each commit is the only thing you see. The 50 tool calls behind it are invisible. | Every read, edit, search, and retry is a status signal on the dashboard. | **50 agent decisions per commit, all visible** |
| **Handoffs** | Copy output from one terminal, paste into another, explain what it means | Tap a tile, type "take what Q2 found and write tests for it" | **214 handoffs routed in plain English** |

The five projects: two websites with 25 published articles, this orchestration system, a YouTube pipeline, and a web crawler. Full methodology in [architecture.md](docs/architecture.md#measured-performance).

**Multiplayer**: Invite collaborators to the same dashboard. Named users with roles (admin, operator, viewer, voice), live presence (see who is watching), message attribution (see who sent what), and an activity feed. Like Google Docs for AI agents.

**How it works**: [A Visual Workflow for AI Agents](https://rohitmangtani.com/writing/a-visual-workflow-for-ai-agents) covers the design thinking behind Hive, from cognitive science to the feedback loops that make visual coordination faster than reading terminal output.

**Architecture**: See [docs/architecture.md](docs/architecture.md) for the technical deep dive, including the status detection pipeline (seven JSONL/hook layers plus a CPU/PTY corroboration signal), multi-machine federation protocol, and module map.

## Install

Paste this into Claude Code or Codex:

> Install Hive for me. Clone https://github.com/RohitMangtani/hive. Before running the install script, ask me: "Which setup do you want? (1) Desktop app on this computer, (2) New Hive environment with your own hosted dashboard, or (3) Connect this computer to an existing Hive network on another machine." If I choose 1, run `npm install`, then `npm run desktop:prepare`, `npm run desktop:smoke`, and `npm run desktop:dev`. If I choose 2: on macOS/Linux run `bash scripts/install.sh --fresh`, on Windows run `powershell -File scripts\install.ps1 -Fresh`. It handles setup, dependencies, Vercel login, the daemon, and dashboard deploy. When Vercel opens my browser, I'll click authorize and it continues. Give me the dashboard URL and token it prints at the end. If I choose 3, ask me for the tunnel URL and token from the other machine, then: on macOS/Linux run `bash scripts/install.sh --connect <URL> <TOKEN>`, on Windows run `powershell -File scripts\install.ps1 -Connect -Url <URL> -Token <TOKEN>`. Give me whatever it prints at the end.

When the agent runs, approve these one-time prompts:

1. **Allow shell commands** - the agent needs to run git, npm, and the install script.
2. **Allow file access to `~/`** - Hive writes config and tokens to `~/.hive/`.
3. **Sandbox mode** - select full sandbox so the agent can run commands without pausing on every action.

**What you need beforehand:**
- macOS, Windows, or Linux with Node.js 20+ installed
- python3 (on macOS this comes with the Xcode Command Line Tools; on Windows it must be visible from Git Bash)
- A free [Vercel](https://vercel.com) account (the dashboard deploys here so you can access it from any device)
- At least one AI CLI installed: `claude`, `codex`, or `openclaw`

### Manual install (no AI CLI needed)

**macOS / Linux:**
```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
bash scripts/install.sh --fresh        # new environment
bash scripts/install.sh --connect URL TOKEN  # join existing
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/RohitMangtani/hive.git
cd hive
.\scripts\install.ps1 -Fresh           # new environment
.\scripts\install.ps1 -Connect -Url URL -Token TOKEN  # join existing
```

Inside the repo, the same flows are available through the local CLI wrapper:

```bash
npm run hive -- init --fresh
npm run hive -- init --connect URL TOKEN
npm run hive -- init --desktop
```

The CLI package is not yet published to npm, so cloning the repo first is required. Publishing it (so a single `npx` command can bootstrap everything) is planned. The CLI clones or reuses Hive at `~/hive` by default. Pass `--dir /path/to/hive` if you want a different install location.

### After install: one-time OS approvals

**macOS:** Once setup finishes, macOS may ask for permissions:

4. **Automation permission** -macOS asks "Terminal wants to control Terminal." Click **OK**. This lets Hive send messages to agents and close terminals from the dashboard. If you miss it: System Settings → Privacy & Security → Automation.
5. **Accessibility permission** (optional). If setup compiled the auto-pilot binary, it opens System Settings and Finder. Drag `send-return` into the Accessibility list and toggle it on. This lets agents auto-approve their own prompts. Skip if you prefer manual approval.

**Windows:** No special approvals needed. Windows Terminal is recommended for the best experience (`winget install Microsoft.WindowsTerminal`). A Windows primary requires Git Bash with python3 visible from bash. The satellite installs as a Task Scheduler task that auto-starts at logon.

Two Windows-specific behaviors to know about:
- **Messages are delivered via hooks, not keystrokes.** A message sent from the dashboard reaches a Windows agent on its next prompt or tool call, not instantly.
- **Prompt approval happens at the terminal.** Dashboard approve/selection clicks return an explicit error ("Keystroke delivery is not supported on Windows"); answer the prompt in the terminal window itself.

### Using your token

Once setup finishes, Hive prints your token. Copy it. Open the dashboard URL Hive gives you, paste the token into the input field at the top of the page, and hit enter. You now have full control: send messages to agents, spawn new ones, close them with the X button on each tile, and manage your fleet. The token is saved at `~/.hive/token` if you need it again.

### Running agents

Open terminal windows and run `claude`, `codex`, or `openclaw tui`. They appear on the dashboard within 3 seconds. On macOS use Terminal.app, on Windows use Windows Terminal or PowerShell, on Linux use tmux.

### Connect another computer

You can connect any Mac, Windows PC, or Linux machine to the same Hive dashboard. Terminals on the second machine appear alongside your local ones. Chat, close, and manage them all from one screen.

On the primary machine, run:

```bash
npm run invite
```

This prints the full connect command with your tunnel URL and token. Copy it.

On the second computer, clone and connect:

**macOS / Linux:**
```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
bash scripts/install.sh --connect wss://YOUR-TUNNEL-URL YOUR-TOKEN
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/RohitMangtani/hive.git
cd hive
.\scripts\install.ps1 -Connect -Url wss://YOUR-TUNNEL-URL -Token YOUR-TOKEN
```

Or paste the one-liner into Claude Code / Codex on the other machine and it handles everything.

**Connection is permanent.** The satellite installs as a background service on every OS: launchd on macOS, systemd on Linux, Task Scheduler on Windows. It survives sleep, reboot, and terminal close. Agents appear on the dashboard when the machine is awake and disappear when it sleeps.

The tunnel URL and token are printed at the end of the primary install. You can also find them at `~/.hive/tunnel-url.txt` and `~/.hive/token` on the primary machine. The connect command also appears in the install output.

Satellite terminals show a machine badge on the dashboard so you can tell which computer each agent is running on. Everything works through the active public tunnel, so the machines don't need to be on the same network. If macOS asks you to approve Node.js in System Settings → Privacy & Security, click Allow once.

The connect install is idempotent. Re-running it on the same machine updates the stored primary URL/token, cleans out stale satellite processes, and re-installs the background service cleanly.

If a satellite gets into a reconnect loop or stale state, Hive self-heals on the remote machine. A connected primary can trigger `update`, `repair`, or `reinstall`, and a disconnected satellite escalates from local repair to local reinstall automatically using the stored `~/.hive/primary-url` and `~/.hive/primary-token`.

Satellite auto-updates are gated and validated. After `git pull`, the satellite runs `npm install` (with a 600-second timeout) and `npx tsc --noEmit` before restarting. Failures roll back to the pre-pull commit via `git reset --keep` and report `ok:false` to the primary. Nothing restarts on a no-op pull. Repeated failed updates from the same running version back off exponentially (5m/20m/80m) and give up loudly after 4 attempts with a 6-hour auto-retry; this state lives in `~/.hive/update-state.json` (delete it to force an immediate retry).

Each satellite persists its identity in `~/.hive/machine-id` (hostname plus a 4-character random suffix, generated once), so identically named machines never collide. Deleting the file changes the satellite's identity. Every primary URL the satellite has ever learned is recorded in `~/.hive/primary-urls-history.txt` (last 20), and federation dials time out after 15 seconds so URL rotation proceeds promptly during outages. On satellites, `~/.hive/workers.json` always contains the merged cross-machine view, so peer summaries work there too; peers age out 2 minutes after federation loss. Satellite logs are at `~/.hive/logs/satellite.stdout.log` and `~/.hive/logs/satellite.stderr.log`.

If a satellite logs "Exhausted all known primary URL candidate(s)", read the current URL on the primary (`cat ~/.hive/tunnel-url.txt`) and re-run `bash scripts/install.sh --connect <url> <token>` on the satellite.

### Windows via WSL (alternative)

If you prefer running inside WSL2 instead of native Windows, that works too. Agents run inside WSL with full GPU access via WSL2's native GPU passthrough.

**One-time WSL setup:**

1. Open PowerShell as Administrator and install WSL2:
   ```powershell
   wsl --install -d Ubuntu
   ```
2. After reboot, open Ubuntu from the Start menu and install Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs tmux git
   ```
3. Clone and connect (paste the command from `npm run invite` on the primary):
   ```bash
   git clone https://github.com/RohitMangtani/hive.git
   cd hive
   bash scripts/install.sh --connect wss://YOUR-TUNNEL-URL YOUR-TOKEN
   ```

The satellite installs as a systemd user service inside WSL. It auto-starts when WSL boots and survives terminal close.

**GPU routing:** If `nvidia-smi` is available inside WSL (it is by default on WSL2 with NVIDIA drivers installed on Windows), Hive reports GPU name and VRAM. Queue tasks with `"requires":["gpu"]` and they route to the GPU machine.

### Local-only install (no Vercel needed)

If you just want localhost access without deploying anywhere:

```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
npm run launch:local
```

## Prerequisites

- **macOS**, **Windows**, or **Linux** - all supported as primary or satellite. Windows has two caveats: dashboard prompt approval/selection is not supported on Windows agents (answer prompts at the terminal), and messages are delivered on the agent's next prompt or tool call rather than instantly. A Windows primary needs Git Bash with python3 visible from bash.
- **Node.js 20+** - [nodejs.org](https://nodejs.org)
- **python3** - used by the identity/peer-summary hooks, Windows inbox delivery, and tunnel URL parsing. On macOS it comes with the Xcode Command Line Tools.
- **Homebrew** - [brew.sh](https://brew.sh) (macOS only, for installing tunnel tools). Linux does not need it: `install.sh` downloads the cloudflared static binary from GitHub releases when no tunnel tool is present.

That's it. Everything else is optional and the setup script handles it gracefully:

| Optional | What it enables | How to get it |
|----------|----------------|---------------|
| At least one AI CLI | Agents to manage | `npm install -g @anthropic-ai/claude-code` or `@openai/codex` or `openclaw` |
| Xcode Command Line Tools | Auto-pilot (auto-approve prompts) | `xcode-select --install` |
| ngrok (preferred when configured) | Phone/remote access, stable URLs | `brew install ngrok` then `ngrok config add-authtoken YOUR_TOKEN` ([ngrok.com](https://ngrok.com)) |
| Cloudflare tunnel (auto-fallback) | Phone/remote access, random URLs | `brew install cloudflared` |
| Vercel account | Hosted dashboard | `npx vercel login` |

Without an AI CLI, setup still completes. Install one later and agents auto-appear. Without `swiftc` there is no `~/send-return` binary, which disables auto-pilot and also means dashboard message delivery cannot press Enter on macOS (install/setup compiles it from `tools/send-return.swift`; the desktop app compiles it on first launch when the Xcode Command Line Tools are present). Without Vercel or a public tunnel tool, use `npm run launch:local` for localhost-only.

Claude, Codex, and OpenClaw can be mixed freely. Claude gets the richest hook-based telemetry. Codex and OpenClaw work out of the box through JSONL, CPU, and PTY detection. Any other terminal agent can be added via a config file (see [Custom Agents](#custom-agents)).

## Setup

Setup runs automatically when you launch Hive for the first time. You can also run it manually:

```bash
bash setup.sh
```

The setup script:
1. Checks Node.js 20+ (required) and python3 (warns if missing)
2. Detects installed AI CLIs (warns if none found, does not block)
3. Installs all npm dependencies (monorepo workspaces)
4. Compiles the `send-return` Swift binary for auto-pilot and dashboard message delivery (skipped if `swiftc` not available)
5. Generates `~/.hive/token` and `~/.hive/viewer-token`
6. Installs or updates Claude Code hooks if Claude is present
7. Prints your auth token

No root `.env` file is created. Nothing loads one; the daemon and scripts read configuration from the process environment (see `.env.example` for the variables that exist).

**Auto-approve hook consent.** The machine-wide PreToolUse auto-approve hook is consent-gated. Interactive installs explain what it does and ask Y/n. Non-interactive installs still install it (unattended automation depends on it) but print a loud notice. Control it with `--auto-approve` / `--no-auto-approve` on `install.sh`, `setup.sh`, or `setup-hooks.sh`, or with `HIVE_AUTO_APPROVE=1|0` in the environment. Remove it later with `bash setup-hooks.sh --no-auto-approve`. The `--connect` satellite flow always installs it and prints the notice instead of prompting.

### Accessibility Permission (optional, for auto-pilot)

If `swiftc` was available, setup compiles `~/send-return` and automatically opens System Settings and Finder for you:

1. **Drag** `send-return` from the Finder window into the Accessibility list
2. **Toggle it on**

That's it. Without this, agents pause on permission prompts until you approve manually, and messages sent from the dashboard cannot press Enter to submit. Everything else works fine.

## Running

You have three supported ways to run Hive:

**Standard hosted launch** (recommended)
```bash
npm run launch
```

This starts the local daemon on `3001/3002`, opens the current public tunnel for the WebSocket server, deploys or updates the dashboard to your own Vercel account, opens the hosted dashboard URL, and keeps the daemon and tunnel running in one terminal. If ngrok is installed and healthy, Hive prefers it. Otherwise it falls back to cloudflared. On a new machine, run `npx vercel login` once first.

On macOS, `bash scripts/install.sh --fresh` also installs a `com.hive.daemon` LaunchAgent (KeepAlive + RunAtLoad), so the primary daemon auto-starts at login and restarts if it dies. You do not need to keep a terminal window open. To stop it: `launchctl bootout gui/$(id -u)/com.hive.daemon`, then kill the listener on port 3001 if one is still running.

**Local-only fallback**
```bash
npm run launch:local
```

This starts the daemon and dashboard locally, opens `http://localhost:3000`, and keeps both running in one terminal.

**Manual hosted split** (same hosted behavior, separate steps)
```bash
npm start
npm run deploy:dashboard
```

This is the same hosted flow as `npm run launch`, but split into two commands.

**Manual local split** (same local behavior, separate terminals)
```bash
npm run dev:daemon
npm run dev:dashboard
```

This opens the dashboard at `localhost:3000`.

**Runtime repair**
```bash
npm run doctor
npm run doctor -- --repair-satellite
```

Use this if a machine was migrated, manually started twice, or has stale launchd/runtime state. Hive now enforces a single primary daemon and a single satellite client per machine, and `doctor` resets drift without removing any dashboard features.

Connected machines can also be repaired from the primary:

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"machine":"your-macbook","action":"repair"}' \
  http://localhost:3001/api/satellites/repair
```

**Agents** (open Terminal.app windows and run any supported CLI you installed)
```bash
claude
```
or
```bash
codex
```
or
```bash
openclaw tui
```

Stack your terminal windows vertically on screen. The daemon detects their positions and maps each one to the matching tile in the dashboard stack. Mix `claude`, `codex`, and `openclaw` however you want. You can also spawn agents from the dashboard: tap "+ Agent", pick a model, optionally add a task, and hit Spawn. If the CLI isn't installed, the tile shows a clear error instead of silently failing.

**4. Install the app on your phone** (optional, recommended)

Open the dashboard URL on your phone and add it to your home screen. It runs full-screen like a native app. See the [Install as App](#install-as-app) section below.

**Desktop wrapper (Tauri, macOS-first)**
```bash
npm run desktop:prepare
npm run desktop:smoke
npm run desktop:dev
```

This desktop wrapper keeps `apps/daemon` and `apps/dashboard` intact. It stages the compiled daemon, a local static dashboard export, a bundled Node runtime, and a native onboarding shell into a Tauri app. `desktop:prepare` cleans `apps/daemon/dist` before building, so desktop staging is always a full daemon rebuild. `desktop:smoke` boots the wrapper on isolated ports with a temp HOME and verifies the staged daemon accepts an authenticated REST call and a WebSocket connection, not just the launcher static server. `desktop:dev` starts the Vite dev server itself via Tauri's `beforeDevCommand`; do not run Vite manually first, or the strict-port 1420 conflict aborts `tauri dev`. Use `npm run desktop:build` to produce a DMG-capable desktop build once Rust and macOS signing prerequisites are installed.

On first launch the desktop app compiles `~/send-return` automatically when the Xcode Command Line Tools are present (and shows an in-app note plus a log warning when they are not), so desktop users do not need to run `setup.sh` for it. The launcher's `/bootstrap` page on `127.0.0.1:3310` never discloses the admin token to unauthenticated callers: it requires the per-launch secret minted by the app shell (or an explicit `?token=`) and returns 403 otherwise. Its `/health` endpoint includes a `sendReturnReady` field.

Builder prerequisites for the desktop path:
- Rust toolchain (`rustup`)
- Xcode Command Line Tools
- Apple Developer signing + notarization secrets if you want signed public DMGs from GitHub Actions

GitHub draft releases are created only from `desktop-v*` tags. Running the release workflow via `workflow_dispatch` performs a verification build with no release.

## What It Does

The system solves four problems at once:

**1. Visual layer.** A stoplight dashboard that mirrors your terminal layout. Tiles stacked vertically, top to bottom, matching where your terminals sit on screen. Color tells you the state at a glance. Spatial memory replaces terminal names. You catch problems by looking, not reading.

**2. Intuitive handoffs.** One agent finishes, you tap the next tile and describe what to do with its output. Hive delivers the message. For planned sequences, a task queue carries context forward automatically, passing a summary of what the previous agent did and which files it changed.

**3. Multi-model coordination.** Run Claude, Codex, and OpenClaw in the same grid. Each model does what it is best at. Claude reasons about architecture. Codex moves fast through surgical edits. Different models audit each other's blind spots. You conduct them like instruments in the same symphony.

**4. Multi-machine network.** Connect multiple computers to one dashboard. A second Mac appears in the same tile stack within seconds. Each machine reports its capabilities. Route work to the right hardware. Every computer you own feeds into one control plane.

## Features

- **Stoplight dashboard** -green/red/yellow at a glance. Open on your phone, tablet, or second monitor. Supports 1-8 agents per machine.
- **Multi-model** -Claude, Codex, OpenClaw side by side. Spawn any from the dashboard. Add custom agents via `~/.hive/agents.json`.
- **Multi-machine** -connect additional Macs, Windows PCs, or Linux machines as satellites. Agents from all machines appear in one dashboard. Messages, tasks, and coordination route transparently across the network.
- **Auto-discovery** -start any supported agent in a terminal and it appears on the dashboard within 3 seconds. No registration, no config.
- **Spawn approval gate** -every new agent requires a dashboard "Approve" click before receiving its task. You see what is about to start and you control when it begins.
- **Auto-pilot** -permission prompts auto-approve after a 3-second grace window. Genuine permission prompts and questions surface as a yellow card for the human, with quick-reply buttons on the tile so you can answer before auto-pilot does.
- **Auto-update cascade** -when code is pushed, the primary rebuilds and all satellites auto-pull, validate (npm install + typecheck), and restart. A failed update rolls back to the pre-pull commit; repeated failures back off exponentially. Fleet stays in sync without manual intervention.
- **Pipeline health check** -`GET /api/check` verifies the entire fleet: daemon, build, auth, discovery, workers, hooks, status accuracy, satellite versions. One call, pass or fail. This is the supported health surface (the dashboard has no health button).
- **Messaging** -tap any tile, type a message, it goes straight to that agent's terminal. Messages queue if the agent is busy.
- **Coordination** -file locks, conflict detection, task queue, scratchpad. Multiple agents on the same codebase without collisions.
- **Workflow handoff** -tag related tasks with a workflow ID. When step 1 finishes, step 2 receives the git diff, verbatim agent output, and a structured JSON context block. Git state is verified before each handoff to prevent stale-code drift. Warnings flag uncommitted files or merge conflicts before the next step starts.
- **Model-aware routing** -tasks can target a specific model (`"model":"codex"`), require machine capabilities (`"requires":["gpu"]`), or prefer a specific machine.
- **Capability detection** -each machine auto-reports CPU, RAM, GPU, installed software. Custom tags via `~/.hive/capabilities.json`.
- **Compound learning** -every solved problem gets written to a per-project knowledge file. Agents search learnings by keyword (`/api/learnings?q=keyword`) instead of reading everything, scaling to hundreds of entries without wasting context.
- **State persistence** -daemon snapshots every 30 seconds. Survives restarts. Satellites run as launchd services and survive sleep and reboot.
- **Push notifications** -macOS native alerts when agents get stuck. Web Push to your phone when agents finish. PWA installable on iOS and Android.
- **Review queue** -auto-detects git pushes, deploys, and PRs across all agents. Slide-out drawer on the dashboard.
- **Device protocol** -plug any physical device into the network. Cameras, sensors, actuators, compute nodes. Register with one HTTP call, push data, receive events. Agents process device data the same way they process code tasks.

## Using the Tiles

**Assign tasks by complexity, not by file.** Give your hardest task to the top tile so you can keep an eye on it. Put your most independent tasks in the lower tiles where they can run unattended longest.

**Bridge context between agents.** When one agent discovers something another needs, tap the other tile and paste the finding. Or use the scratchpad so any agent can read it.

**Give commands to specific agents.** Tap any tile and type a plain English instruction: "Stop what you are doing and fix the login bug first" or "Read what the agent above just committed and review it." The message goes straight to that agent's terminal as if you typed it there.

## How It Works

### Auto-Discovery
Detects Claude, Codex, and OpenClaw processes within 3 seconds via `ps` + `lsof`. No configuration needed. Start `claude`, `codex`, or `openclaw tui` in any terminal and the daemon finds it. Supports up to 8 agents simultaneously. The daemon reads the vertical position of each Terminal window on your screen every few seconds (a 1.5-second throttle inside the 3-second tick) and assigns slots to match. Move a terminal higher on screen, it moves up in the dashboard stack. Tab titles update automatically to show which slot each terminal is. On Windows, position tracking works for separate-window (cmd.exe) installs; with Windows Terminal tabs, only the first agent per window reports a position. Windows agents whose working directory cannot be derived are attributed to your home directory, never to the Node install directory.

### Status Tracking
Multi-layer detection pipeline determines real-time status:
1. **Hook events** -Claude Code hooks report every tool call to the daemon (Claude agents)
2. **JSONL analysis** -reads the agent's conversation log for recent activity, extracts the last user message as a direction summary (Claude and Codex)
3. **CPU signal** -falls back to CPU usage (>8% = working) when hooks are delayed (all agents)
4. **PTY output** -detects terminal output flow for agents actively generating text

Tile labels classify common commands: `tsc --noEmit` runs show as "Type-checking" rather than "Building project".

### Control Modes
Hive controls agents through two deliberate paths:

1. **Discovered terminal mode** -you launch `claude`, `codex`, or `openclaw` yourself in Terminal.app, Hive discovers the session, and the daemon routes input back into that existing tab through TTY-targeted macOS automation. This is the zero-config compatibility path.
2. **Managed worker mode** -when Hive owns the worker lifecycle directly, the daemon can talk over stdin/stdout instead of driving a live Terminal tab. This path is cleaner and more testable, and it is where the architecture is headed over time.

Both paths feed the same queue, locks, scratchpad, workflow handoffs, and dashboard state. The Terminal automation layer exists because Hive works with real pre-existing terminal sessions, not because the daemon lacks a cleaner control model.

### Auto-Pilot
Auto-approves permission prompts so agents never sit idle waiting for you. The daemon detects when an agent is stuck on a prompt, waits a 3-second grace window (so you can override from the dashboard), then sends a Return keystroke via the `send-return` binary. While the agent is stuck, the tile goes yellow and shows quick-reply buttons, so genuine questions reach the human and you can answer before auto-pilot does.

This is how you run agents unattended. You give them tasks and walk away. Auto-pilot keeps them moving.

### Coordination
Multiple agents can safely work on the same codebase:
- **Peer awareness** -Claude agents get a one-line summary of what the other agents are doing via the identity hook, including status, project, current action, machine label, and project path. Codex workers still share the same fleet state through the dashboard, scratchpad, and REST API.
- **File locks** -acquire advisory locks before editing shared files (`POST /api/locks`)
- **Conflict detection** -check if another agent recently modified a file (`GET /api/conflicts`)
- **Scratchpad** -leave ephemeral notes for other agents (`POST /api/scratchpad`), auto-expires in 1 hour
- **Inter-agent messaging** -send a prompt to any other agent (`POST /api/message`)
- **Task queue** -push tasks to a global queue, auto-dispatched to the next idle agent (`POST /api/queue`)
- **Workflow handoff** -tag tasks with the same `workflowId` and the daemon passes completion context automatically. When Agent 1 finishes step 1, the daemon builds a summary of what it did (files created, files edited) and prepends it to step 2 before dispatching to the next agent. Queue it like this:

```bash
# Step 1: Build the API
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Build API endpoints for users","project":"/path/to/project","workflowId":"feature-auth"}' \
  http://localhost:3001/api/queue

# Step 2: Build the UI (waits for step 1)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Build UI against the API","project":"/path/to/project","workflowId":"feature-auth","blockedBy":"STEP1_ID"}' \
  http://localhost:3001/api/queue
```

Agent 2 receives: "Previous step completed by Q3: created src/api/users.ts, created src/api/auth.ts. Your task: Build UI against the API."

### Compound Learning
Every solved problem gets written to a per-project knowledge file (`.claude/hive-learnings.md`). The next agent that works on that project reads it before starting. Every debugging session, every style correction, every architectural decision compounds. After months of running, the system knows things about your projects that no fresh agent could replicate.

### State Persistence
The daemon writes `~/.hive/daemon-state.json` every 30 seconds and on shutdown. If the daemon restarts, it rehydrates workers (including each worker's model), message queues, locks, and workflow handoffs from the snapshot (discarded if older than 10 minutes). The `quadrantAssignments` field in the snapshot is debug-only and never restored. Discovery reconciles actual processes within 3 seconds. You do not configure this. It just works.

### Session Routing (Restart Resilience)
When you open 4 terminals within seconds of each other, their session log files are created nearly simultaneously. The daemon needs to know which log file belongs to which terminal. It solves this with marker files for Claude and rollout-log matching for Codex:

1. Claude terminals write `~/.hive/sessions/{tty}` with their session ID on every prompt (via the `identity.sh` hook)
2. The daemon reads those marker files on startup and uses them as ground truth, while Codex workers are re-associated from their rollout JSONL files
3. Marker files persist across computer restarts, so Claude mappings are durable too

On a fresh computer restart, the old marker files are overwritten the moment you type your first prompt in each terminal. The daemon picks up the correct mapping within 3 seconds. This means routing is accurate after one prompt per terminal, which is invisible to you since you would be typing anyway.

### Push Notifications
Two channels, zero setup:

- **macOS desktop** -when an agent goes stuck (yellow), a native notification fires with the agent name, project, and what it needs. 60-second cooldown per agent.
- **Web Push (iOS/Android/desktop browser)** -when an agent finishes work (green to red), a push notification is sent to all subscribed devices. 15-second cooldown per agent. Completion pushes also fire for satellite agents dispatched via the REST API, task queue, outbox, or queued messages (dashboard chat sends to satellites do not trigger one yet). The dashboard is a PWA. Add it to your Home Screen, tap the bell icon in the header, and allow notifications. VAPID keys are auto-generated on first daemon start (`~/.hive/vapid.json`, mode 600). A corrupt `vapid.json` no longer crash-loops the daemon: keys regenerate automatically, or push is disabled for the run. Subscriptions persist across daemon restarts (`~/.hive/push-subs.json`, mode 600).

Configure at `~/.hive/notifications.json`. Set `pushOnComplete: false` to disable completion notifications. Defaults work out of the box.

## API Reference

All endpoints require the auth token from `~/.hive/token` via the `Authorization: Bearer <token>` header.

**Base URL:** `http://localhost:3001`

### Workers
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workers` | List all agents with status, TTY, project, current action |
| `GET` | `/api/context` | Context snapshots for agents. `?workerId=X` for one (relayed to satellites), `?workerIds=a,b` for several, `?history=1&historyLimit=6` to include recent conversation turns (limit clamped 1-12). |

### Messaging
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/api/message` | `{workerId, content}` | Send a prompt to any agent. Queued if busy, returns message ID. |
| `GET` | `/api/message-queue` | | View queued messages with IDs, previews, and timestamps |
| `DELETE` | `/api/message-queue/:id` | | Cancel a queued message before it's delivered |

### Cross-Machine Control
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/api/exec` | `{command, cwd?, machine?, timeoutMs?}` | Run an audited shell command on the local machine or any connected satellite. Non-zero exit codes come back in the JSON response. |
| `POST` | `/api/spawn` | `{project?, model?, task?, targetQuadrant?, machine?}` | Spawn an agent on the local machine or a connected satellite. |
| `POST` | `/api/kill` | `{workerId}` | Kill a local or remote worker. |
| `POST` | `/api/satellites/repair` | `{machine, action?}` | Ask a connected satellite to `update`, `repair`, or `reinstall` itself. |
| `POST` | `/api/update-satellites` | | Tell all connected satellites to pull, validate, and restart (admin only). |
| `POST` | `/api/rearrange` | | Force a terminal window rearrange on the primary (admin only). |
| `GET` | `/api/models` | | List spawnable agent models (built-in plus custom agents from `~/.hive/agents.json`). |
| `GET` | `/api/projects` | | List projects merged across all machines. |
| `GET` | `/api/capabilities` | | List auto-detected machine capabilities and per-machine project paths. |
| `GET` | `/api/control-plane-audit` | `?limit=100` (optional) | Read the append-only control-plane audit log for exec, spawn, kill, and maintenance actions. |

### Task Queue
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/api/queue` | | View all queued tasks |
| `POST` | `/api/queue` | `{task, project?, priority?, blockedBy?, workflowId?, requires?, preferMachine?, model?}` | Push a task. Auto-dispatched to next idle agent. Add `workflowId` to link related tasks for automatic handoff. Add `requires` for capability routing (see below). Add `model` to target a specific agent type. Returns 400 for an invalid `task`, `project`, `model`, `preferMachine`, `blockedBy`, or `workflowId`, matching the spawn/exec validation. |
| `DELETE` | `/api/queue/:id` | | Remove a queued task |

**Capability routing:** Tasks can target specific machines or agent types:

```bash
# Only dispatch to machines with GPU and ffmpeg
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Render the video","requires":["gpu","ffmpeg"]}' \
  http://localhost:3001/api/queue

# Prefer a specific machine, fall back to any capable one
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Train the model","requires":["pytorch","gpu"],"preferMachine":"desktop-gpu"}' \
  http://localhost:3001/api/queue

# Only dispatch to Codex agents
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Review this PR","model":"codex"}' \
  http://localhost:3001/api/queue
```

| Field | Type | Description |
|-------|------|-------------|
| `requires` | `string[]` | Capability keys the machine must have. Matches auto-detected capabilities (gpu, ffmpeg, docker, python, pytorch, tensorflow) and custom tags from `~/.hive/capabilities.json`. Task waits in queue until a capable machine has an idle agent. |
| `preferMachine` | `string` | Machine ID to prefer. If that machine has an idle agent, it gets the task. Otherwise falls back to any capable machine. Use `"local"` for the primary. |
| `model` | `string` | Agent model to target (e.g. `"claude"`, `"codex"`, `"openclaw"`). Task only dispatches to agents running that model. |

Satellites auto-detect their capabilities on startup and report them to the primary. Add custom tags by creating `~/.hive/capabilities.json`:

```json
{ "tags": ["vpn", "prod-access", "large-disk"] }
```

### File Coordination
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `GET` | `/api/locks` | | List all active file locks |
| `POST` | `/api/locks` | `{workerId, path}` | Acquire lock. Returns 409 if already locked. |
| `DELETE` | `/api/locks` | `?workerId=X&path=Y` | Release lock (omit path to release all) |
| `GET` | `/api/conflicts` | `?path=X&excludeWorker=Y` | Check if another agent recently modified a file |

### Scratchpad
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `GET` | `/api/scratchpad` | `?key=X` (optional) | Read notes. Omit key for all entries. |
| `POST` | `/api/scratchpad` | `{key, value, setBy}` | Set a shared note. Auto-expires in 1 hour. |
| `DELETE` | `/api/scratchpad` | `?key=X` | Remove a note |

### Learning & Artifacts
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/api/learning` | `{project, lesson}` | Persist a lesson to the project's learning file. `project` must be an absolute path, a `~/` path, or a project name known to project discovery; unknown relative names return 400. |
| `GET` | `/api/learnings` | `?q=keyword&project=X&limit=5` | Search learnings by keyword across projects. Omit `q` for the latest entries. `limit` is clamped 1-20. |
| `GET` | `/api/artifacts` | `?workerId=X` (optional) | Recent file changes by an agent |

### Review Queue
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `GET` | `/api/reviews` | `?unseen=1` (optional) | List review items. Add `?unseen=1` for unread only. |
| `POST` | `/api/reviews` | `{summary, url?, type?, workerId?}` | Report a reviewable change. Type: deploy/commit/pr/push/review-needed/general. |
| `PATCH` | `/api/reviews/:id` | `{action: "seen"}` | Mark a review as seen |
| `PATCH` | `/api/reviews` | | Mark all reviews as seen |
| `DELETE` | `/api/reviews/:id` | | Dismiss a review |

The daemon also auto-detects `git push`, `gh pr create`, and Vercel deploys from hook events and creates review items automatically. Agents can self-report with richer summaries via the POST endpoint.

### Users (Multiplayer)
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/api/users` | | List all users, no tokens in the response (admin only) |
| `POST` | `/api/users` | `{name, role}` | Create a user, returns their token. Roles: `admin`, `operator`, `viewer`, `voice` (admin only) |
| `DELETE` | `/api/users/:id` | | Remove a user (admin only) |

### Reverts
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/api/reverts` | | List revert history entries (commits eligible for rollback) |
| `POST` | `/api/revert` | `{id, confirmation}` | Roll a project back to a recorded commit (admin only). `confirmation` must be the exact commit hash; refuses if the working tree is dirty. |

### Replays
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/api/replays` | `{name?}` | Start recording a session replay (admin only) |
| `POST` | `/api/replays/:id/stop` | | Stop a recording (admin only) |
| `GET` | `/api/replays` | | List recordings, including ones from before the last daemon restart (names from prior runs are reconstructed as "Replay \<ISO timestamp\>"; original custom names are not recovered) |
| `GET` | `/api/replays/:id` | | Download a recording as JSONL |

### Diagnostics
| Method | Endpoint | Query | Description |
|--------|----------|-------|-------------|
| `GET` | `/api/health` | | Daemon health snapshot |
| `GET` | `/api/check` | | Full pipeline verification across the fleet: daemon, auth, discovery, workers, hooks, satellite versions |
| `GET` | `/api/audit` | `?tty=X` (optional) | Status change audit log |
| `GET` | `/api/signals` | `?workerId=X` (optional) | Raw signal data (hooks, CPU, JSONL) |
| `GET` | `/api/debug` | | Full daemon state dump |
| `GET` | `/api/notifications/config` | | Read the notification config (`~/.hive/notifications.json` or defaults) |
| `GET` | `/api/collector/*` | | Collector telemetry: `events`, `conflicts`, `complications`, `score`, `summary`. Collector JSONL files rotate at 10MB (one `.1` generation kept); reads are capped at the last 2MB and summary counts cover the current file only. |

### Example: Send a task to an idle agent

```bash
TOKEN=$(cat ~/.hive/token)

# Check who's available
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/workers | jq '.[] | {id, tty, status}'

# Send a message to a specific agent
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"WORKER_ID","content":"Fix the login bug in src/auth.ts"}' \
  http://localhost:3001/api/message

# Queue a task for the next idle agent
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"Write tests for the payment module","project":"/path/to/project"}' \
  http://localhost:3001/api/queue
```

### Devices
Any device that can make an HTTP request can join the Hive network. Cameras, temperature sensors, Raspberry Pis, old phones, USB webcams, smart plugs. The protocol is the same for all of them: register, push data, receive events.

```bash
TOKEN=$(cat ~/.hive/token)

# Register a device
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"pi-basement-temp","type":"sensor","capabilities":["temperature","humidity"],"location":"basement"}' \
  http://localhost:3001/api/devices/register

# Push sensor data
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"pi-basement-temp","type":"metric","payload":{"temperature":72.1,"humidity":45}}' \
  http://localhost:3001/api/devices/data

# Push a camera frame (base64 JPEG)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"moto-window","type":"image","payload":{"base64":"'$(base64 -i frame.jpg)'"}}' \
  http://localhost:3001/api/devices/data

# List devices
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/devices

# Get events for a device
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/devices/pi-basement-temp/events
```

Device types: `camera`, `sensor`, `compute`, `actuator`. Data types: `image`, `metric`, `event`, `audio`. The daemon stores raw data to `~/hive-data/devices/`, runs change detection on camera frames, logs events to JSONL, and can bridge significant events into the task queue for agent analysis. Devices push to all connected dashboards over WebSocket in real-time.

Camera devices support hitboxes: named regions in the frame with priority levels. Configure them via `POST /api/devices/:id/hitboxes` so agents only spend tokens analyzing zones that actually changed.

## How Agents Use Hive

Claude agents read instructions from `~/.claude/CLAUDE.md` that tell them how to interact with the daemon. Here's what that hook-driven path does automatically:

1. **Identify themselves** -read `~/.hive/workers.json` on startup to find their slot. On every prompt, the identity hook also injects a peer summary showing what the other agents are doing, where they are running, and which project path they have open.
2. **Check learnings** -read `.claude/hive-learnings.md` before starting any task
3. **Lock files** -acquire locks before editing files other agents might touch
4. **Write learnings** -persist lessons after solving non-obvious problems
5. **Dispatch work** -send tasks to other agents when the work involves a different project or needs a fresh perspective
6. **Use scratchpad** -leave notes about in-progress work for other agents

These behaviors are configured through the CLAUDE.md instructions, not hardcoded. Codex workers still participate in discovery, messaging, queueing, and shared state, but they do not use the Claude hook path.

## Custom Agents

Hive ships with Claude, Codex, and OpenClaw support built in. To add any other terminal agent, create `~/.hive/agents.json`:

```json
[
  {
    "id": "aider",
    "label": "Aider",
    "processPattern": "aider",
    "spawnCommand": "aider",
    "sessionDir": "~/.aider/sessions/"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier (used internally) |
| `label` | yes | Display name on dashboard |
| `processPattern` | yes | Regex to match the process in `ps` output |
| `spawnCommand` | yes | CLI command to run in Terminal.app |
| `sessionDir` | no | Directory to scan for JSONL session files |

The daemon watches this file and reloads when it changes. No restart needed.

**The easiest way to add a new agent:** Ask one of your running agents. Tell Claude or Codex "add Aider support to Hive" and it writes the config entry to `~/.hive/agents.json`. The daemon picks it up on the next scan.

## Configuration

### Environment Variables

Nothing loads a root `.env` file. The daemon and scripts read these from the process environment (your shell, a launchd/systemd service definition, or the command line). See `.env.example` for the full annotated list.

| Variable | Default | Description |
|----------|---------|-------------|
| `SEND_RETURN_BIN` | `~/send-return` | Path to the CGEvent binary for auto-pilot and dashboard message delivery |
| `HIVE_HOME` | `$HOME` | Overrides HOME for `~/.hive` resolution (used by tests and the control-plane audit log) |
| `ANTHROPIC_API_KEY` | unset | Enables AI suggestions (or put the key in `~/.hive/anthropic-key`) |
| `HIVE_DAEMON_URL` | `http://localhost:3001` | Daemon endpoint baked into Claude hooks by `setup-hooks.sh` |
| `HIVE_AUTO_APPROVE` | unset | `1` installs the machine-wide auto-approve hook, `0` skips/removes it |
| `HIVE_PRIMARY_URL` / `HIVE_PRIMARY_TOKEN` | unset | Non-interactive satellite connect for `install.sh` |
| `NEXT_PUBLIC_WS_URL` | unset | WebSocket URL baked into the dashboard at build time (`deploy-vercel.sh` sets it from the tunnel URL). Static/desktop builds work without it: served from localhost or Tauri, the dashboard resolves `ws://127.0.0.1:3002` at runtime. |
| `HIVE_CLEAR_REPO_HOMEPAGE` | unset | Maintainer-only: `1` lets `deploy-vercel.sh` clear the GitHub repo homepage on the origin remote |

### Claude Code Hooks

If Claude Code is installed, setup installs or updates these hooks in `~/.claude/settings.json`:
- **UserPromptSubmit** -registers the TTY/session mapping and injects identity + peer summary
- **PreToolUse** -fires before every tool call, reports tool name to daemon
- **PostToolUse** -fires after every tool call, reports result
- **Notification** -fires on agent notifications (errors, completions)
- **Stop** -fires when an agent session ends

`bash setup-hooks.sh` is idempotent. It merges Hive hooks into existing settings instead of replacing them.

### Authentication

Setup generates a random token at `~/.hive/token`. All API requests require this token. The daemon reads it on startup. Agents read it via their hook commands.

## Architecture

```
Daemon (Node.js, port 3001 + 3002)
├── Discovery     -finds Claude + Codex + OpenClaw processes via ps + lsof every 3s
├── Telemetry     -receives hook events and inferred signals, maintains worker state
├── Auto-pilot    -detects stuck prompts, auto-approves via send-return
├── Arrange       -detects terminal positions, assigns slots by screen location
├── State store   -snapshots daemon state every 30s, restores on restart
├── Notifications -macOS native alerts when agents go stuck
├── Task queue    -global work queue, auto-dispatches to idle agents
├── Coordination  -file locks, scratchpad, conflict detection, learnings
├── API routes    -REST endpoints for all coordination features
└── WebSocket     -pushes live state to dashboard every 3 seconds

Dashboard (Next.js, port 3000 -installable as PWA)
├── Vertical stack -stoplight status cards matching terminal layout top to bottom
├── Live chat     -stream each agent's conversation history
├── Review queue  -slide-out drawer of recent pushes, deploys, and PRs
├── Controls      -send messages, spawn agents, view queue
└── Service worker -offline caching, instant repeat loads
```

### Key Files

| File | Purpose |
|------|---------|
| `apps/daemon/src/index.ts` | Entry point, initializes all systems |
| `apps/daemon/src/discovery.ts` | Process discovery and status detection |
| `apps/daemon/src/telemetry.ts` | Hook event receiver, worker state machine |
| `apps/daemon/src/auto-pilot.ts` | Automatic prompt approval |
| `apps/daemon/src/tty-input.ts` | AppleScript + CGEvent terminal interaction |
| `apps/daemon/src/arrange-windows.ts` | Window position detection and slot assignment |
| `apps/daemon/src/api-routes.ts` | All REST API endpoints |
| `apps/daemon/src/ws-server.ts` | WebSocket server for dashboard |
| `apps/daemon/src/state-store.ts` | Snapshot persistence across restarts |
| `~/.hive/identity.sh` | Claude hook: injects slot ID + peer summary on every prompt |
| `~/.hive/sessions/` | Claude TTY→session marker files written by `identity.sh` |
| `~/.hive/machine-id` | Persistent machine identity (hostname + 4-char random suffix, generated once) |
| `~/.hive/update-state.json` | Satellite auto-update backoff state (delete to force an immediate retry) |
| `~/.hive/primary-urls-history.txt` | Every primary URL a satellite has learned (last 20) |
| `~/.hive/logs/satellite.*.log` | Satellite stdout/stderr logs |
| `apps/daemon/src/notifications.ts` | macOS push notifications on stuck |
| `apps/daemon/src/task-queue.ts` | Global task queue |
| `apps/daemon/src/lock-manager.ts` | File lock coordination |
| `apps/daemon/src/review-store.ts` | Review queue for tracking reviewable changes |
| `apps/daemon/src/scratchpad.ts` | Ephemeral shared notes |
| `apps/daemon/src/session-stream.ts` | Chat history streaming from JSONL |
| `tools/send-return.swift` | CGEvent binary source (Return keystroke) |
| `packages/types/` | Shared TypeScript types |

## Troubleshooting

**Agents not showing up on dashboard**
- Make sure the daemon is running (`npm run dev:daemon`)
- If you're running Claude, check that hooks are configured: `cat ~/.claude/settings.json | grep hooks`
- If you're running Codex only, missing Claude hooks is expected
- The daemon discovers agents every 3 seconds. Wait a moment.

**Auto-pilot not working (agents stuck on prompts)**
- Grant Accessibility permission to `~/send-return` (see Setup section)
- Test it manually: `~/send-return` should send a Return keystroke to the frontmost app
- Check daemon logs for `[auto-pilot]` messages

**"Connection refused" errors**
- Daemon must be running on port 3001 before agents start
- Check nothing else is using port 3001: `lsof -i :3001`

**Dashboard shows stale data after restart**
- This is normal for the first few seconds. Send one prompt to each terminal and the routing self-corrects.
- Refresh the page. WebSocket reconnects automatically.
- Check that port 3002 is reachable: `curl http://localhost:3002`

**Chat history showing in the wrong terminal**
- The daemon may have mapped session files incorrectly. Send a prompt to each terminal and the marker files update automatically.
- Check marker files: `ls ~/.hive/sessions/` should show one file per active TTY
- Force re-mapping: restart the daemon (`npm run dev:daemon`)

**Hooks not reporting events**
- This applies to Claude Code only
- Verify hooks exist: `cat ~/.claude/settings.json | jq .hooks`
- Re-run `bash setup-hooks.sh` to repair or update the Hive hook entries.
- Test a hook manually: start `claude`, use any tool, check daemon logs for `[telemetry]` events.

**Build errors**
- Make sure you're on Node.js 20+: `node -v`
- Try `npm install` from the project root
- For TypeScript errors: `npx turbo build` to see full output

## Install as App

The dashboard is a PWA (Progressive Web App). After deploying, install it on your phone for the best experience:

**iPhone / iPad:**
1. Open the dashboard URL in Safari
2. Tap the share button (box with arrow)
3. Tap "Add to Home Screen"
4. Open from your home screen -full-screen, no browser chrome

**Android:**
1. Open the dashboard URL in Chrome
2. Tap the three-dot menu
3. Tap "Add to Home screen" or "Install app"

The app caches itself via service worker, so repeat opens are instant. It works like a native app -own icon, own entry in the app switcher, dark status bar matching the dashboard theme.

## Deploy Your Own Dashboard

For a hosted dashboard, use the current Hive architecture:

1. `npm start` to run the daemon and create a public tunnel for `ws://localhost:3002`
2. `npm run deploy:dashboard` to deploy `apps/dashboard` to your own Vercel account using that tunnel URL
3. Keep `npm start` running while you use the deployed dashboard

`npm run deploy:dashboard` reads the current tunnel URL from `~/.hive/tunnel-url.txt`, converts it to `wss://...`, and passes it to Vercel as `NEXT_PUBLIC_WS_URL` for that deployment.

Every clone is a completely independent instance. Setup generates a unique auth token at `~/.hive/token`. Your daemon, your agents, your dashboard, your data. Nothing connects to anyone else's setup. Two people can run Hive on the same network without any interference.

## Development

```bash
# Install dependencies
npm install

# Run daemon in dev mode (auto-restarts on changes)
npm run dev:daemon

# Run dashboard in dev mode
npm run dev:dashboard

# Build everything
npm run build

# Run tests
npm -w apps/daemon test
```

The project uses npm workspaces with Turbo for build orchestration. The daemon and dashboard are separate apps that share types via `packages/types/`.

## Background

Built by Rohit Mangtani. MBA in Business Analytics and BS in Computer Information Systems from Bentley University. Currently working in fixed income operations at RBC. Background in finance, data analysis, and quantitative systems.

This project came out of running multiple AI agents daily across several projects and needing a way to manage the coordination overhead. The system was built using the agents it manages: multiple Claude and Codex instances iterating on the daemon, dashboard, and each other's output simultaneously.

## Status

Active personal tool, used daily. Open to feedback and ideas from others working on multi-agent workflows.

## License

MIT
