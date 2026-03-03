import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const CONFIG_PATH = join(HOME, ".hive", "notifications.json");
const DEFAULT_COOLDOWN = 60_000;
const DEFAULT_ERROR_THRESHOLD = 3;

interface NotificationConfig {
  enabled: boolean;
  cooldownMs: number;
  errorThreshold: number;
  sound: boolean;
}

const DEFAULT_CONFIG: NotificationConfig = {
  enabled: true,
  cooldownMs: DEFAULT_COOLDOWN,
  errorThreshold: DEFAULT_ERROR_THRESHOLD,
  sound: true,
};

export class NotificationManager {
  private config: NotificationConfig;
  private lastNotified = new Map<string, number>();
  private previousStatus = new Map<string, string>();

  constructor() {
    this.config = this.loadConfig();
  }

  register(telemetry: TelemetryReceiver): void {
    telemetry.onUpdate((workerId, state) => {
      this.handleUpdate(workerId, state);
    });

    telemetry.onRemoval((workerId) => {
      this.lastNotified.delete(workerId);
      this.previousStatus.delete(workerId);
    });

    console.log(`  Notifications: ${this.config.enabled ? "enabled" : "disabled"} (config: ${CONFIG_PATH})`);
  }

  getConfig(): NotificationConfig {
    return { ...this.config };
  }

  private handleUpdate(workerId: string, state: WorkerState): void {
    if (!this.config.enabled) return;

    const prev = this.previousStatus.get(workerId);
    this.previousStatus.set(workerId, state.status);

    if (state.status === "stuck" && prev !== "stuck") {
      this.notify(workerId, state);
      return;
    }

    if (state.errorCount >= this.config.errorThreshold && prev !== "stuck") {
      this.notify(workerId, state);
    }
  }

  private notify(workerId: string, state: WorkerState): void {
    const now = Date.now();
    const last = this.lastNotified.get(workerId) || 0;
    if (now - last < this.config.cooldownMs) return;

    this.lastNotified.set(workerId, now);

    const label = state.tty || workerId.slice(0, 10);
    const project = state.projectName || "unknown";
    const action = state.stuckMessage?.split("\n")[0]?.slice(0, 80) || state.currentAction || "Needs attention";
    const title = `Hive: ${label} stuck`;
    const body = `${project} — ${action}`;

    try {
      const soundClause = this.config.sound ? ' sound name "Funk"' : "";
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"${soundClause}`;
      execSync(`osascript -e '${script}'`, { timeout: 3000, stdio: "ignore" });
      console.log(`[notify] ${label}: ${action.slice(0, 60)}`);
    } catch {
      // Non-critical
    }
  }

  private loadConfig(): NotificationConfig {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        return { ...DEFAULT_CONFIG, ...raw };
      }
    } catch { /* use defaults */ }

    try {
      const dir = join(HOME, ".hive");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    } catch { /* non-critical */ }

    return { ...DEFAULT_CONFIG };
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
