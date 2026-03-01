import express from "express";
import type { Server } from "http";
import type { WorkerState, TelemetryEvent } from "./types.js";

const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
const WORKING_THRESHOLD = 30 * 1000; // 30 seconds
const STUCK_REPEAT_COUNT = 3;
const RECENT_TOOLS_LIMIT = 5;

export class TelemetryReceiver {
  private workers = new Map<string, WorkerState>();
  private recentTools = new Map<string, string[]>();
  private listeners: Array<(worker: WorkerState) => void> = [];
  private server: Server | null = null;
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    app.post("/telemetry", (req, res) => {
      const event = req.body as TelemetryEvent;

      if (!event.worker_id || !event.event) {
        res.status(400).json({ error: "Missing worker_id or event" });
        return;
      }

      this.handleEvent(event);
      res.json({ ok: true });
    });

    this.server = app.listen(this.port, () => {
      console.log(`  Telemetry receiver listening on port ${this.port}`);
    });
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
      status: "idle",
      currentAction: null,
      lastAction: "spawned",
      lastActionAt: now,
      errorCount: 0,
      startedAt: now,
      task,
    };
    this.workers.set(id, worker);
    this.recentTools.set(id, []);
    this.notify(worker);
    return worker;
  }

  removeWorker(id: string): void {
    this.workers.delete(id);
    this.recentTools.delete(id);
  }

  get(id: string): WorkerState | undefined {
    return this.workers.get(id);
  }

  getAll(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  onUpdate(callback: (worker: WorkerState) => void): void {
    this.listeners.push(callback);
  }

  tick(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (now - worker.lastActionAt > IDLE_THRESHOLD && worker.status !== "idle") {
        worker.status = "idle";
        worker.currentAction = null;
        this.notify(worker);
      }
    }
  }

  private handleEvent(event: TelemetryEvent): void {
    const worker = this.workers.get(event.worker_id);
    if (!worker) return;

    const now = event.timestamp || Date.now();
    worker.lastActionAt = now;

    switch (event.event) {
      case "SessionStart":
        worker.status = "working";
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
        }
        // Check for stuck state
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

    // Check error threshold for stuck
    if (worker.errorCount > 2) {
      worker.status = "stuck";
    }

    // Check working threshold — if last activity was recent, still working
    if (
      worker.status !== "stuck" &&
      worker.status !== "waiting" &&
      now - worker.lastActionAt < WORKING_THRESHOLD
    ) {
      worker.status = "working";
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
      listener(worker);
    }
  }
}
