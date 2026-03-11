import { readdirSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import { sendInputToTty } from "./tty-input.js";

/**
 * File-based message relay for agents that can't access the HTTP API
 * (e.g., Codex with sandbox network restrictions).
 *
 * Agents write JSON files to ~/.hive/outbox/:
 *   - message: {type:"message", workerId:"discovered_XXX", content:"..."}
 *   - learning: {type:"learning", project:"hive", lesson:"..."}
 *   - scratchpad: {type:"scratchpad", key:"...", value:"...", setBy:"codex-q4"}
 *
 * The daemon picks them up every tick (3s) and processes them.
 */

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const OUTBOX_DIR = join(HOME, ".hive", "outbox");

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
        this.process(msg);
        unlinkSync(fullPath);
      } catch {
        // Bad JSON or processing error — remove to prevent infinite retry
        try { unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  }

  private process(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "message": {
        const workerId = msg.workerId as string;
        const content = msg.content as string;
        if (!workerId || !content) return;
        const worker = this.telemetry.get(workerId);
        if (!worker?.tty) return;
        sendInputToTty(worker.tty, content);
        this.telemetry.markInputSent(workerId, "outbox");
        console.log(`[outbox] Dispatched message to ${workerId}`);
        break;
      }
      case "learning": {
        const project = msg.project as string;
        const lesson = msg.lesson as string;
        if (!project || !lesson) return;
        this.telemetry.writeLearning(project, lesson);
        console.log(`[outbox] Wrote learning for ${project}`);
        break;
      }
      case "scratchpad": {
        const key = msg.key as string;
        const value = msg.value as string;
        const setBy = (msg.setBy as string) || "outbox";
        if (!key || !value) return;
        this.telemetry.setScratchpad(key, value, setBy);
        console.log(`[outbox] Set scratchpad: ${key}`);
        break;
      }
      default:
        console.log(`[outbox] Unknown message type: ${msg.type}`);
    }
  }
}
