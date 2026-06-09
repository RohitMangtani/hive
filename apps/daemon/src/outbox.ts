import { readdirSync, readFileSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import { homedir } from "os";

/**
 * File-based message relay for agents that can't access the HTTP API
 * (e.g., Codex with sandbox network restrictions).
 *
 * Agents write JSON files to ~/.hive/outbox/:
 *   - message: {type:"message", workerId:"discovered_XXX", content:"...", from?:"worker-id", contextWorkerIds?:["worker-id"]}
 *   - learning: {type:"learning", project:"hive", lesson:"..."}
 *   - scratchpad: {type:"scratchpad", key:"...", value:"...", setBy:"codex-q4"}
 *
 * The daemon picks them up every tick (3s) and processes them.
 */

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const OUTBOX_DIR = join(HOME, ".hive", "outbox");
// Matches the in-memory message queue's 30-minute staleness drop: a file
// that still fails dispatch after this long is dead-lettered instead of
// retrying forever every 3s tick.
const MAX_RETRY_AGE_MS = 30 * 60 * 1000;

export class OutboxScanner {
  private telemetry: TelemetryReceiver;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
    try { mkdirSync(OUTBOX_DIR, { recursive: true }); } catch { /* exists */ }
  }

  tick(): void {
    let files: string[];
    try {
      files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith(".json"));
    } catch {
      return;
    }

    for (const file of files) {
      const fullPath = join(OUTBOX_DIR, file);
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const msg = JSON.parse(raw);
        if (this.process(msg)) {
          unlinkSync(fullPath);
        } else if (this.isExpired(fullPath)) {
          console.log(`[outbox] Dropping ${file}: undeliverable for over ${Math.round(MAX_RETRY_AGE_MS / 60000)}m`);
          unlinkSync(fullPath);
        }
      } catch {
        // Bad JSON or processing error  --  remove to prevent infinite retry
        try { unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  }

  private isExpired(fullPath: string): boolean {
    try {
      return Date.now() - statSync(fullPath).mtimeMs > MAX_RETRY_AGE_MS;
    } catch {
      return false;
    }
  }

  private process(msg: Record<string, unknown>): boolean {
    switch (msg.type) {
      case "message": {
        const workerId = msg.workerId as string;
        const content = msg.content as string;
        const from = msg.from as string | undefined;
        const contextWorkerIds = Array.isArray(msg.contextWorkerIds)
          ? msg.contextWorkerIds.filter((value): value is string => typeof value === "string")
          : undefined;
        const includeSenderContext = msg.includeSenderContext as boolean | undefined;
        if (!workerId || !content) return true;
        const result = this.telemetry.sendToWorker(workerId, content, {
          source: from ? `outbox:from:${from}` : "outbox",
          fromWorkerId: from,
          contextWorkerIds,
          includeSenderContext,
        });
        if (result.ok) {
          console.log(`[outbox] Dispatched message to ${workerId}${result.queued ? ` (queued at position ${result.position})` : ""}`);
          return true;
        } else {
          console.log(`[outbox] Failed to dispatch message to ${workerId}: ${result.error}`);
          return false;
        }
      }
      case "learning": {
        const project = msg.project as string;
        const lesson = msg.lesson as string;
        if (!project || !lesson) return true;
        this.telemetry.writeLearning(project, lesson);
        console.log(`[outbox] Wrote learning for ${project}`);
        return true;
      }
      case "scratchpad": {
        const key = msg.key as string;
        const value = msg.value as string;
        const setBy = (msg.setBy as string) || "outbox";
        if (!key || !value) return true;
        this.telemetry.setScratchpad(key, value, setBy);
        console.log(`[outbox] Set scratchpad: ${key}`);
        return true;
      }
      default:
        console.log(`[outbox] Unknown message type: ${msg.type}`);
        return true;
    }
  }
}
