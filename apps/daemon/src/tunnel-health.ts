/**
 * Tunnel health monitor.
 *
 * Checks every tick (3s) whether the ngrok/cloudflared tunnel process is alive.
 * If the tunnel dies, auto-restarts it so satellite connections recover.
 *
 * Only runs on the primary (satellite mode has no tunnel).
 */

import { execFile, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HIVE_DIR = join(homedir(), ".hive");
const TUNNEL_PID_FILE = join(HIVE_DIR, "tunnel.pid");
const TUNNEL_URL_FILE = join(HIVE_DIR, "tunnel-url.txt");
const NGROK_LOG = join(HIVE_DIR, "ngrok.log");
const CLOUDFLARED_LOG = join(HIVE_DIR, "cloudflared.log");
const NGROK_DOMAIN_FILE = join(HIVE_DIR, "ngrok-domain");

// Don't check more than once every 15s to avoid spamming
const CHECK_INTERVAL_MS = 15_000;
// After restart, wait before checking again
const POST_RESTART_COOLDOWN_MS = 30_000;

export class TunnelHealthMonitor {
  private lastCheckAt = 0;
  private restartCount = 0;
  private lastRestartAt = 0;
  /** Guard so only one async probe/restart sequence runs at a time. */
  private checkInFlight = false;

  /** Called every 3s tick. Only acts every CHECK_INTERVAL_MS.
   *
   *  The actual probes run async: a curl with a multi-second timeout used to
   *  execute synchronously here, blocking discovery, telemetry, and WS
   *  serving for the duration. */
  tick(): void {
    const now = Date.now();
    if (now - this.lastCheckAt < CHECK_INTERVAL_MS) return;
    if (now - this.lastRestartAt < POST_RESTART_COOLDOWN_MS) return;
    if (this.checkInFlight) return;
    this.lastCheckAt = now;

    if (!this.isTunnelExpected()) return;

    this.checkInFlight = true;
    this.isTunnelAlive()
      .then(async (alive) => {
        if (alive) return;
        // Re-check the cooldown — the probe itself may have taken seconds.
        if (Date.now() - this.lastRestartAt < POST_RESTART_COOLDOWN_MS) return;
        console.log(`[tunnel-health] Tunnel process dead. Restarting... (restart #${this.restartCount + 1})`);
        await this.restart();
      })
      .catch(() => { /* probe errors already treated as trust-PID */ })
      .finally(() => { this.checkInFlight = false; });
  }

  /** A tunnel is expected if we have a tunnel PID file or URL file. */
  private isTunnelExpected(): boolean {
    return existsSync(TUNNEL_PID_FILE) || existsSync(TUNNEL_URL_FILE);
  }

  /** Check if the tunnel is actually working — not just PID alive but reachable. */
  private async isTunnelAlive(): Promise<boolean> {
    // Step 1: check if PID is alive (cheap and synchronous: tiny file read + signal 0)
    try {
      const pidStr = readFileSync(TUNNEL_PID_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!pid || isNaN(pid)) return false;
      process.kill(pid, 0);
    } catch {
      return false;
    }

    // Step 2: verify the tunnel is actually functional (not just process alive).
    // ngrok can be running but broken (ERR_6030: multiple endpoints, ERR_8012: etc.)
    // Check the ngrok local API to verify tunnel status.
    const ngrokApi = await this.curl(["-s", "--connect-timeout", "2", "http://127.0.0.1:4040/api/tunnels"], 5000);
    if (ngrokApi !== null) {
      try {
        const data = JSON.parse(ngrokApi);
        if (!data.tunnels || data.tunnels.length === 0) {
          console.log("[tunnel-health] ngrok running but no active tunnels — restarting");
          return false;
        }
        return true;
      } catch { /* unparseable — fall through to URL check */ }
    }

    // ngrok API not responding — might be cloudflared, check URL reachability instead
    let url = "";
    try {
      url = readFileSync(TUNNEL_URL_FILE, "utf-8").trim();
    } catch {
      return true; // can't verify, trust PID
    }
    if (!url) return true; // no URL to check, trust PID
    const status = await this.curl(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", url + "/health"], 8000);
    if (status === null) return true; // can't verify, trust PID
    // Any HTTP response (even 426 Upgrade Required) means tunnel works
    if (status.trim() !== "000") return true;
    console.log("[tunnel-health] Tunnel URL unreachable (status 000) — restarting");
    return false;
  }

  /** Async curl helper. Resolves null when curl itself fails. */
  private curl(args: string[], timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("curl", args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? null : stdout);
      });
    });
  }

  /** Kill existing tunnel processes, matched on their full spawn signatures.
   *  A bare `pkill -f ngrok` also SIGTERMs unrelated processes whose command
   *  line merely contains the substring — e.g. `tail -f ~/.hive/ngrok.log`
   *  or an editor with ngrok.log open. The patterns below match the exact
   *  spawn signatures used by start.sh and this module. */
  private async killTunnelProcesses(): Promise<void> {
    const run = (cmd: string, cmdArgs: string[]) => new Promise<void>((resolve) => {
      execFile(cmd, cmdArgs, { timeout: 5000 }, () => resolve()); // non-zero exit = nothing matched — fine
    });
    if (process.platform === "win32") {
      await run("taskkill", ["/IM", "ngrok.exe", "/F"]);
      await run("taskkill", ["/IM", "cloudflared.exe", "/F"]);
      return;
    }
    await run("pkill", ["-f", "ngrok http 3002"]);
    await run("pkill", ["-f", "cloudflared tunnel --url"]);
  }

  /** Restart the tunnel. Kills existing tunnel processes first to prevent
   *  the "multiple endpoints" race (ERR_NGROK_6030), then starts fresh. */
  private async restart(): Promise<void> {
    this.restartCount++;
    this.lastRestartAt = Date.now();

    // Kill existing ngrok/cloudflared tunnel processes to prevent duplicates.
    // This is the fix for ERR_NGROK_6030 ("multiple endpoints but not all
    // have pooling enabled") which happens when a stale process lingers.
    await this.killTunnelProcesses();

    // Wait a moment for processes to fully die before starting new ones —
    // without blocking the event loop the way the old execFileSync sleep did.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Read stable domain if configured
    let ngrokDomain = "";
    try {
      ngrokDomain = readFileSync(NGROK_DOMAIN_FILE, "utf-8").trim();
    } catch { /* none */ }

    // Try ngrok
    if (await this.hasCommand("ngrok")) {
      try {
        const args = ngrokDomain
          ? ["http", "3002", "--domain", ngrokDomain, "--log=stdout"]
          : ["http", "3002", "--log=stdout"];

        const child = spawn("ngrok", args, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Pipe stdout to log file
        const { createWriteStream } = require("fs") as typeof import("fs");
        const logStream = createWriteStream(NGROK_LOG, { flags: "a" });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        child.unref();

        if (child.pid) {
          writeFileSync(TUNNEL_PID_FILE, String(child.pid));
        }

        // Wait for ngrok to produce a URL (poll the API)
        setTimeout(() => this.captureNgrokUrl(), 5000);
        console.log(`[tunnel-health] ngrok restarted (PID ${child.pid})`);
        return;
      } catch (err) {
        console.log(`[tunnel-health] ngrok restart failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Try cloudflared
    if (await this.hasCommand("cloudflared")) {
      try {
        const child = spawn("cloudflared", [
          "tunnel", "--url", "http://localhost:3002", "--no-autoupdate",
        ], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const { createWriteStream } = require("fs") as typeof import("fs");
        const logStream = createWriteStream(CLOUDFLARED_LOG, { flags: "a" });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        child.unref();

        if (child.pid) {
          writeFileSync(TUNNEL_PID_FILE, String(child.pid));
        }

        // Cloudflared logs the URL to stderr
        setTimeout(() => this.captureCloudflaredUrl(), 10000);
        console.log(`[tunnel-health] cloudflared restarted (PID ${child.pid})`);
        return;
      } catch (err) {
        console.log(`[tunnel-health] cloudflared restart failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log("[tunnel-health] No tunnel tool available (ngrok or cloudflared)");
  }

  private captureNgrokUrl(): void {
    this.curl(["-s", "http://127.0.0.1:4040/api/tunnels"], 5000).then((raw) => {
      try {
        if (raw === null) throw new Error("curl failed");
        const data = JSON.parse(raw);
        for (const t of data.tunnels || []) {
          if (t.public_url && t.public_url.startsWith("https://")) {
            writeFileSync(TUNNEL_URL_FILE, t.public_url);
            console.log(`[tunnel-health] Tunnel URL captured: ${t.public_url}`);
            return;
          }
        }
        console.log("[tunnel-health] Failed to capture ngrok URL — will retry next tick");
      } catch {
        console.log("[tunnel-health] Failed to capture ngrok URL — will retry next tick");
      }
    });
  }

  private captureCloudflaredUrl(): void {
    try {
      const log = readFileSync(CLOUDFLARED_LOG, "utf-8");
      const match = log.match(/https:\/\/[-a-z0-9.]+trycloudflare\.com/);
      if (match) {
        writeFileSync(TUNNEL_URL_FILE, match[0]);
        console.log(`[tunnel-health] Tunnel URL captured: ${match[0]}`);
      }
    } catch {
      console.log("[tunnel-health] Failed to capture cloudflared URL");
    }
  }

  private hasCommand(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(process.platform === "win32" ? "where" : "which", [cmd], {
        timeout: 3000,
        encoding: "utf-8",
      }, (err) => resolve(!err));
    });
  }
}
