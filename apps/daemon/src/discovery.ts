import { execFileSync, execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";

interface DiscoveredProcess {
  pid: number;
  cwd: string;
  project: string;
  projectName: string;
  tty: string;
  startedAt: number;
  cpuPercent: number;
}

// Colors assigned to agents for visual differentiation
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

      if (this.discoveredPids.has(proc.pid)) {
        const id = `discovered_${proc.pid}`;
        const existing = this.telemetry.get(id);
        if (existing) {
          existing.lastActionAt = Date.now();
          if (proc.cpuPercent > 5) {
            existing.status = "working";
            existing.currentAction = `CPU ${proc.cpuPercent.toFixed(0)}%`;
          } else if (existing.status === "working") {
            existing.status = "waiting";
            existing.currentAction = null;
          }
        }
        continue;
      }

      const id = `discovered_${proc.pid}`;
      const color = AGENT_COLORS[this.colorIndex % AGENT_COLORS.length];
      this.colorIndex++;

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
        color,
      };

      this.telemetry.registerDiscovered(id, worker);
      this.discoveredPids.add(proc.pid);
    }

    for (const pid of this.discoveredPids) {
      if (!alivePids.has(pid)) {
        const id = `discovered_${pid}`;
        this.telemetry.removeWorker(id);
        this.discoveredPids.delete(pid);
      }
    }
  }

  private findClaudeProcesses(): DiscoveredProcess[] {
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];
      const results: DiscoveredProcess[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.endsWith("claude") && !trimmed.match(/claude\s*$/)) continue;
        if (trimmed.includes("grep")) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 9) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) continue;
        if (pid === this.daemonPid) continue;

        const cpuPercent = parseFloat(parts[1]);
        const mon = parts[3];
        const day = parseInt(parts[4], 10);
        const time = parts[5];
        const year = parseInt(parts[6], 10);
        const startedAt = new Date(`${mon} ${day}, ${year} ${time}`).getTime();

        // Get process info from lsof (cwd, tty, session files)
        const info = this.getProcessInfo(pid);
        if (!info) continue;

        results.push({ pid, startedAt, cpuPercent, ...info });
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Extract cwd, tty, and infer project from open session files.
   */
  private getProcessInfo(pid: number): {
    cwd: string;
    project: string;
    projectName: string;
    tty: string;
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
        // Get cwd
        if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n/")) {
          cwd = lines[i + 1].slice(1);
        }
        // Get tty
        if (lines[i].startsWith("n/dev/tty") && !tty) {
          tty = lines[i].slice(1).replace("/dev/", "");
        }
        // Collect session IDs from open .claude/tasks/ paths
        const taskMatch = lines[i].match(/^n.*\/.claude\/tasks\/([0-9a-f-]{36})/);
        if (taskMatch && !sessionIds.includes(taskMatch[1])) {
          sessionIds.push(taskMatch[1]);
        }
      }

      if (!cwd) return null;

      // Try to identify the project from session JSONL files
      const projectName = this.inferProjectFromSessions(sessionIds) ||
                          this.projectNameFromCwd(cwd);
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const project = projectName !== cwd.split("/").pop()
        ? `${homeDir}/factory/projects/${projectName}`
        : cwd;

      return { cwd, project, projectName, tty };
    } catch {
      return null;
    }
  }

  /**
   * Scan session JSONL files for file paths to identify the active project.
   * Reads the last ~50KB of the JSONL to find recent tool calls.
   */
  private inferProjectFromSessions(sessionIds: string[]): string | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");

    try {
      // Walk all project subdirectories to find matching JSONL files
      const projectDirCounts = new Map<string, number>();

      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const jsonlPath = join(fullDir, `${sessionId}.jsonl`);
          try {
            // Read the last chunk of the file for recent activity
            const content = this.readTail(jsonlPath, 50_000);

            // Scan for project file paths
            const matches = content.matchAll(/\/factory\/projects\/([^/\\"]+)/g);
            for (const match of matches) {
              const name = match[1];
              projectDirCounts.set(name, (projectDirCounts.get(name) || 0) + 1);
            }

            // Also check for any other project-like paths
            const otherMatches = content.matchAll(/\/Users\/[^/]+\/([^/\\"]+)\/(?:src|app|lib|components)\//g);
            for (const match of otherMatches) {
              const name = match[1];
              if (name !== "factory" && name !== ".claude") {
                projectDirCounts.set(name, (projectDirCounts.get(name) || 0) + 1);
              }
            }
          } catch {
            // File doesn't exist in this project dir, try next
          }
        }
      }

      if (projectDirCounts.size === 0) return null;

      // Return the most referenced project
      const sorted = [...projectDirCounts.entries()].sort((a, b) => b[1] - a[1]);
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
    if (cwd === homeDir || cwd === "/") {
      return "unknown";
    }
    return cwd.split("/").pop() || cwd;
  }
}
