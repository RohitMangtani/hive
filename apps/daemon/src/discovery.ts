import { execFileSync } from "child_process";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";

interface DiscoveredProcess {
  pid: number;
  cwd: string;
  startedAt: number;
  cpuPercent: number;
}

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private discoveredPids = new Set<number>();
  private daemonPid = process.pid;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
  }

  /**
   * Scan for running `claude` CLI processes on this machine.
   * Registers them as unmanaged workers in telemetry.
   */
  scan(): void {
    const processes = this.findClaudeProcesses();

    // Track which PIDs are still alive
    const alivePids = new Set<number>();

    for (const proc of processes) {
      alivePids.add(proc.pid);

      // Skip if already tracked
      if (this.discoveredPids.has(proc.pid)) {
        const id = `discovered_${proc.pid}`;
        const existing = this.telemetry.get(id);
        if (existing) {
          existing.lastActionAt = Date.now();
          // Infer activity from CPU usage
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

      // New process found — register it
      const id = `discovered_${proc.pid}`;
      const projectName = proc.cwd.split("/").pop() || proc.cwd;

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: proc.cwd,
        projectName,
        status: proc.cpuPercent > 5 ? "working" : "waiting",
        currentAction: proc.cpuPercent > 5 ? `CPU ${proc.cpuPercent.toFixed(0)}%` : null,
        lastAction: "Discovered on machine",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: proc.startedAt,
        task: null,
        managed: false,
      };

      this.telemetry.registerDiscovered(id, worker);
      this.discoveredPids.add(proc.pid);
    }

    // Remove workers whose processes have died
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
      // Get all processes — use execFileSync (no shell injection risk)
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];

      const results: DiscoveredProcess[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        // Only match lines ending with just "claude" (the CLI process, not subprocesses)
        if (!trimmed.endsWith("claude") && !trimmed.match(/claude\s*$/)) continue;
        // Skip grep artifacts
        if (trimmed.includes("grep")) continue;

        // Parse lstart format: "DAY MON DD HH:MM:SS YYYY"
        // Example line: " 99294  14.7 Wed Feb 26 17:00:00 2026 s000  claude"
        const parts = trimmed.split(/\s+/);
        if (parts.length < 9) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) continue;

        const cpuPercent = parseFloat(parts[1]);

        // lstart is 5 fields: DAY MON DD HH:MM:SS YYYY
        const mon = parts[3];
        const day = parseInt(parts[4], 10);
        const time = parts[5];
        const year = parseInt(parts[6], 10);
        const startedAt = new Date(`${mon} ${day}, ${year} ${time}`).getTime();

        // Skip our own daemon process
        if (pid === this.daemonPid) continue;

        // Get the working directory
        const cwd = this.getCwd(pid);
        if (!cwd) continue;

        results.push({ pid, cwd, startedAt, cpuPercent });
      }

      return results;
    } catch {
      return [];
    }
  }

  private getCwd(pid: number): string | null {
    try {
      // On macOS, lsof -p PID gives file descriptors. cwd is type 'cwd'
      const raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      // Look for cwd entry — format is 'fcwd' followed by 'n/path'
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n/")) {
          return lines[i + 1].slice(1); // remove 'n' prefix
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
