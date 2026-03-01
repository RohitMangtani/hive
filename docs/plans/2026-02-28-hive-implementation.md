# Hive Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a management dashboard + local daemon that orchestrates multiple Claude Code CLI instances with real-time telemetry and an AI orchestrator.

**Architecture:** Monorepo with two apps. `apps/daemon` is a Node.js process running locally — it spawns Claude Code CLI instances, receives hook telemetry over HTTP, exposes state via WebSocket. `apps/dashboard` is a Next.js app on Vercel — it connects to the daemon via WebSocket and renders worker cards, a chat panel, and an orchestrator bar.

**Tech Stack:** Node.js, TypeScript, ws, express, @anthropic-ai/claude-agent-sdk, Next.js App Router, Tailwind CSS, cloudflared

---

## Phase 1: Project Scaffolding

### Task 1: Initialize monorepo

**Files:**
- Create: `package.json`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`

**Step 1: Create workspace root package.json**

```json
{
  "name": "hive",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "dev:daemon": "npm -w apps/daemon run dev",
    "dev:dashboard": "npm -w apps/dashboard run dev",
    "build": "turbo build"
  }
}
```

**Step 2: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "outputs": [".next/**", "dist/**"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

**Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.next/
.env
.env.local
*.tsbuildinfo
```

**Step 5: Install turbo**

Run: `npm install turbo -D`

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: initialize hive monorepo"
```

---

### Task 2: Scaffold daemon app

**Files:**
- Create: `apps/daemon/package.json`
- Create: `apps/daemon/tsconfig.json`
- Create: `apps/daemon/src/index.ts`

**Step 1: Create apps/daemon directory and package.json**

```json
{
  "name": "@hive/daemon",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

**Step 2: Create apps/daemon/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create apps/daemon/src/index.ts (skeleton)**

```typescript
console.log("Hive daemon starting...");
```

**Step 4: Install daemon dependencies**

Run: `cd apps/daemon && npm install ws express && npm install -D tsx typescript @types/node @types/ws @types/express`

**Step 5: Verify it runs**

Run: `npm run dev:daemon`
Expected: Prints "Hive daemon starting..."

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold daemon app"
```

---

### Task 3: Scaffold dashboard app

**Files:**
- Create: `apps/dashboard/` (Next.js app)

**Step 1: Create Next.js app**

Run: `cd apps && npx create-next-app@latest dashboard --typescript --tailwind --app --src-dir --no-import-alias --no-eslint --no-turbopack`

**Step 2: Clean up defaults**

Remove default content from `apps/dashboard/src/app/page.tsx`. Replace with:

```tsx
export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0a0b] text-zinc-200 p-6">
      <h1 className="text-2xl font-semibold">Hive</h1>
      <p className="text-zinc-500 mt-2">No workers connected.</p>
    </main>
  );
}
```

**Step 3: Set dark theme in globals.css**

Replace globals.css with minimal dark theme:

```css
@import "tailwindcss";

@layer base {
  :root {
    --bg: #0a0a0b;
    --bg-card: #141415;
    --border: #262628;
    --text: #e4e4e7;
    --text-muted: #71717a;
    --accent: #3b82f6;
    --success: #22c55e;
    --warning: #f59e0b;
    --error: #ef4444;
  }

  body {
    background: var(--bg);
    color: var(--text);
  }
}
```

**Step 4: Verify it runs**

Run: `npm run dev:dashboard`
Expected: Dark page at localhost:3000 showing "Hive" heading

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold dashboard app"
```

---

## Phase 2: Daemon Core

### Task 4: Shared types

**Files:**
- Create: `apps/daemon/src/types.ts`

**Step 1: Define shared types**

```typescript
export interface WorkerState {
  id: string;
  pid: number;
  project: string;
  projectName: string;
  status: "working" | "waiting" | "stuck" | "idle";
  currentAction: string | null;
  lastAction: string;
  lastActionAt: number;
  errorCount: number;
  startedAt: number;
  task: string | null;
}

export interface TelemetryEvent {
  worker_id: string;
  session_id: string;
  event: "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" | "SubagentStart" | "SubagentStop";
  tool_name?: string;
  summary?: string;
  timestamp: number;
}

export interface DaemonMessage {
  type: "spawn" | "kill" | "message" | "list" | "orchestrator";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  token: string;
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "chat" | "orchestrator" | "error";
  workers?: WorkerState[];
  worker?: WorkerState;
  workerId?: string;
  content?: string;
  error?: string;
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add shared daemon types"
```

---

### Task 5: Telemetry receiver

**Files:**
- Create: `apps/daemon/src/telemetry.ts`

**Step 1: Build telemetry HTTP server**

```typescript
import express from "express";
import type { TelemetryEvent, WorkerState } from "./types.js";

const WORKING_THRESHOLD_MS = 30_000;
const IDLE_THRESHOLD_MS = 5 * 60_000;
const STUCK_ERROR_THRESHOLD = 2;

export class TelemetryReceiver {
  private app = express();
  private workers = new Map<string, WorkerState>();
  private recentTools = new Map<string, string[]>(); // workerId -> last N tool names
  private listeners: ((workerId: string, state: WorkerState) => void)[] = [];

  constructor(private port = 3001) {
    this.app.use(express.json());
    this.app.post("/telemetry", (req, res) => {
      const event = req.body as TelemetryEvent;
      this.handleEvent(event);
      res.json({ ok: true });
    });
    this.app.get("/health", (_req, res) => res.json({ ok: true }));
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`Telemetry receiver on :${this.port}`);
    });
  }

  registerWorker(id: string, pid: number, project: string, task: string | null) {
    const state: WorkerState = {
      id,
      pid,
      project,
      projectName: project.split("/").pop() || project,
      status: "waiting",
      currentAction: null,
      lastAction: "Started",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: Date.now(),
      task,
    };
    this.workers.set(id, state);
    this.recentTools.set(id, []);
    this.notify(id, state);
  }

  removeWorker(id: string) {
    this.workers.delete(id);
    this.recentTools.delete(id);
  }

  getAll(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  get(id: string): WorkerState | undefined {
    return this.workers.get(id);
  }

  onUpdate(fn: (workerId: string, state: WorkerState) => void) {
    this.listeners.push(fn);
  }

  private handleEvent(event: TelemetryEvent) {
    const worker = this.workers.get(event.worker_id);
    if (!worker) return;

    const now = Date.now();

    switch (event.event) {
      case "PreToolUse":
        worker.status = "working";
        worker.currentAction = event.summary || `Using ${event.tool_name}`;
        worker.lastActionAt = now;
        // Track for stuck detection
        const tools = this.recentTools.get(event.worker_id) || [];
        tools.push(event.tool_name || "");
        if (tools.length > 5) tools.shift();
        this.recentTools.set(event.worker_id, tools);
        // Stuck: same tool 3+ times in a row
        if (tools.length >= 3 && tools.slice(-3).every((t) => t === tools[tools.length - 1])) {
          worker.status = "stuck";
        }
        break;

      case "PostToolUse":
        worker.lastAction = event.summary || `${event.tool_name} completed`;
        worker.lastActionAt = now;
        if (event.summary?.toLowerCase().includes("error")) {
          worker.errorCount++;
          if (worker.errorCount > STUCK_ERROR_THRESHOLD) {
            worker.status = "stuck";
          }
        }
        break;

      case "Stop":
        worker.status = "waiting";
        worker.currentAction = null;
        worker.lastActionAt = now;
        break;

      case "SessionStart":
        worker.status = "waiting";
        worker.lastAction = "Session started";
        worker.lastActionAt = now;
        worker.errorCount = 0;
        break;
    }

    this.notify(event.worker_id, worker);
  }

  private notify(workerId: string, state: WorkerState) {
    for (const fn of this.listeners) {
      fn(workerId, state);
    }
  }

  // Called periodically to update idle status
  tick() {
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      if (worker.status === "waiting" && now - worker.lastActionAt > IDLE_THRESHOLD_MS) {
        worker.status = "idle";
        this.notify(id, worker);
      }
    }
  }
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add telemetry receiver with status derivation"
```

---

### Task 6: Process manager

**Files:**
- Create: `apps/daemon/src/process-mgr.ts`
- Create: `apps/daemon/src/hooks/telemetry-hook.sh`

**Step 1: Create the telemetry hook script**

This script is injected into each worker's project. It POSTs tool events to the daemon.

```bash
#!/bin/bash
# Hive telemetry hook — posts tool events to the local daemon
WORKER_ID="${HIVE_WORKER_ID}"
DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"

INPUT=$(cat)
EVENT_TYPE="${HIVE_HOOK_EVENT:-unknown}"

# Extract tool_name and build summary
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")

SUMMARY=""
if [ "$EVENT_TYPE" = "PostToolUse" ]; then
  SUMMARY=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
inp=d.get('tool_input',{})
name=d.get('tool_name','')
if name in ('Edit','Write'):
  print(f\"{name} {inp.get('file_path','')}\")
elif name == 'Bash':
  cmd=inp.get('command','')[:60]
  print(f'Ran: {cmd}')
else:
  print(f'{name}')
" 2>/dev/null || echo "$TOOL_NAME")
fi

# POST to daemon (fire and forget, don't block Claude)
curl -s -X POST "$DAEMON_URL/telemetry" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"session_id\": \"$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)\",
    \"event\": \"$EVENT_TYPE\",
    \"tool_name\": \"$TOOL_NAME\",
    \"summary\": \"$SUMMARY\",
    \"timestamp\": $(date +%s000)
  }" > /dev/null 2>&1 &

exit 0
```

**Step 2: Make hook executable**

Run: `chmod +x apps/daemon/src/hooks/telemetry-hook.sh`

**Step 3: Create process manager**

```typescript
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import type { TelemetryReceiver } from "./telemetry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(__dirname, "hooks/telemetry-hook.sh");
const IDLE_KILL_MS = 15 * 60_000; // 15 minutes

interface ManagedWorker {
  id: string;
  process: ChildProcess;
  project: string;
  stdin: NodeJS.WritableStream;
  outputBuffer: string[];
}

export class ProcessManager {
  private workers = new Map<string, ManagedWorker>();
  private onOutput: ((workerId: string, data: string) => void) | null = null;

  constructor(private telemetry: TelemetryReceiver) {}

  setOutputHandler(fn: (workerId: string, data: string) => void) {
    this.onOutput = fn;
  }

  spawn(project: string, task: string | null): string {
    const id = `w_${randomBytes(6).toString("hex")}`;

    // Inject hooks into project's .claude/settings.local.json
    this.injectHooks(project, id);

    // Spawn Claude Code CLI
    const proc = spawn("claude", [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-mode", "acceptEdits",
      "--no-session-persistence",
    ], {
      cwd: project,
      env: {
        ...process.env,
        HIVE_WORKER_ID: id,
        HIVE_DAEMON_URL: "http://localhost:3001",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const worker: ManagedWorker = {
      id,
      process: proc,
      project,
      stdin: proc.stdin!,
      outputBuffer: [],
    };

    // Capture stdout (stream-json output)
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      worker.outputBuffer.push(text);
      if (worker.outputBuffer.length > 200) worker.outputBuffer.shift();
      this.onOutput?.(id, text);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.onOutput?.(id, `[stderr] ${text}`);
    });

    proc.on("exit", (code) => {
      this.telemetry.removeWorker(id);
      this.workers.delete(id);
      this.cleanupHooks(project);
      this.onOutput?.(id, `[exited with code ${code}]`);
    });

    this.workers.set(id, worker);
    this.telemetry.registerWorker(id, proc.pid || 0, project, task);

    // Send initial task if provided
    if (task) {
      this.sendMessage(id, task);
    }

    return id;
  }

  sendMessage(workerId: string, message: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    const payload = JSON.stringify({ type: "user", content: message }) + "\n";
    worker.stdin.write(payload);
    return true;
  }

  kill(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.process.kill("SIGTERM");
    setTimeout(() => {
      if (!worker.process.killed) worker.process.kill("SIGKILL");
    }, 5000);
    return true;
  }

  getRecentOutput(workerId: string, lines = 50): string[] {
    const worker = this.workers.get(workerId);
    return worker?.outputBuffer.slice(-lines) || [];
  }

  listIds(): string[] {
    return Array.from(this.workers.keys());
  }

  // Kill idle workers
  tick() {
    const now = Date.now();
    for (const [id] of this.workers) {
      const state = this.telemetry.get(id);
      if (state?.status === "idle" && now - state.lastActionAt > IDLE_KILL_MS) {
        console.log(`Killing idle worker ${id} (${state.projectName})`);
        this.kill(id);
      }
    }
  }

  private injectHooks(project: string, workerId: string) {
    const claudeDir = resolve(project, ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

    const settingsPath = resolve(claudeDir, "settings.local.json");
    let settings: any = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(require("fs").readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }

    // Add hive telemetry hooks
    const hookCmd = `HIVE_HOOK_EVENT=__EVENT__ HIVE_WORKER_ID=${workerId} bash ${HOOK_SCRIPT}`;
    settings.hooks = settings.hooks || {};

    for (const event of ["PreToolUse", "PostToolUse", "Stop", "SessionStart"]) {
      const existing = settings.hooks[event] || [];
      // Don't add duplicate hive hooks
      if (!existing.some((h: any) => h.hooks?.[0]?.command?.includes("telemetry-hook"))) {
        existing.push({
          hooks: [{
            type: "command",
            command: hookCmd.replace("__EVENT__", event),
          }],
        });
      }
      settings.hooks[event] = existing;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  private cleanupHooks(project: string) {
    const settingsPath = resolve(project, ".claude", "settings.local.json");
    if (!existsSync(settingsPath)) return;
    try {
      const settings = JSON.parse(require("fs").readFileSync(settingsPath, "utf-8"));
      if (!settings.hooks) return;
      for (const event of Object.keys(settings.hooks)) {
        settings.hooks[event] = (settings.hooks[event] || []).filter(
          (h: any) => !h.hooks?.[0]?.command?.includes("telemetry-hook")
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch {
      // Best effort cleanup
    }
  }
}
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add process manager with hook injection"
```

---

### Task 7: WebSocket server

**Files:**
- Create: `apps/daemon/src/ws-server.ts`

**Step 1: Build WebSocket server**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { DaemonMessage, DaemonResponse } from "./types.js";

export class WsServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  public readonly authToken: string;

  constructor(
    private telemetry: TelemetryReceiver,
    private procMgr: ProcessManager,
    private port = 3002
  ) {
    this.authToken = randomBytes(24).toString("base64url");
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      // First message must be auth
      let authenticated = false;

      ws.on("message", (raw) => {
        try {
          const msg: DaemonMessage = JSON.parse(raw.toString());

          if (!authenticated) {
            if (msg.token === this.authToken) {
              authenticated = true;
              this.clients.add(ws);
              // Send current state
              this.send(ws, {
                type: "workers",
                workers: this.telemetry.getAll(),
              });
            } else {
              ws.close(4001, "Invalid token");
            }
            return;
          }

          this.handleMessage(ws, msg);
        } catch {
          this.send(ws, { type: "error", error: "Invalid message" });
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });

    // Forward telemetry updates to all connected dashboards
    this.telemetry.onUpdate((workerId, state) => {
      this.broadcast({ type: "worker_update", worker: state, workerId });
    });

    // Forward worker output to dashboards
    this.procMgr.setOutputHandler((workerId, data) => {
      this.broadcast({ type: "chat", workerId, content: data });
    });
  }

  start() {
    console.log(`WebSocket server on :${this.port}`);
    console.log(`\nAuth token: ${this.authToken}\n`);
  }

  private handleMessage(ws: WebSocket, msg: DaemonMessage) {
    switch (msg.type) {
      case "spawn": {
        if (!msg.project) {
          this.send(ws, { type: "error", error: "Missing project path" });
          return;
        }
        const id = this.procMgr.spawn(msg.project, msg.task || null);
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        break;
      }

      case "kill": {
        if (!msg.workerId) return;
        this.procMgr.kill(msg.workerId);
        break;
      }

      case "message": {
        if (!msg.workerId || !msg.content) return;
        this.procMgr.sendMessage(msg.workerId, msg.content);
        break;
      }

      case "list": {
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        break;
      }
    }
  }

  private send(ws: WebSocket, msg: DaemonResponse) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: DaemonResponse) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add WebSocket server with auth and message routing"
```

---

### Task 8: Wire up daemon entry point

**Files:**
- Modify: `apps/daemon/src/index.ts`

**Step 1: Wire everything together**

```typescript
import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { WsServer } from "./ws-server.js";

const telemetry = new TelemetryReceiver(3001);
const procMgr = new ProcessManager(telemetry);
const ws = new WsServer(telemetry, procMgr, 3002);

telemetry.start();
ws.start();

// Periodic status updates (idle detection, auto-kill)
setInterval(() => {
  telemetry.tick();
  procMgr.tick();
}, 10_000);

console.log("Hive daemon running.");
console.log("  Telemetry: http://localhost:3001");
console.log("  WebSocket: ws://localhost:3002");

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 2000);
});
```

**Step 2: Test daemon starts**

Run: `npm run dev:daemon`
Expected: Prints telemetry/ws ports and auth token. No errors.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire daemon entry point"
```

---

## Phase 3: Dashboard

### Task 9: WebSocket client hook

**Files:**
- Create: `apps/dashboard/src/lib/ws.ts`
- Create: `apps/dashboard/src/lib/types.ts`

**Step 1: Copy types to dashboard**

Create `apps/dashboard/src/lib/types.ts` with the same `WorkerState`, `DaemonMessage`, `DaemonResponse` interfaces from daemon types.ts.

**Step 2: Create useHive WebSocket hook**

```typescript
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { WorkerState, DaemonMessage, DaemonResponse } from "./types";

interface HiveState {
  connected: boolean;
  workers: Map<string, WorkerState>;
  chatMessages: Map<string, string[]>; // workerId -> messages
}

export function useHive(daemonUrl: string, token: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<HiveState>({
    connected: false,
    workers: new Map(),
    chatMessages: new Map(),
  });

  useEffect(() => {
    if (!daemonUrl || !token) return;

    const ws = new WebSocket(daemonUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Authenticate
      ws.send(JSON.stringify({ token, type: "list" }));
    };

    ws.onmessage = (event) => {
      const msg: DaemonResponse = JSON.parse(event.data);

      setState((prev) => {
        const next = { ...prev };

        switch (msg.type) {
          case "workers": {
            const map = new Map<string, WorkerState>();
            for (const w of msg.workers || []) map.set(w.id, w);
            next.workers = map;
            next.connected = true;
            break;
          }
          case "worker_update": {
            if (msg.worker && msg.workerId) {
              const map = new Map(prev.workers);
              map.set(msg.workerId, msg.worker);
              next.workers = map;
            }
            break;
          }
          case "chat": {
            if (msg.workerId && msg.content) {
              const map = new Map(prev.chatMessages);
              const msgs = [...(map.get(msg.workerId) || []), msg.content];
              if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
              map.set(msg.workerId, msgs);
              next.chatMessages = map;
            }
            break;
          }
        }

        return next;
      });
    };

    ws.onclose = () => {
      setState((prev) => ({ ...prev, connected: false }));
      // Reconnect after 5s
      setTimeout(() => {
        wsRef.current = null;
      }, 5000);
    };

    return () => {
      ws.close();
    };
  }, [daemonUrl, token]);

  const send = useCallback((msg: Omit<DaemonMessage, "token">) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...msg, token }));
    }
  }, [token]);

  return { ...state, send };
}
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add useHive WebSocket hook"
```

---

### Task 10: Worker card component

**Files:**
- Create: `apps/dashboard/src/components/WorkerCard.tsx`

**Step 1: Build WorkerCard**

```tsx
"use client";

import type { WorkerState } from "@/lib/types";

const STATUS_STYLES = {
  working: "bg-green-500/20 text-green-400 border-green-500/30",
  waiting: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  stuck: "bg-red-500/20 text-red-400 border-red-500/30",
  idle: "bg-zinc-500/20 text-zinc-500 border-zinc-500/30",
};

const STATUS_DOT = {
  working: "bg-green-400 animate-pulse",
  waiting: "bg-amber-400",
  stuck: "bg-red-400 animate-pulse",
  idle: "bg-zinc-600",
};

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function WorkerCard({
  worker,
  selected,
  onClick,
  onKill,
}: {
  worker: WorkerState;
  selected: boolean;
  onClick: () => void;
  onKill: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-4 transition-all ${
        selected
          ? "border-blue-500/50 bg-blue-500/5"
          : "border-[var(--border)] bg-[var(--bg-card)] hover:border-zinc-600"
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[worker.status]}`} />
          <span className="font-medium text-sm">{worker.projectName}</span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
            STATUS_STYLES[worker.status]
          }`}
        >
          {worker.status}
        </span>
      </div>

      {worker.task && (
        <p className="mt-2 text-xs text-zinc-400 line-clamp-2">{worker.task}</p>
      )}

      <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-600">
        <span>{worker.currentAction || worker.lastAction}</span>
        <span>{timeAgo(worker.startedAt)} active</span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="h-1 flex-1 rounded-full bg-zinc-800 mr-3">
          <div className="h-1 rounded-full bg-zinc-600" style={{ width: "0%" }} />
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors"
        >
          kill
        </button>
      </div>
    </button>
  );
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add WorkerCard component"
```

---

### Task 11: Chat panel component

**Files:**
- Create: `apps/dashboard/src/components/ChatPanel.tsx`

**Step 1: Build ChatPanel**

```tsx
"use client";

import { useState, useRef, useEffect } from "react";

export function ChatPanel({
  workerId,
  projectName,
  messages,
  onSend,
  onClose,
}: {
  workerId: string;
  projectName: string;
  messages: string[];
  onSend: (message: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
  }

  return (
    <div className="flex h-full flex-col border-l border-[var(--border)] bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">{projectName}</h3>
          <p className="text-[11px] text-zinc-600">{workerId}</p>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-sm">
          close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-xs text-zinc-400">
        {messages.map((msg, i) => (
          <pre key={i} className="whitespace-pre-wrap break-words">{msg}</pre>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--border)] p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message..."
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:border-blue-500/50 focus:outline-none"
        />
      </form>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add ChatPanel component"
```

---

### Task 12: Orchestrator bar component

**Files:**
- Create: `apps/dashboard/src/components/OrchestratorBar.tsx`

**Step 1: Build OrchestratorBar**

```tsx
"use client";

import { useState } from "react";

export function OrchestratorBar({
  onSend,
  connected,
}: {
  onSend: (message: string) => void;
  connected: boolean;
}) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
      <form onSubmit={handleSubmit} className="flex items-center gap-3">
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={connected ? "Talk to the orchestrator..." : "Daemon offline — retrying..."}
          disabled={!connected}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || !input.trim()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-30"
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add OrchestratorBar component"
```

---

### Task 13: Spawn dialog component

**Files:**
- Create: `apps/dashboard/src/components/SpawnDialog.tsx`

**Step 1: Build SpawnDialog**

```tsx
"use client";

import { useState } from "react";

const PROJECTS = [
  { name: "crawler", path: "~/factory/projects/crawler" },
  { name: "rmgtni-web", path: "~/factory/projects/rmgtni-web" },
  { name: "rohitmangtani-web", path: "~/factory/projects/rohitmangtani-web" },
  { name: "skillmap", path: "~/factory/projects/skillmap" },
  { name: "stotram", path: "~/factory/projects/stotram" },
  { name: "nudge", path: "~/factory/projects/nudge" },
  { name: "hive", path: "~/factory/projects/hive" },
];

export function SpawnDialog({
  onSpawn,
  onClose,
}: {
  onSpawn: (project: string, task: string | null) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [task, setTask] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <h2 className="text-lg font-semibold">New Worker</h2>
        <p className="mt-1 text-xs text-zinc-600">Pick a project and optionally assign a task.</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {PROJECTS.map((p) => (
            <button
              key={p.path}
              onClick={() => setSelected(p.path)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                selected === p.path
                  ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                  : "border-[var(--border)] text-zinc-400 hover:border-zinc-600"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Optional: describe the task..."
          rows={3}
          className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:border-blue-500/50 focus:outline-none"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (selected) {
                onSpawn(selected, task.trim() || null);
                onClose();
              }
            }}
            disabled={!selected}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-30"
          >
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: add SpawnDialog component"
```

---

### Task 14: Main page (wire everything together)

**Files:**
- Modify: `apps/dashboard/src/app/page.tsx`

**Step 1: Build the main page**

```tsx
"use client";

import { useState } from "react";
import { useHive } from "@/lib/ws";
import { WorkerCard } from "@/components/WorkerCard";
import { ChatPanel } from "@/components/ChatPanel";
import { OrchestratorBar } from "@/components/OrchestratorBar";
import { SpawnDialog } from "@/components/SpawnDialog";

export default function Home() {
  const [daemonUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("hive_daemon_url") || "ws://localhost:3002";
    }
    return "ws://localhost:3002";
  });
  const [token] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("hive_token") || "";
    }
    return "";
  });

  const { connected, workers, chatMessages, send } = useHive(daemonUrl, token);
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);
  const [showSpawn, setShowSpawn] = useState(false);
  const [showSetup, setShowSetup] = useState(!token);

  // Setup screen — enter daemon URL and token
  if (showSetup) {
    return <SetupScreen onSave={(url, t) => {
      localStorage.setItem("hive_daemon_url", url);
      localStorage.setItem("hive_token", t);
      window.location.reload();
    }} />;
  }

  const workerList = Array.from(workers.values());

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Hive</h1>
          <span className="text-xs text-zinc-600">{workerList.length} workers</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSpawn(true)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            + New Worker
          </button>
          <button
            onClick={() => setShowSetup(true)}
            className="text-xs text-zinc-600 hover:text-zinc-400"
          >
            settings
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Worker grid */}
        <div className={`flex-1 overflow-y-auto p-6 ${selectedWorker ? "max-w-[60%]" : ""}`}>
          {workerList.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-zinc-500">No workers running.</p>
                <button
                  onClick={() => setShowSpawn(true)}
                  className="mt-3 text-sm text-blue-400 hover:text-blue-300"
                >
                  Spawn one
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workerList.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  selected={selectedWorker === w.id}
                  onClick={() => setSelectedWorker(selectedWorker === w.id ? null : w.id)}
                  onKill={() => {
                    send({ type: "kill", workerId: w.id });
                    if (selectedWorker === w.id) setSelectedWorker(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Chat panel */}
        {selectedWorker && workers.has(selectedWorker) && (
          <div className="w-[40%] min-w-[320px]">
            <ChatPanel
              workerId={selectedWorker}
              projectName={workers.get(selectedWorker)!.projectName}
              messages={chatMessages.get(selectedWorker) || []}
              onSend={(msg) => send({ type: "message", workerId: selectedWorker, content: msg })}
              onClose={() => setSelectedWorker(null)}
            />
          </div>
        )}
      </div>

      {/* Orchestrator bar */}
      <OrchestratorBar
        connected={connected}
        onSend={(msg) => send({ type: "orchestrator", content: msg })}
      />

      {/* Spawn dialog */}
      {showSpawn && (
        <SpawnDialog
          onSpawn={(project, task) => send({ type: "spawn", project, task: task || undefined })}
          onClose={() => setShowSpawn(false)}
        />
      )}
    </div>
  );
}

function SetupScreen({ onSave }: { onSave: (url: string, token: string) => void }) {
  const [url, setUrl] = useState("ws://localhost:3002");
  const [token, setToken] = useState("");

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <h1 className="text-lg font-semibold">Connect to Hive Daemon</h1>
        <p className="text-xs text-zinc-600">
          Start the daemon locally, then paste the auth token it displays.
        </p>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://localhost:3002"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-zinc-200 focus:border-blue-500/50 focus:outline-none"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Auth token from daemon"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-zinc-200 focus:border-blue-500/50 focus:outline-none"
        />
        <button
          onClick={() => onSave(url, token)}
          disabled={!token}
          className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-30"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Verify dashboard builds**

Run: `cd apps/dashboard && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire main page with worker grid, chat, and orchestrator bar"
```

---

## Phase 4: Orchestrator (Agent SDK)

### Task 15: Orchestrator agent

**Files:**
- Modify: `apps/daemon/src/orchestrator.ts`

**Step 1: Install Agent SDK**

Run: `cd apps/daemon && npm install @anthropic-ai/claude-agent-sdk`

**Step 2: Build orchestrator module**

This task depends heavily on the exact Agent SDK API. The orchestrator is a Claude agent with custom tools for reading worker state and sending commands. The implementation should:

- Import and initialize an Agent from the SDK
- Define custom tools:
  - `list_workers` — returns current WorkerState[] from telemetry
  - `send_to_worker` — pipes a message to a worker's stdin
  - `spawn_worker` — creates a new Claude Code CLI instance
  - `kill_worker` — terminates a worker
- Accept user messages from the dashboard's orchestrator bar
- Stream responses back to the dashboard via WebSocket

Note: The exact SDK API should be verified against the latest docs at build time. Use `context7` MCP or the SDK README. The core pattern is:

```typescript
// Pseudocode — verify exact API at build time
import { Agent } from "@anthropic-ai/claude-agent-sdk";

const orchestrator = new Agent({
  name: "hive-orchestrator",
  systemPrompt: `You are Hive, an orchestrator managing multiple Claude Code workers.
You can see what each worker is doing, send them instructions, spawn new workers, and kill idle ones.
Help the user manage their development workflow across multiple projects.`,
  tools: [listWorkersTool, sendToWorkerTool, spawnWorkerTool, killWorkerTool],
  model: "haiku", // Fast, cheap for coordination tasks
});
```

**Step 3: Wire orchestrator messages into WsServer**

Add a handler for `type: "orchestrator"` messages in `ws-server.ts` that forwards to the orchestrator and streams responses back.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add orchestrator agent with worker management tools"
```

---

## Phase 5: Tunnel & Deploy

### Task 16: Tunnel setup script

**Files:**
- Create: `apps/daemon/scripts/start.sh`

**Step 1: Create start script**

```bash
#!/bin/bash
# Start Hive daemon + cloudflared tunnel

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "Installing cloudflared..."
  brew install cloudflared
fi

# Start daemon in background
echo "Starting Hive daemon..."
npm -w apps/daemon run dev &
DAEMON_PID=$!

# Wait for daemon to start
sleep 2

# Start tunnel
echo "Starting tunnel..."
cloudflared tunnel --url http://localhost:3002 &
TUNNEL_PID=$!

echo ""
echo "Hive is running."
echo "  Daemon PID: $DAEMON_PID"
echo "  Tunnel PID: $TUNNEL_PID"
echo ""
echo "Press Ctrl+C to stop."

trap "kill $DAEMON_PID $TUNNEL_PID 2>/dev/null; exit" INT
wait
```

**Step 2: Make executable**

Run: `chmod +x apps/daemon/scripts/start.sh`

**Step 3: Add to root package.json**

Add script: `"start": "bash apps/daemon/scripts/start.sh"`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add start script with cloudflared tunnel"
```

---

### Task 17: Deploy dashboard to Vercel

**Step 1: Push to GitHub**

Run: `gh repo create RohitMangtani/hive --public --source=. --push`

**Step 2: Deploy**

Run: `cd apps/dashboard && vercel --prod`

Configure:
- Root directory: `apps/dashboard`
- Framework: Next.js
- No env vars needed (everything is client-side, daemon URL comes from localStorage)

**Step 3: Commit any Vercel config changes**

```bash
git add -A
git commit -m "chore: deploy dashboard to Vercel"
```

---

### Task 18: End-to-end test

**Step 1: Start daemon**

Run: `npm start` (from repo root)
Expected: Daemon starts, prints auth token, tunnel URL appears

**Step 2: Open dashboard**

Open the Vercel URL or localhost:3000. Enter daemon URL and auth token.
Expected: Connected indicator turns green.

**Step 3: Spawn a worker**

Click "+ New Worker", select "crawler", no task.
Expected: Worker card appears with status "waiting".

**Step 4: Send a message to the worker**

Click the worker card, type "What files are in this project?" in the chat panel.
Expected: Worker processes the message, output streams into chat panel. Status changes to "working" then back to "waiting".

**Step 5: Test orchestrator**

Type in the orchestrator bar: "What workers are running?"
Expected: Orchestrator responds with the current worker list.

**Step 6: Kill the worker**

Click "kill" on the worker card.
Expected: Worker card disappears.

**Step 7: Commit final state**

```bash
git add -A
git commit -m "chore: end-to-end verification complete"
```

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| 1: Scaffolding | 1-3 | Monorepo with daemon + dashboard skeletons |
| 2: Daemon Core | 4-8 | Telemetry receiver, process manager, WebSocket server |
| 3: Dashboard | 9-14 | Worker grid, chat panel, orchestrator bar, spawn dialog |
| 4: Orchestrator | 15 | Agent SDK orchestrator with worker management tools |
| 5: Deploy | 16-18 | Tunnel, Vercel deploy, end-to-end test |
