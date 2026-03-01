import express from "express";
import { basename } from "path";
import type { Server } from "http";
import type { WorkerState, TelemetryEvent } from "./types.js";

const IDLE_THRESHOLD = 30_000; // 30 seconds without activity → idle
const STUCK_REPEAT_COUNT = 3;
const RECENT_TOOLS_LIMIT = 5;

export class TelemetryReceiver {
  private workers = new Map<string, WorkerState>();
  private recentTools = new Map<string, string[]>();
  private listeners: Array<(workerId: string, state: WorkerState) => void> = [];
  private server: Server | null = null;
  private port: number;

  // Hook support: session_id → worker_id
  private sessionToWorker = new Map<string, string>();
  // Track last hook event time per worker (to avoid CPU-based overrides)
  private lastHookTime = new Map<string, number>();

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    // Original telemetry endpoint (for managed workers)
    app.post("/telemetry", (req, res) => {
      const event = req.body as TelemetryEvent;

      if (!event.worker_id || !event.event) {
        res.status(400).json({ error: "Missing worker_id or event" });
        return;
      }

      this.handleEvent(event);
      res.json({ ok: true });
    });

    // Claude Code hook endpoint — receives live tool events
    app.post("/hook", (req, res) => {
      this.handleHook(req.body);
      res.json({ ok: true });
    });

    this.server = app.listen(this.port, () => {
      console.log(`  Telemetry receiver listening on port ${this.port}`);
    });
  }

  registerSession(sessionId: string, workerId: string): void {
    this.sessionToWorker.set(sessionId, workerId);
  }

  getLastHookTime(workerId: string): number | undefined {
    return this.lastHookTime.get(workerId);
  }

  registerWorker(
    id: string,
    pid: number,
    project: string,
    task: string | null
  ): WorkerState {
    const projectName = project.split("/").pop() || project;
    const now = Date.now();
    const worker: WorkerState = {
      id,
      pid,
      project,
      projectName,
      status: "waiting",
      currentAction: null,
      lastAction: "spawned",
      lastActionAt: now,
      errorCount: 0,
      startedAt: now,
      task,
      managed: true,
    };
    this.workers.set(id, worker);
    this.recentTools.set(id, []);
    this.notify(worker);
    return worker;
  }

  registerDiscovered(id: string, worker: WorkerState): void {
    this.workers.set(id, worker);
    this.notify(worker);
  }

  removeWorker(id: string): void {
    this.workers.delete(id);
    this.recentTools.delete(id);
    this.lastHookTime.delete(id);
    // Clean up session mappings pointing to this worker
    for (const [sid, wid] of this.sessionToWorker) {
      if (wid === id) this.sessionToWorker.delete(sid);
    }
  }

  get(id: string): WorkerState | undefined {
    return this.workers.get(id);
  }

  getAll(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  onUpdate(callback: (workerId: string, state: WorkerState) => void): void {
    this.listeners.push(callback);
  }

  tick(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (now - worker.lastActionAt > IDLE_THRESHOLD && worker.status === "waiting") {
        worker.status = "idle";
        worker.currentAction = null;
        this.notify(worker);
      }
    }
  }

  notifyExternal(worker: WorkerState): void {
    this.notify(worker);
  }

  // --- Hook handling ---

  private handleHook(body: Record<string, unknown>): void {
    const sessionId = body.session_id as string | undefined;
    const eventName = body.hook_event_name as string | undefined;
    const toolName = body.tool_name as string | undefined;
    const toolInput = body.tool_input as Record<string, unknown> | undefined;
    const cwd = body.cwd as string | undefined;

    if (!sessionId || !eventName) return;

    // Find the worker this hook belongs to
    let workerId = this.sessionToWorker.get(sessionId);

    // Fallback: match by cwd
    if (!workerId && cwd) {
      for (const w of this.workers.values()) {
        if (w.project === cwd || cwd.startsWith(w.project + "/")) {
          workerId = w.id;
          this.sessionToWorker.set(sessionId, workerId);
          break;
        }
      }
    }

    if (!workerId) return;
    const worker = this.workers.get(workerId);
    if (!worker) return;

    const now = Date.now();
    this.lastHookTime.set(workerId, now);
    worker.lastActionAt = now;

    // Update project from cwd if available (most accurate source)
    if (cwd) {
      const name = cwd.split("/").pop();
      if (name && name !== "rmgtni" && name !== "/") {
        worker.project = cwd;
        worker.projectName = name;
      }
    }

    switch (eventName) {
      case "PreToolUse": {
        worker.status = "working";
        const action = describeAction(toolName, toolInput);
        worker.currentAction = action;
        worker.lastAction = action;
        if (toolName) {
          this.trackTool(workerId, toolName);
        }
        break;
      }

      case "PostToolUse": {
        worker.lastAction = `Done: ${describeAction(toolName, toolInput)}`;
        worker.status = "working"; // still working until idle timeout
        worker.currentAction = null;
        if (this.isStuck(workerId)) {
          worker.status = "stuck";
        }
        break;
      }

      case "Notification": {
        // Claude Code is waiting for user input (permission prompt, question, etc.)
        const notifType = body.notification_type as string | undefined;
        worker.status = "stuck";
        if (notifType === "permission_prompt") {
          worker.currentAction = "Waiting for permission";
        } else if (notifType === "idle_prompt") {
          worker.currentAction = "Waiting for input";
        } else {
          worker.currentAction = "Needs your attention";
        }
        worker.lastAction = worker.currentAction;
        break;
      }

      case "Stop":
      case "SessionEnd": {
        worker.status = "idle";
        worker.currentAction = null;
        worker.lastAction = "Session ended";
        break;
      }

      case "SessionStart": {
        worker.status = "waiting";
        worker.currentAction = null;
        worker.lastAction = "Session started";
        break;
      }
    }

    this.notify(worker);
  }

  // --- Original telemetry event handling ---

  private handleEvent(event: TelemetryEvent): void {
    const worker = this.workers.get(event.worker_id);
    if (!worker) return;

    const now = event.timestamp || Date.now();
    worker.lastActionAt = now;

    switch (event.event) {
      case "SessionStart":
        worker.status = "waiting";
        worker.errorCount = 0;
        worker.lastAction = "session started";
        worker.currentAction = "initializing";
        break;

      case "PreToolUse":
        worker.status = "working";
        worker.currentAction = event.tool_name || "unknown tool";
        worker.lastAction = `using ${event.tool_name || "tool"}`;
        if (event.tool_name) {
          this.trackTool(event.worker_id, event.tool_name);
        }
        break;

      case "PostToolUse":
        worker.lastAction = `completed ${event.tool_name || "tool"}`;
        if (event.summary) {
          worker.lastAction = event.summary;
          if (event.summary.toLowerCase().includes("error")) {
            worker.errorCount++;
          }
        }
        if (this.isStuck(event.worker_id)) {
          worker.status = "stuck";
        }
        break;

      case "Stop":
        worker.status = "waiting";
        worker.currentAction = null;
        worker.lastAction = event.summary || "stopped";
        break;

      case "SubagentStart":
        worker.status = "working";
        worker.currentAction = "running subagent";
        worker.lastAction = "subagent started";
        break;

      case "SubagentStop":
        worker.lastAction = "subagent completed";
        break;
    }

    if (worker.errorCount > 2) {
      worker.status = "stuck";
    }

    this.notify(worker);
  }

  private trackTool(workerId: string, toolName: string): void {
    const tools = this.recentTools.get(workerId) || [];
    tools.push(toolName);
    if (tools.length > RECENT_TOOLS_LIMIT) {
      tools.shift();
    }
    this.recentTools.set(workerId, tools);
  }

  private isStuck(workerId: string): boolean {
    const tools = this.recentTools.get(workerId) || [];
    if (tools.length < STUCK_REPEAT_COUNT) return false;

    const last = tools[tools.length - 1];
    const recentSlice = tools.slice(-STUCK_REPEAT_COUNT);
    return recentSlice.every((t) => t === last);
  }

  private notify(worker: WorkerState): void {
    for (const listener of this.listeners) {
      listener(worker.id, worker);
    }
  }
}

/** Human-readable description of what a tool is doing */
function describeAction(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string {
  if (!toolName) return "Working";

  const filePath = toolInput?.file_path as string | undefined;
  const fileName = filePath ? basename(filePath) : undefined;

  switch (toolName) {
    case "Bash":
      return (toolInput?.description as string) ||
        truncate(toolInput?.command as string, 50) ||
        "Running command";
    case "Edit":
      return fileName ? `Editing ${fileName}` : "Editing file";
    case "Write":
      return fileName ? `Writing ${fileName}` : "Writing file";
    case "Read":
      return fileName ? `Reading ${fileName}` : "Reading file";
    case "Grep":
      return toolInput?.pattern
        ? `Searching "${truncate(toolInput.pattern as string, 25)}"`
        : "Searching code";
    case "Glob":
      return toolInput?.pattern
        ? `Finding ${truncate(toolInput.pattern as string, 30)}`
        : "Finding files";
    case "WebFetch":
      return "Fetching web page";
    case "WebSearch":
      return `Searching web`;
    case "Task":
      return "Running subagent";
    default:
      return toolName.replace(/^mcp__\w+__/, "");
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}
