# Hive

An operating system for directing AI labor. Daemon, dashboard, and coordination layer for running multiple Claude Code agents simultaneously on one machine.

## The Problem

AI labs are building smarter individual agents. Nobody is building infrastructure for managing fleets of them. One agent is a tool. Four agents editing the same codebase without coordination is chaos — duplicate work, file conflicts, idle time from unattended permission prompts.

This is the pre-Kubernetes moment for AI agents. Docker solved the single container. Someone has to solve orchestration.

## What Hive Does

Hive is a local daemon that auto-discovers running Claude Code instances, tracks their status in real-time, and provides coordination primitives so multiple agents can work the same machine without stepping on each other.

**Auto-discovery** — Detects running Claude processes within 3 seconds. Zero configuration.

**Status detection** — Three-layer pipeline reads session telemetry, JSONL logs, and process signals to determine whether each agent is working (green), idle (red), or stuck waiting for input (yellow).

**Auto-pilot** — Monitors for permission prompts and auto-approves routine operations within a grace window. Prevents agents from sitting idle waiting for a human to press Enter.

**Coordination** — Five primitives for multi-agent safety:
- Inter-agent messaging
- Advisory file locks
- Shared scratchpad (ephemeral, auto-expiring)
- Artifact tracking (which agent modified which files)
- Conflict detection (warns before editing a file another agent recently touched)

**Compound learning** — Persistent project-level knowledge files that accumulate across agents and sessions. Solved a tricky build issue? The next agent in that project reads the solution automatically.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Daemon (Node.js, launchd-managed)          │
│                                             │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
│  │ Discovery │  │ Telemetry │  │ AutoPilot│ │
│  └──────────┘  └───────────┘  └──────────┘ │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
│  │ ProcessMgr│  │ Watchdog  │  │ TTY Input│ │
│  └──────────┘  └───────────┘  └──────────┘ │
│                                             │
│  REST API (:3001)  ·  WebSocket (:3002)     │
└─────────────────────────────────────────────┘
         │                    │
    ┌────┴────┐          ┌───┴────┐
    │ Dashboard│          │ Agents │
    │ (Next.js)│          │ (1–N)  │
    └─────────┘          └────────┘
```

**Daemon** — TypeScript process running via macOS `launchd` with `KeepAlive`. Scans every 3 seconds. Exposes REST endpoints for task queues, locks, messaging, and learnings. WebSocket server pushes live state to the dashboard.

**Dashboard** — Next.js app showing agent status, live chat streams, and controls for spawning/killing agents. Accessible locally or via tunnel.

## Tech Stack

| Component | Stack |
|-----------|-------|
| Daemon | TypeScript, Express, WebSocket (`ws`) |
| Dashboard | Next.js 16, React 19, Tailwind CSS 4 |
| Build | Turborepo workspaces |
| Process management | macOS `launchd` + `caffeinate` |
| TTY interaction | `osascript` + CGEvent binary for reliable keystroke injection |

## Project Structure

```
apps/
  daemon/          # Discovery, telemetry, coordination, auto-pilot
    src/
      index.ts          # Entry point — wires all subsystems, runs 3s tick loop
      discovery.ts       # Auto-discovers Claude processes, reads session context
      telemetry.ts       # Receives hook events, maintains worker state
      auto-pilot.ts      # Detects stuck prompts, auto-approves
      tty-input.ts       # Sends keystrokes to agent terminals
      ws-server.ts       # WebSocket server + REST API endpoints
      process-mgr.ts     # Spawn/kill managed agent processes
      session-stream.ts  # Reads JSONL session logs for chat history
      watchdog.ts        # Monitors daemon health
      auth.ts            # Token generation and hook URL patching
  dashboard/       # Real-time monitoring UI
    src/
      app/page.tsx       # Main dashboard layout
      components/        # WorkerCard, SpawnDialog, chat panels
      lib/               # WebSocket client, types
```

## How It Was Built

Hive was built using the agents it manages. Four Claude Code instances iterated on the daemon and dashboard simultaneously while a human directed architecture and resolved conflicts. The coordination primitives exist because the development process demanded them.

## Related

- [Project page](https://www.rohitmangtani.com/lab/hive) — Full writeup with architecture diagrams
- [The Reference Point](https://www.rohitmangtani.com/lab/the-reference-point) — Context on how this fits into a broader portfolio of AI infrastructure work
