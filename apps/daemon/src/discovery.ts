import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";

interface ProcessInfo {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  project: string;
  projectName: string;
}

const AGENT_COLORS = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ec4899", // pink
];

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private discoveredPids = new Set<number>();
  private pidColors = new Map<number, string>();
  private daemonPid = process.pid;
  private colorIndex = 0;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
  }

  scan(): void {
    const processes = this.findClaudeProcesses();
    const alivePids = new Set<number>();

    for (const proc of processes) {
      alivePids.add(proc.pid);
      const id = `discovered_${proc.pid}`;

      if (this.discoveredPids.has(proc.pid)) {
        // Existing process — update project context + CPU status
        const existing = this.telemetry.get(id);
        if (existing) {
          existing.lastActionAt = Date.now();

          // Re-identify project on every scan
          if (proc.projectName !== "unknown") {
            existing.project = proc.project;
            existing.projectName = proc.projectName;
          }

          if (proc.cpuPercent > 5) {
            existing.status = "working";
            existing.currentAction = `CPU ${proc.cpuPercent.toFixed(0)}%`;
          } else if (existing.status === "working") {
            existing.status = "waiting";
            existing.currentAction = null;
          }

          // Broadcast the update
          this.telemetry.notifyExternal(existing);
        }
        continue;
      }

      // New process
      if (!this.pidColors.has(proc.pid)) {
        this.pidColors.set(proc.pid, AGENT_COLORS[this.colorIndex % AGENT_COLORS.length]);
        this.colorIndex++;
      }

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: proc.project,
        projectName: proc.projectName,
        status: proc.cpuPercent > 5 ? "working" : "waiting",
        currentAction: proc.cpuPercent > 5 ? `CPU ${proc.cpuPercent.toFixed(0)}%` : null,
        lastAction: "Discovered on machine",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: proc.startedAt,
        task: null,
        managed: false,
        tty: proc.tty,
        color: this.pidColors.get(proc.pid),
      };

      this.telemetry.registerDiscovered(id, worker);
      this.discoveredPids.add(proc.pid);
    }

    // Remove dead processes
    for (const pid of this.discoveredPids) {
      if (!alivePids.has(pid)) {
        this.telemetry.removeWorker(`discovered_${pid}`);
        this.discoveredPids.delete(pid);
        this.pidColors.delete(pid);
      }
    }
  }

  private findClaudeProcesses(): ProcessInfo[] {
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];
      const results: ProcessInfo[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.endsWith("claude") && !trimmed.match(/claude\s*$/)) continue;
        if (trimmed.includes("grep")) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 9) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid) || pid === this.daemonPid) continue;

        const cpuPercent = parseFloat(parts[1]);
        const mon = parts[3];
        const day = parseInt(parts[4], 10);
        const time = parts[5];
        const year = parseInt(parts[6], 10);
        const startedAt = new Date(`${mon} ${day}, ${year} ${time}`).getTime();

        const info = this.getProcessInfo(pid);
        if (!info) continue;

        results.push({ pid, cpuPercent, startedAt, ...info });
      }

      return results;
    } catch {
      return [];
    }
  }

  private getProcessInfo(pid: number): {
    tty: string;
    project: string;
    projectName: string;
  } | null {
    try {
      const raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const lines = raw.split("\n");
      let cwd: string | null = null;
      let tty = "";
      const sessionIds: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n/")) {
          cwd = lines[i + 1].slice(1);
        }
        if (lines[i].startsWith("n/dev/tty") && !tty) {
          tty = lines[i].slice(1).replace("/dev/", "");
        }
        const taskMatch = lines[i].match(/^n.*\/.claude\/tasks\/([0-9a-f-]{36})/);
        if (taskMatch && !sessionIds.includes(taskMatch[1])) {
          sessionIds.push(taskMatch[1]);
        }
      }

      if (!cwd) return null;

      const projectName = this.inferProject(sessionIds) || this.projectNameFromCwd(cwd);
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const project = (cwd === homeDir || cwd === "/")
        ? `${homeDir}/factory/projects/${projectName}`
        : cwd;

      return { tty, project, projectName };
    } catch {
      return null;
    }
  }

  /**
   * Read the LAST 5KB of the most recently modified session JSONL.
   * Only look at recent activity to get the current project, not historical.
   */
  private inferProject(sessionIds: string[]): string | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");

    try {
      // Find the most recently modified JSONL for these sessions
      let bestFile: string | null = null;
      let bestMtime = 0;

      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const jsonlPath = join(fullDir, `${sessionId}.jsonl`);
          try {
            const stat = statSync(jsonlPath);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = jsonlPath;
            }
          } catch {
            // File doesn't exist
          }
        }
      }

      if (!bestFile) return null;

      // Read only the last 5KB — recent activity only
      const content = this.readTail(bestFile, 5_000);

      // Count project references from file paths
      const counts = new Map<string, number>();

      // Match ~/factory/projects/X/ paths
      for (const match of content.matchAll(/\/factory\/projects\/([^/\\"]+)/g)) {
        const name = match[1];
        counts.set(name, (counts.get(name) || 0) + 1);
      }

      // Also match project-like paths with src/app/lib inside
      for (const match of content.matchAll(/\/Users\/[^/]+\/([^/\\"]+)\/(?:src|app|lib|components)\//g)) {
        const name = match[1];
        if (name !== "factory" && name !== ".claude" && name !== ".local") {
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }

      if (counts.size === 0) return null;

      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return sorted[0][0];
    } catch {
      return null;
    }
  }

  private readTail(path: string, bytes: number): string {
    const buf = readFileSync(path);
    if (buf.length <= bytes) return buf.toString("utf-8");
    return buf.subarray(buf.length - bytes).toString("utf-8");
  }

  private projectNameFromCwd(cwd: string): string {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    if (cwd === homeDir || cwd === "/") return "unknown";
    return cwd.split("/").pop() || cwd;
  }
}
