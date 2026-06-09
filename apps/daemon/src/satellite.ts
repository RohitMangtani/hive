/**
 * Satellite mode: connects this machine's terminals to a remote primary Hive daemon.
 *
 * The satellite runs local discovery + session streaming, reports workers to the
 * primary via WebSocket, and executes commands (message, kill, spawn, selection)
 * forwarded from the primary's dashboard.
 *
 * Usage: npx tsx apps/daemon/src/index.ts --satellite wss://xxx.trycloudflare.com TOKEN
 */

import { hostname } from "os";
import { homedir, platform } from "os";
import { join, basename } from "path";
import { unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { execFile, execFileSync } from "child_process";
import { randomBytes } from "crypto";
import type { MachineCapabilities, UploadedFileRef } from "@hive/types";
import { detectAndWriteMachineManifest } from "./detect-capabilities.js";
import { ProcessDiscovery } from "./discovery.js";
import { TelemetryReceiver } from "./telemetry.js";
import { SessionStreamer } from "./session-stream.js";
import { ProcessManager } from "./process-mgr.js";
import { patchHookUrls } from "./auth.js";
import { AutoPilot } from "./auto-pilot.js";
import type { WorkerState } from "./types.js";
import { resolveExecCwd, runShellExec } from "./shell-exec.js";
import {
  chooseSatelliteRecoveryAction,
  chooseSatelliteUpdateGate,
  isRecentlyFailedHead,
  SATELLITE_STABLE_CONNECTION_MS,
  SATELLITE_UPDATE_MAX_ATTEMPTS,
  type SatelliteUpdateAttemptState,
} from "./satellite-recovery.js";
import { appendControlPlaneAudit } from "./control-plane-audit.js";
import { storeUploadedFile } from "./upload-store.js";
import {
  FederationSocketClient,
  type FederationDisconnectMeta,
} from "./federation-socket.js";
import type { LoadedPlatform } from "./platform/interfaces.js";

/** Get the git commit hash of the hive repo (short, 8 chars). */
function getGitVersion(): string {
  try {
    // Resolve repo root from this file: apps/daemon/src/satellite.ts → ../../..
    const repoDir = join(import.meta.dirname, "..", "..", "..");
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoDir, timeout: 3000, encoding: "utf-8",
    }).trim();
  } catch { return "unknown"; }
}

/**
 * Resolve a stable, collision-free machine identity.
 *
 * A hostname-only id collides: two machines with the same default hostname
 * (e.g. two "MacBook-Air" Macs) kick each other offline on the primary and
 * receive each other's commands. On first run we persist hostname plus a
 * short random suffix to ~/.hive/machine-id and reuse it forever. A
 * pre-existing file (including a bare-hostname id from an older install) is
 * accepted unchanged so established identities never shift across updates.
 *
 * Constraints (see ws-server routing + federation auth URL):
 * - charset stays [a-z0-9-] and never contains ":" — worker ids are
 *   "machineId:localId" and parse on the FIRST colon
 * - the suffix is appended AFTER the 24-char hostname truncation so long
 *   hostnames cannot silently truncate it away and reintroduce collisions
 */
export function resolveMachineId(hiveDir: string = join(homedir(), ".hive")): string {
  const idPath = join(hiveDir, "machine-id");
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, "utf-8")
        .trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
      if (existing) return existing;
    }
  } catch { /* unreadable — regenerate below */ }

  const base = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "satellite";
  const suffix = randomBytes(2).toString("hex"); // 4 chars, [0-9a-f]
  const id = `${base}-${suffix}`;
  try {
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(idPath, `${id}\n`);
  } catch {
    // Cannot persist: fall back to the legacy hostname-only id so identity
    // at least stays stable across restarts on this machine.
    return base;
  }
  return id;
}

/** Message from satellite → primary */
interface SatelliteUpMessage {
  type:
    | "satellite_hello"
    | "satellite_workers"
    | "satellite_chat"
    | "satellite_result"
    | "satellite_projects"
    | "satellite_api_request"
    | "satellite_context_response"
    | "satellite_heartbeat";
  machineId?: string;
  hostname?: string;
  platform?: string;
  capabilities?: MachineCapabilities;
  version?: string;
  workers?: WorkerState[];
  workerId?: string;
  messages?: unknown[];
  full?: boolean;
  requestId?: string;
  ok?: boolean;
  error?: string;
  tty?: string;
  projects?: string[];
  // API relay fields
  method?: string;
  path?: string;
  body?: unknown;
  context?: unknown;
  chatHistory?: unknown[];
  data?: unknown;
  ts?: number;
  upload?: UploadedFileRef;
}

/** Message from primary → satellite */
interface SatelliteDownMessage {
  type: string;
  requestId?: string;
  primaryUrl?: string;
  action?: string;
  workerId?: string;      // prefixed ID (machineId:localId)
  localWorkerId?: string; // local ID on this machine
  project?: string;
  model?: string;
  targetQuadrant?: number;
  initialMessage?: string;
  pendingTask?: string;
  content?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  optionIndex?: number;
  files?: string[];       // auto-commit: file paths to commit
  message?: string;       // auto-commit: commit message
  workers?: unknown[];    // satellite_all_workers: full worker list from primary
  includeHistory?: boolean; // satellite_context: include conversation history
  historyLimit?: number;    // satellite_context: max history entries
  ts?: number;
  fileName?: string;
  mimeType?: string;
  size?: number;
  dataBase64?: string;
}

export class SatelliteClient {
  private readonly machineId: string;
  /** Version of the code this process is actually running (repo HEAD at
   *  process start). satellite_update compares this — NOT the pre-pull
   *  HEAD — to the post-pull HEAD, so a repo pulled while this process was
   *  stale still restarts, and only true no-op updates are suppressed. */
  private readonly runningVersion: string;
  private readonly capabilities: MachineCapabilities;
  private readonly telemetry: TelemetryReceiver;
  private readonly discovery: ProcessDiscovery;
  private readonly streamer: SessionStreamer;
  private readonly procMgr: ProcessManager;
  private readonly federation: FederationSocketClient<SatelliteDownMessage, SatelliteUpMessage>;
  private readonly runtimePlatform: LoadedPlatform;
  private autoPilot: AutoPilot | null = null;
  private chatSubs = new Map<string, string>(); // prefixed workerId → subKey
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  // API relay: pending requests awaiting response from primary
  private pendingApiRequests = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private apiRequestId = 0;
  private connectedAt = 0;
  private offlineSince = 0;
  private consecutiveFailures = 0;
  private shortLivedConnections = 0;
  private selfHealAttempts = 0;
  private lastSelfHealAt = 0;
  private selfHealInFlight = false;
  /** When the primary last pushed its merged fleet view (satellite_all_workers). */
  private lastPeerSlotsAt = 0;

  constructor(primaryUrl: string, token: string, localToken: string, runtimePlatform: LoadedPlatform) {
    this.machineId = resolveMachineId();
    this.runningVersion = getGitVersion();
    this.capabilities = detectAndWriteMachineManifest();
    this.runtimePlatform = runtimePlatform;

    console.log(`[satellite] Capabilities: ${JSON.stringify(this.capabilities)}`);

    // Local telemetry server (receives hooks from local Claude instances)
    this.telemetry = new TelemetryReceiver(3001, localToken, {
      terminal: runtimePlatform.terminal,
      windows: runtimePlatform.windows,
    });
    this.procMgr = new ProcessManager(this.telemetry);
    this.streamer = new SessionStreamer();
    this.discovery = new ProcessDiscovery(this.telemetry, this.streamer, {
      discovery: runtimePlatform.discovery,
      terminal: runtimePlatform.terminal,
    });

    // Patch hook URLs so local Claude instances report to local telemetry
    patchHookUrls(localToken);

    /**
     * Architectural note:
     * - SatelliteClient still owns the command protocol and recovery policy.
     * - FederationSocketClient owns the authenticated socket lifecycle.
     * This keeps the existing behavior intact while making transport concerns
     * testable in isolation.
     */
    this.federation = new FederationSocketClient<SatelliteDownMessage, SatelliteUpMessage>({
      primaryUrl,
      token,
      satelliteId: this.machineId,
      stableConnectionMs: SATELLITE_STABLE_CONNECTION_MS,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 40_000,
      urls: {
        load: () => this.readPersistedPrimaryUrls(),
        save: (urls, activeUrl) => this.persistPrimaryUrls(urls, activeUrl),
        appendHistory: (url) => this.appendPrimaryUrlHistory(url),
      },
      hooks: {
        onOpen: () => {
          console.log(`[satellite] Connected to primary as "${this.machineId}"`);
          this.connectedAt = Date.now();
          this.offlineSince = 0;
          this.selfHealInFlight = false;
          this.send({
            type: "satellite_hello",
            machineId: this.machineId,
            hostname: hostname(),
            platform: platform(),
            capabilities: this.capabilities,
            version: getGitVersion(),
          });
          this.reportWorkers();
          this.replayChatSubscriptions();
        },
        onMessage: (msg) => {
          this.handleMessage(msg).catch((err) => {
            console.log(`[satellite] Error handling ${msg.type}: ${err instanceof Error ? err.message : err}`);
          });
        },
        onDisconnect: async (meta) => this.handleFederationDisconnect(meta),
        onReconnectScheduled: ({ delayMs, nextUrl, rotatedUrl }) => {
          const rotated = rotatedUrl ? " (rotated primary URL)" : "";
          console.log(`[satellite] Disconnected. Reconnecting in ${delayMs / 1000}s via ${nextUrl}${rotated}...`);
        },
        onHeartbeatTimeout: ({ silenceMs }) => {
          console.log(`[satellite] Heartbeat timed out after ${Math.round(silenceMs / 1000)}s without a primary response`);
        },
        onMalformedMessage: (raw) => {
          console.log(`[satellite] Ignoring malformed primary frame: ${raw.slice(0, 120)}`);
        },
        isHeartbeatAck: (msg) => msg.type === "satellite_heartbeat_ack",
        makeHeartbeat: () => ({
          type: "satellite_heartbeat",
          machineId: this.machineId,
          version: getGitVersion(),
          ts: Date.now(),
        }),
      },
    });
  }

  /**
   * Read the persisted primary URL candidates from disk.
   *
   * The transport asks for these on reconnect so tunnel rotation stays
   * transparent to the user. We keep the filesystem access here because the
   * storage location is a Hive policy choice, not a transport concern.
   */
  private readPersistedPrimaryUrls(): string[] {
    const hiveDir = join(homedir(), ".hive");
    const primaryUrlFile = join(hiveDir, "primary-url");
    const urlsFile = join(hiveDir, "primary-urls.txt");
    try {
      return [
        ...(existsSync(primaryUrlFile) ? [readFileSync(primaryUrlFile, "utf-8")] : []),
        ...(existsSync(urlsFile) ? readFileSync(urlsFile, "utf-8").split("\n") : []),
      ].map((value) => value.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Persist the active primary URL and the fallback list.
   *
   * The active URL gets its own file because existing install and recovery
   * flows already read `~/.hive/primary-url` directly.
   */
  private persistPrimaryUrls(urls: string[], activeUrl: string): void {
    const hiveDir = join(homedir(), ".hive");
    try {
      mkdirSync(hiveDir, { recursive: true });
      writeFileSync(join(hiveDir, "primary-url"), `${activeUrl}\n`);
      writeFileSync(join(hiveDir, "primary-urls.txt"), `${urls.join("\n")}\n`);
    } catch {
      // Best-effort persistence keeps the live control path non-blocking.
    }
  }

  /**
   * Append a learned primary URL to the long-lived history file.
   *
   * The live candidate list is capped at 5; this LRU (most-recent-last,
   * capped at 20) keeps every URL the primary ever broadcast so operators
   * and the rotation-exhaustion fallback have something to consult after a
   * long offline window. Separate from primary-urls.txt on purpose: that
   * file is part of the locked rotation pipeline.
   */
  private appendPrimaryUrlHistory(url: string): void {
    const historyPath = join(homedir(), ".hive", "primary-urls-history.txt");
    try {
      const existing = existsSync(historyPath)
        ? readFileSync(historyPath, "utf-8").split("\n").map(l => l.trim()).filter(Boolean)
        : [];
      if (existing[existing.length - 1] === url) return;
      const updated = [...existing.filter(u => u !== url), url].slice(-20);
      writeFileSync(historyPath, `${updated.join("\n")}\n`);
    } catch {
      try { appendFileSync(historyPath, `${url}\n`); } catch { /* best-effort */ }
    }
  }

  /**
   * Re-send full chat history for every active subscription after a
   * reconnect. Incremental satellite_chat frames emitted while the
   * federation socket was down are dropped by design (queueing stale frames
   * is worse), which used to leave a permanent gap in open dashboard tiles
   * until a manual re-subscribe. The full:true replace path is atomic on the
   * dashboard side, so replaying history is gap-free and duplicate-free.
   */
  private replayChatSubscriptions(): void {
    for (const prefixedId of this.chatSubs.keys()) {
      const colonIdx = prefixedId.indexOf(":");
      const localId = colonIdx >= 0 ? prefixedId.slice(colonIdx + 1) : prefixedId;
      try {
        const history = this.streamer.readHistory(localId);
        this.send({ type: "satellite_chat", workerId: prefixedId, messages: history, full: true });
      } catch { /* worker may be gone — the primary will unsubscribe */ }
    }
  }

  start(): void {
    // Start local telemetry server (for hooks from local Claude instances)
    this.telemetry.start();
    this.telemetry.registerProcessManager(this.procMgr);
    this.telemetry.setStreamer(this.streamer);
    this.telemetry.onRemoval((workerId) => this.streamer.clearWorker(workerId));
    this.telemetry.onUpdate(() => this.reportWorkers());

    // Register API proxy routes so local agents can talk to the primary
    this.registerApiProxy();

    // Install CLAUDE.md so local agents know about the Hive API
    this.installClaudeMd();

    // Auto-pilot runs locally on satellite (matching primary)
    this.autoPilot = new AutoPilot(this.telemetry, this.streamer, this.runtimePlatform.terminal);

    // Initial discovery scan
    this.discovery.scan();
    this.telemetry.writeWorkersFile();
    console.log(`[satellite] Machine ID: ${this.machineId}`);
    console.log(`[satellite] Found ${this.telemetry.getAll().length} local agent(s)`);

    // Connect to primary through the dedicated federation transport.
    this.federation.start();

    // Periodic: full tick loop matching primary (discovery, status, auto-pilot)
    this.tickInterval = setInterval(() => {
      this.telemetry.tick();
      this.procMgr.tick();
      this.discovery.scan();
      // Drop the cross-machine peer view when the primary has not refreshed
      // it recently (federation down) so stale peers don't linger in
      // workers.json forever.
      if (this.lastPeerSlotsAt && Date.now() - this.lastPeerSlotsAt > 120_000) {
        this.telemetry.setSatelliteSlots([]);
        this.lastPeerSlotsAt = 0;
      }
      this.telemetry.writeWorkersFile();
      this.autoPilot?.tick();
      this.reportWorkers();
    }, 3_000);
  }

  /**
   * Keep the recovery policy exactly where it used to live while letting the
   * federation transport own raw socket reconnection mechanics.
   */
  private async handleFederationDisconnect(meta: FederationDisconnectMeta): Promise<"reconnect" | "handled"> {
    const now = Date.now();
    if (!this.offlineSince) this.offlineSince = now;
    if (meta.stable) {
      this.consecutiveFailures = 1;
      this.shortLivedConnections = 0;
      this.selfHealAttempts = 0;
    } else {
      this.consecutiveFailures += 1;
      // Only count as short-lived if WS actually opened (local issue).
      // Pure connection failures (WS never opened) = primary unreachable.
      if (meta.wasConnected) {
        this.shortLivedConnections += 1;
      }
    }
    this.connectedAt = 0;

    const action = chooseSatelliteRecoveryAction({
      consecutiveFailures: this.consecutiveFailures,
      shortLivedConnections: this.shortLivedConnections,
      offlineMs: now - this.offlineSince,
      selfHealAttempts: this.selfHealAttempts,
      msSinceLastSelfHeal: this.lastSelfHealAt ? now - this.lastSelfHealAt : Number.POSITIVE_INFINITY,
    });

    if (action !== "none") {
      this.triggerSelfHeal(action).catch((err) => {
        console.log(`[satellite] Self-heal error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return "handled";
    }
    return "reconnect";
  }

  private async triggerSelfHeal(action: "repair" | "reinstall"): Promise<void> {
    if (this.selfHealInFlight) return;
    this.selfHealInFlight = true;
    this.selfHealAttempts += 1;
    this.lastSelfHealAt = Date.now();

    const repoDir = join(import.meta.dirname, "..", "..", "..");
    const logPath = join(homedir(), ".hive", "logs", `satellite-self-heal-${action}.log`);
    const primaryUrlPath = join(homedir(), ".hive", "primary-url");
    const primaryTokenPath = join(homedir(), ".hive", "primary-token");

    const isWindows = process.platform === "win32";
    let selfHealShell: string;
    let selfHealArgs: string[];

    if (isWindows) {
      selfHealShell = "powershell";
      const psCmd = action === "reinstall"
        ? `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`
        : `Set-Location '${repoDir}'; & .\\scripts\\doctor.ps1 --repair-satellite *> '${logPath}'`;
      selfHealArgs = ["-NoProfile", "-Command", psCmd];
    } else {
      selfHealShell = "/bin/zsh";
      const bashCmd = action === "reinstall"
        ? `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && nohup bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1 &`
        : `cd '${repoDir}' && nohup bash scripts/doctor.sh --repair-satellite > '${logPath}' 2>&1 &`;
      selfHealArgs = ["-lc", bashCmd];
    }

    console.log(`[satellite] Self-heal triggered: ${action} (failures=${this.consecutiveFailures}, short=${this.shortLivedConnections})`);
    appendControlPlaneAudit({
      ts: Date.now(),
      type: "maintenance",
      targetMachine: this.machineId,
      action: `self-heal:${action}`,
      ok: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(selfHealShell, selfHealArgs, { timeout: 10_000 }, (err) => err ? reject(err) : resolve());
      });
      setTimeout(() => process.exit(0), 1_000);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`[satellite] Self-heal failed: ${error}`);
      appendControlPlaneAudit({
        ts: Date.now(),
        type: "maintenance",
        targetMachine: this.machineId,
        action: `self-heal:${action}`,
        ok: false,
        error,
      });
      this.selfHealInFlight = false;
      this.federation.scheduleReconnect();
    }
  }

  private send(msg: SatelliteUpMessage): void {
    const sent = this.federation.send(msg);
    if (!sent && (msg.type === "satellite_result" || msg.type === "satellite_context_response")) {
      // Command results dropped during a reconnect window are gone for good
      // (queue-and-replay of control-plane replies is deliberately avoided).
      // Leave an audit trail so a "successful" relay that never produced a
      // result can be diagnosed from the satellite log.
      console.log(`[satellite] Dropped ${msg.type}${msg.requestId ? ` (${msg.requestId})` : ""}: federation socket not open`);
    }
  }

  /** Relay an API request to the primary and wait for the response. */
  private relayToPrimary(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const requestId = `api_${++this.apiRequestId}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingApiRequests.delete(requestId);
        resolve({ error: "Relay timeout" });
      }, 10_000);
      this.pendingApiRequests.set(requestId, { resolve, timer });
      this.send({
        type: "satellite_api_request",
        requestId,
        method,
        path,
        body,
      });
    });
  }

  /** Register API proxy routes on the satellite's local HTTP server.
   *  Local agents call these like normal Hive API  --  the satellite
   *  relays them to the primary via WebSocket.
   *
   *  Uses a catch-all `/api/*` relay so every current and future
   *  primary endpoint works on satellites automatically. Only
   *  `/api/workers` is handled locally (reads from workers.json). */
  registerApiProxy(): void {
    const app = this.telemetry.getApp();
    const auth = this.telemetry.getAuthMiddleware();
    if (!app || !auth) return;

    // GET /api/workers  --  read from workers.json (updated by satellite_all_workers)
    // This is the only route handled locally  --  reading the cached full worker list
    // is faster and works even if the primary WebSocket is momentarily down.
    app.get("/api/workers", auth, (_req: import("express").Request, res: import("express").Response) => {
      try {
        const data = JSON.parse(readFileSync(join(homedir(), ".hive", "workers.json"), "utf-8"));
        res.json(data.workers || []);
      } catch {
        // Fallback: return local workers only
        res.json(this.telemetry.getAll());
      }
    });

    // Catch-all: relay every other /api/* route to the primary daemon.
    // Reconstructs the full URL (path + query string) and forwards the
    // HTTP method + body. New primary endpoints work on satellites
    // with zero additional proxy code.
    app.all(/^\/api\//, auth, async (req: import("express").Request, res: import("express").Response) => {
      const method = req.method;
      // Reconstruct query string
      const qs = Object.entries(req.query as Record<string, string>)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const path = qs ? `${req.path}?${qs}` : req.path;
      const body = method === "GET" || method === "HEAD" ? undefined : req.body;

      try {
        const result = await this.relayToPrimary(method, path, body);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `Relay failed: ${msg.slice(0, 200)}` });
      }
    });

    console.log("[satellite] API proxy registered: /api/workers (local) + catch-all relay for all other /api/* routes");
  }

  /** Install CLAUDE.md with Hive API instructions so local agents know how to
   *  communicate with peers across all machines. */
  private installClaudeMd(): void {
    const claudeDir = join(homedir(), ".claude");
    const claudeMdPath = join(claudeDir, "CLAUDE.md");

    const content = `## Hive  --  Production Agent

You are 1 of several Claude Code agents running simultaneously across multiple computers. Daemon at 127.0.0.1:3001 coordinates status, messaging, and learnings.

### Rules

- NEVER use AskUserQuestion or EnterPlanMode. Make your best guess. Wrong guesses get corrected faster than questions get answered.
- NEVER spawn new Claude instances, terminals, or agents.
- NEVER use the Task tool to launch subagents as a workaround for dispatching.
- Execute directly. Only dispatch to another agent when the task requires their active conversation context.
- **Dispatch rule:** Before sending work to another agent, read your peer summary (shown every prompt) to know which Q is which model, project, and status. Send work to the right agent by checking peers first. Always \`GET /api/workers\` for fresh IDs before dispatching  --  worker IDs change when agents restart.
- Before any task: \`cat {project}/.claude/hive-learnings.md 2>/dev/null\`
- After solving anything non-obvious: write a learning back via the API. This is mandatory.
- Sandbox blocks \`curl\` to localhost. Use \`dangerouslyDisableSandbox: true\` for daemon API calls.
- Read-only status: \`cat ~/.hive/workers.json\`

### Identity

The identity hook outputs your quadrant as a system-reminder each prompt: "You are Q{N} ({tty}, {project})". Quadrants assigned by \`startedAt\` order (earliest = Q1).

### APIs

Daemon: http://127.0.0.1:3001 | Token: \`$(cat ~/.hive/token)\` | Auth header: \`Authorization: Bearer $TOKEN\`

| Endpoint | Purpose |
|---|---|
| \`GET /api/workers\` | List agents (all machines) |
| \`GET /api/context?workerId=X&history=1\` | Worker conversation context |
| \`POST /api/message {workerId, content}\` | Send prompt to agent (any machine) |
| \`GET /api/message-queue\` | View pending messages |
| \`POST /api/queue {task, project?, priority?}\` | Queue task |
| \`GET /api/queue\` | View task queue |
| \`POST /api/locks {workerId, path}\` | Acquire file lock |
| \`GET /api/locks\` | View all locks |
| \`DELETE /api/locks?workerId=X&path=Y\` | Release locks |
| \`GET /api/conflicts?path=X&excludeWorker=Y\` | Check conflicts |
| \`POST /api/scratchpad {key, value, setBy}\` | Shared context (1hr expiry) |
| \`GET /api/scratchpad?key=X\` | Read scratchpad |
| \`GET /api/artifacts?workerId=X\` | File changes by agent |
| \`POST /api/learning {project, lesson}\` | Persist lesson |
| \`POST /api/reviews {summary, url?, type?}\` | Report a reviewable change |
| \`GET /api/reviews\` | Read all reviews |
| \`GET /api/audit\` | Audit log |
| \`GET /api/signals\` | Worker signals |
| \`GET /api/models\` | Available agent models |
| \`GET /api/projects\` | Available projects |
| \`POST /api/exec {command, cwd?, machine?, timeoutMs?}\` | Execute an audited shell command on the local or a remote machine |

### Cross-Machine Communication

All API calls go to \`127.0.0.1:3001\`  --  the local satellite daemon relays them to the primary automatically. You can send messages to agents on ANY machine using their workerId from \`/api/workers\`.

### Self-Unstick

1. Read learnings
2. Check artifacts
3. Try different approach (never retry same thing 3x)
4. If truly stuck, say so  --  human or auto-pilot intervenes
5. After solving: write the learning back
`;

    try {
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      // Only write if missing or outdated (check for our marker)
      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
      if (!existing.includes("Hive  --  Production Agent")) {
        // Prepend Hive instructions to existing CLAUDE.md
        const merged = existing ? content + "\n---\n\n" + existing : content;
        writeFileSync(claudeMdPath, merged);
        console.log("[satellite] Installed CLAUDE.md with Hive API instructions");
      }
    } catch (err) {
      console.log(`[satellite] Failed to install CLAUDE.md: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Report all local workers to the primary with machine tag. */
  private lastReportSnapshot = "";
  private lastReportAt = 0;

  private reportWorkers(): void {
    const workers: WorkerState[] = this.telemetry.getAll().map(w => ({
      ...w,
      machine: this.machineId,
    }));
    // Fingerprint: count + IDs + statuses + actions. Only send when changed
    // OR every 15s as a heartbeat (primary expects activity within 30s).
    const snapshot = workers.map(w => `${w.id}:${w.status}:${w.currentAction || ""}`).sort().join("|");
    const now = Date.now();
    const changed = snapshot !== this.lastReportSnapshot;
    const heartbeatDue = now - this.lastReportAt > 15_000;
    if (!changed && !heartbeatDue) return;
    this.lastReportSnapshot = snapshot;
    this.lastReportAt = now;
    this.send({ type: "satellite_workers", machineId: this.machineId, workers });
  }

  /** Handle a command forwarded from the primary. */
  private async handleMessage(msg: SatelliteDownMessage): Promise<void> {
    switch (msg.type) {
      case "satellite_spawn": {
        const project = (!msg.project || msg.project === "~") ? homedir() : msg.project;
        const model = msg.model || "claude";
        const satHeldTask = msg.pendingTask;
        // Spawn without initial message — held until dashboard approval
        const result = this.runtimePlatform.windows.spawnTerminal(
          project,
          model,
          msg.targetQuadrant,
          undefined,
          this.telemetry.getAll().length,
        );
        if (result.tty) {
          this.telemetry.markSpawn(result.tty);
          // Create spawn placeholder so the dashboard sees the tile immediately
          // (before the 3s discovery scan) and so discovery's placeholder-resolution
          // path forces idle on the real worker  --  matching primary behavior.
          const projectName = project.split("/").pop() || project;
          const normalizedTty = result.tty.replace("/dev/", "");
          const placeholderId = `spawning_${normalizedTty.replace(/\//g, "_")}`;
          this.telemetry.registerDiscovered(placeholderId, {
            id: placeholderId,
            pid: 0,
            project,
            projectName,
            status: "waiting" as const,
            currentAction: "Awaiting approval",
            lastAction: "Spawning terminal",
            lastActionAt: Date.now(),
            errorCount: 0,
            startedAt: Date.now(),
            task: null,
            managed: false,
            tty: result.tty,
            model,
            promptType: "approval",
            promptMessage: "Approve this agent?",
            pendingTask: satHeldTask || null,
          });

          // Match local spawn behavior: poll the new terminal immediately so
          // trust/sandbox prompts and missing-CLI errors surface before the
          // next discovery tick.
          let polls = 0;
          const maxPolls = 13; // ~20 seconds
          const pollTimer = setInterval(() => {
            polls++;
            const current = this.telemetry.get(placeholderId);
            if (!current) {
              clearInterval(pollTimer);
              return;
            }

            const content = this.discovery.readTerminalContent(result.tty!);
            if (content) {
              const tail = content.slice(-500);
              if (tail.match(/command not found|not found:.*(?:claude|codex|openclaw)|No such file or directory/i)) {
                const cliName = model.charAt(0).toUpperCase() + model.slice(1);
                current.status = "idle";
                current.currentAction = `${cliName} CLI not installed`;
                current.lastAction = `${cliName} CLI not installed`;
                current.terminalPreview = `${cliName} is not installed on this machine. Install it first, then try again.`;
                this.telemetry.notifyExternal(current);
                clearInterval(pollTimer);
                setTimeout(() => {
                  const still = this.telemetry.get(placeholderId);
                  if (still && still.pid === 0) {
                    this.telemetry.removeWorker(placeholderId);
                  }
                }, 10_000);
                return;
              }
            }

            const prompt = this.discovery.detectPrompt(result.tty!, { bypassCache: true });
            if (prompt && current.promptType !== "approval") {
              // Only set CLI-detected prompts if the daemon-level approval gate
              // isn't active. The approval gate takes priority — CLI trust/sandbox
              // prompts are handled after the user approves the spawn.
              current.status = "waiting";
              current.promptType = prompt.type;
              current.promptMessage = prompt.message;
              current.currentAction = prompt.message;
              current.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
              this.telemetry.notifyExternal(current);
            }

            if (polls >= maxPolls) {
              clearInterval(pollTimer);
            }
          }, 1500);

          // Auto-remove placeholder after 20s if discovery hasn't replaced it
          setTimeout(() => {
            const still = this.telemetry.get(placeholderId);
            if (still && still.pid === 0) {
              this.telemetry.removeWorker(placeholderId);
            }
          }, 20_000);
        }
        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
          tty: result.tty,
        });
        // Report immediately so primary sees the placeholder
        this.reportWorkers();
        break;
      }

      case "satellite_kill": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found" });
          return;
        }

        // SIGKILL process
        if (worker.pid) {
          try { process.kill(worker.pid, "SIGKILL"); } catch { /* already gone */ }
        }

        // Remove from telemetry
        this.telemetry.removeWorker(localId);

        // Clear session marker
        if (worker.tty) {
          const ttyName = worker.tty.replace("/dev/", "");
          const markerPath = join(homedir(), ".hive", "sessions", ttyName);
          try { unlinkSync(markerPath); } catch { /* already gone */ }

          // Close terminal window
          setTimeout(() => {
            this.runtimePlatform.windows.closeTerminal(worker.tty!);
          }, 500);
        }

        this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        break;
      }

      case "satellite_message": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found or no TTY" });
          return;
        }

        const result = await this.telemetry.sendToWorkerAsync(localId, msg.content || "", {
          source: "dashboard",
          queueIfBusy: false,
          markDashboardInput: true,
        });

        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
        });

        if (result.ok && !result.queued) {
          this.streamer.nudge(localId);
        }
        break;
      }

      case "satellite_selection": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No TTY" });
          return;
        }
        const result = this.runtimePlatform.terminal.sendSelection(worker.tty, msg.optionIndex || 0);
        if (result.ok) {
          worker.status = "working";
          worker.currentAction = "Thinking...";
          worker.lastAction = "User approved from dashboard";
          worker.lastActionAt = Date.now();
          worker.stuckMessage = undefined;
          this.telemetry.notifyExternal(worker);
          this.discovery.suppressPrompt(worker.tty);
        }
        this.send({ type: "satellite_result", requestId: msg.requestId, ok: result.ok, error: result.error });
        break;
      }

      case "satellite_approve": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No TTY" });
          return;
        }
        const wasApprovalGate = worker.promptType === "approval";
        const satPendingTask = worker.pendingTask || null;

        if (wasApprovalGate) {
          // Spawn-approval gate: clear the gate, then handle any CLI prompts
          // before sending the held task.
          worker.promptType = null;
          worker.promptMessage = undefined;
          worker.pendingTask = null;
          worker.status = "idle";
          worker.currentAction = null;
          worker.lastAction = "Approved from dashboard";
          worker.lastActionAt = Date.now();
          this.telemetry.notifyExternal(worker);
          this.discovery.suppressPrompt(worker.tty);

          // Check if Claude is also at a CLI trust/sandbox prompt — dismiss it
          // with Enter before sending the task. Without this, the task text gets
          // dumped into the ink selection UI instead of the chat prompt.
          const cliPrompt = this.discovery.detectPrompt(worker.tty, { bypassCache: true });
          const dismissFirst = !!cliPrompt;

          const sendTask = () => {
            if (satPendingTask) {
              this.telemetry.sendToWorkerAsync(localId, satPendingTask, {
                source: "dashboard",
                queueIfBusy: false,
                markDashboardInput: true,
              }).then((r) => {
                console.log(r.ok ? `Spawn approved + task sent for ${worker.tty}` : `Spawn approved but task send failed: ${r.error}`);
              }).catch(() => {});
            } else {
              console.log(`Spawn approved (no pending task) for ${worker.tty}`);
            }
          };

          if (dismissFirst) {
            // Dismiss CLI prompt first, then wait for Claude to boot before sending task
            this.runtimePlatform.terminal.sendKeystrokeAsync(worker.tty, "enter").then(() => {
              // Wait 5s for Claude to finish booting past trust/sandbox prompts
              setTimeout(sendTask, 5000);
            }).catch(() => sendTask());
          } else {
            sendTask();
          }
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        } else {
          // Legacy trust/sandbox prompt: send Enter keystroke
          const result = this.runtimePlatform.terminal.sendKeystroke(worker.tty, "enter");
          if (result.ok) {
            worker.promptType = null;
            worker.promptMessage = undefined;
            worker.status = "idle";
            worker.currentAction = "Starting...";
            worker.lastAction = "Prompt approved from dashboard";
            worker.lastActionAt = Date.now();
            this.telemetry.notifyExternal(worker);
            this.discovery.suppressPrompt(worker.tty);
          }
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: result.ok, error: result.error });
        }
        break;
      }

      case "satellite_subscribe": {
        const localId = msg.localWorkerId || "";
        const prefixedId = msg.workerId || localId;
        const worker = this.telemetry.get(localId);
        if (!worker) return;

        // Verify session file mapping
        if (worker.tty) {
          this.streamer.verifySessionFile(localId, worker.tty);
        }

        // Send full history
        const history = this.streamer.readHistory(localId);
        this.send({ type: "satellite_chat", workerId: prefixedId, messages: history, full: true });

        // Subscribe for incremental updates
        const subKey = `sat_${prefixedId}`;
        this.chatSubs.set(prefixedId, subKey);
        this.streamer.subscribe(subKey, localId, (entries, full) => {
          this.send({
            type: "satellite_chat",
            workerId: prefixedId,
            messages: entries,
            ...(full ? { full: true } : {}),
          });
        });
        break;
      }

      case "satellite_unsubscribe": {
        const prefixedId = msg.workerId || "";
        const subKey = this.chatSubs.get(prefixedId);
        if (subKey) {
          this.streamer.unsubscribe(subKey);
          this.chatSubs.delete(prefixedId);
        }
        break;
      }

      case "satellite_context": {
        // Primary is requesting worker context (conversation history, status).
        // Read it locally and send back  --  this is what makes cross-machine
        // context queries work transparently.
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found" });
          return;
        }
        const includeHistory = msg.includeHistory === true;
        const historyLimit = typeof msg.historyLimit === "number" ? msg.historyLimit : 6;
        const context = this.telemetry.getWorkerContext(localId, { includeHistory, historyLimit });
        // Also get recent chat entries for richer context
        const chatHistory = includeHistory ? this.streamer.readHistory(localId).slice(-historyLimit) : [];
        this.send({
          type: "satellite_context_response",
          requestId: msg.requestId,
          context,
          chatHistory,
        } as unknown as SatelliteUpMessage);
        break;
      }

      case "satellite_upload": {
        if (!msg.fileName || !msg.dataBase64) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Missing upload payload" });
          return;
        }

        try {
          const upload = storeUploadedFile({
            fileName: msg.fileName,
            mimeType: msg.mimeType,
            dataBase64: msg.dataBase64,
            size: msg.size,
            machine: this.machineId,
          });
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: true,
            upload,
          } as unknown as SatelliteUpMessage);
        } catch (err) {
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: false,
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
        break;
      }

      case "satellite_exec": {
        const command = msg.command || "";
        if (!command.trim()) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Missing command" });
          return;
        }

        const resolved = resolveExecCwd(msg.cwd);
        if (!resolved.cwd) {
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: false,
            error: resolved.error || "Invalid working directory",
            command,
            cwd: msg.cwd,
          } as unknown as SatelliteUpMessage);
          return;
        }

        const result = await runShellExec({
          command,
          cwd: resolved.cwd,
          timeoutMs: msg.timeoutMs,
        });
        appendControlPlaneAudit({
          ts: Date.now(),
          type: "exec",
          targetMachine: this.machineId,
          command,
          cwd: result.cwd,
          ok: result.ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        });
        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ...result,
        } as unknown as SatelliteUpMessage);
        break;
      }

      case "satellite_all_workers": {
        // Primary sends the full merged worker list (local + all satellites).
        // Write to ~/.hive/workers.json so the identity hook on this machine
        // shows cross-machine peers in its peer summary.
        const allWorkers = (msg.workers || []) as Array<{
          quadrant?: number; id?: string; pid?: number; tty?: string;
          project?: string; projectName?: string; status?: string;
          currentAction?: string | null; lastAction?: string; startedAt?: number;
          model?: string; machine?: string; machineLabel?: string;
        }>;
        try {
          const hiveDir = join(homedir(), ".hive");
          if (!existsSync(hiveDir)) mkdirSync(hiveDir, { recursive: true });
          writeFileSync(
            join(hiveDir, "workers.json"),
            JSON.stringify({ updatedAt: Date.now(), workers: allWorkers }, null, 2) + "\n"
          );
        } catch { /* non-critical */ }

        // Feed the cross-machine peers into telemetry so the local 3s tick's
        // writeWorkersFile() MERGES them instead of clobbering workers.json
        // with the local-only list 3 seconds after every primary push (the
        // identity hook's peer summary on satellites depends on this).
        // Two filters protect identity.sh's me-detection:
        // - skip THIS machine's own workers (already in the local list with
        //   local ids — duplicating them shows agents as their own peers)
        // - remap machine "local" (the PRIMARY's workers) to the primary's
        //   label, since "local" means this machine to the local identity
        //   hook and a colliding tty would be mistaken for "me"
        // Peer quadrants are renumbered after the local max so they cannot
        // collide with locally assigned quadrant numbers.
        try {
          const localAll = this.telemetry.getAll();
          const maxLocalSlot = localAll.reduce((max, w) => Math.max(max, w.quadrant || 0), 0);
          let nextPeerSlot = Math.max(maxLocalSlot + 1, localAll.length + 1);
          const peerSlots = allWorkers
            .filter(w => w.id && w.machine !== this.machineId)
            .sort((a, b) => (a.quadrant || 99) - (b.quadrant || 99))
            .map(w => ({
              quadrant: nextPeerSlot++,
              id: w.id!,
              pid: w.pid || 0,
              tty: w.tty,
              project: w.project || w.projectName || "?",
              projectName: w.projectName || "?",
              status: w.status || "idle",
              currentAction: w.currentAction ?? null,
              lastAction: w.lastAction || "",
              startedAt: w.startedAt || Date.now(),
              model: w.model || "claude",
              machine: w.machine === "local" || !w.machine ? (w.machineLabel || "primary") : w.machine,
              machineLabel: w.machineLabel,
            }));
          this.telemetry.setSatelliteSlots(peerSlots);
          this.lastPeerSlotsAt = Date.now();
        } catch { /* non-critical — direct write above still landed */ }

        // Arrange local terminal windows to match primary-assigned quadrants.
        // Extract workers on this machine, map their prefixed IDs back to
        // local workers to get TTYs, then arrange + title them.
        const localWorkers = this.telemetry.getAll();
        const slots: Array<{ quadrant: number; tty: string; projectName: string; model: string }> = [];
        for (const remoteW of allWorkers) {
          if (!remoteW.machine || remoteW.machine !== this.machineId) continue;
          if (!remoteW.quadrant || !remoteW.id) continue;
          // remoteW.id is "machineId:localId"  --  extract localId
          const colonIdx = remoteW.id.indexOf(":");
          const localId = colonIdx >= 0 ? remoteW.id.slice(colonIdx + 1) : remoteW.id;
          const local = localWorkers.find(w => w.id === localId);
          if (local?.tty) {
            slots.push({
              quadrant: remoteW.quadrant,
              tty: local.tty,
              projectName: local.projectName || "agent",
              model: local.model || "claude",
            });
          }
        }
        if (slots.length > 0) {
          // Re-map to local positions: this machine's agents fill its own
          // screen entirely. Sort by global quadrant, then assign local
          // positions 1..N so N agents = N-row full-screen stack.
          slots.sort((a, b) => a.quadrant - b.quadrant);
          const localSlots = slots.map((s, i) => ({ ...s, quadrant: i + 1 }));
          this.runtimePlatform.windows.arrangeWindows(localSlots);
        }
        break;
      }

      case "satellite_primary_url": {
        if (msg.primaryUrl) {
          this.federation.rememberPrimaryUrl(msg.primaryUrl, true);
        }
        break;
      }

      case "satellite_autocommit": {
        const project = msg.project || "";
        const files = msg.files || [];
        const commitMessage = msg.message || "Auto-commit by Hive";

        if (!project || files.length === 0) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No project or files" });
          return;
        }

        // Filter to files that exist on disk
        const existingFiles = files.filter(f => existsSync(f));
        if (existingFiles.length === 0) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No files exist on disk" });
          return;
        }

        // Run git add + commit asynchronously
        try {
          const gitAdd = () => new Promise<void>((resolve, reject) => {
            execFile("git", ["add", ...existingFiles], { cwd: project, timeout: 10_000 },
              (err) => err ? reject(err) : resolve());
          });
          const gitCommit = () => new Promise<string>((resolve, reject) => {
            const shortTask = commitMessage.slice(0, 100);
            const fileNames = existingFiles.map(f => basename(f)).join(", ");
            const fullMsg = `${shortTask}\n\nFiles: ${fileNames}\n\nAuto-committed by Hive (satellite: ${this.machineId}).`;
            execFile("git", ["commit", "-m", fullMsg, "--no-verify"], { cwd: project, timeout: 15_000 },
              (err, stdout) => err ? reject(err) : resolve(stdout));
          });
          const gitHash = () => new Promise<string>((resolve, reject) => {
            execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: project, timeout: 3_000, encoding: "utf-8" },
              (err, stdout) => err ? reject(err) : resolve((stdout || "").trim()));
          });

          await gitAdd();
          await gitCommit();
          const hash = await gitHash();

          console.log(`[satellite-autocommit] Committed ${existingFiles.length} file(s) → ${hash}`);

          // Auto-push to keep repos in sync across machines
          try {
            await new Promise<void>((resolve, reject) => {
              execFile("git", ["push"], { cwd: project, timeout: 30_000 },
                (err) => err ? reject(err) : resolve());
            });
            console.log(`[satellite-autocommit] Pushed to remote`);
          } catch (pushErr) {
            console.log(`[satellite-autocommit] Push failed (commit preserved)  --  ${pushErr instanceof Error ? pushErr.message : pushErr}`);
          }

          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite-autocommit] Failed: ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      case "satellite_api_response": {
        const pending = this.pendingApiRequests.get(msg.requestId || "");
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingApiRequests.delete(msg.requestId || "");
          pending.resolve((msg as unknown as Record<string, unknown>).data);
        }
        break;
      }

      case "satellite_update": {
        // Primary tells us to pull latest code and restart.
        // Hardened flow:
        // 1. Persisted attempt gate breaks the restart→hello→mismatch→update
        //    infinite loop when git pull cannot converge on the primary's
        //    commit (unpushed primary commits, divergent branch).
        // 2. The pre-pull HEAD is recorded so a bad push can be rolled back.
        // 3. Dependencies install with a truthful, long-timeout result, and a
        //    typecheck gate runs BEFORE restarting into the new code; on
        //    failure the repo rolls back and the primary gets ok:false.
        // 4. The supervisor config refresh (install script re-run) happens
        //    detached, matching the satellite_maintenance pattern — running
        //    it synchronously kills this process mid-handler during its
        //    runtime cleanup step.
        console.log("[satellite] Received update command  --  pulling latest code...");
        const repoDir = msg.project || join(import.meta.dirname, "..", "..", "..");
        const updateNow = Date.now();
        const updateState = this.readUpdateState();
        const gate = chooseSatelliteUpdateGate({
          runningVersion: this.runningVersion,
          state: updateState,
          now: updateNow,
        });
        if (!gate.allowed) {
          console.log(`[satellite] ${gate.reason}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: gate.reason });
          break;
        }

        const gitHead = () => new Promise<string>((resolve) => {
          execFile("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoDir, timeout: 5_000, encoding: "utf-8" },
            (err, stdout) => resolve(err ? "unknown" : (stdout || "").trim()));
        });
        const recordStuckAttempt = (): number => {
          const attempts = (updateState?.fromVersion === this.runningVersion ? updateState.attempts : 0) + 1;
          this.writeUpdateState({
            fromVersion: this.runningVersion,
            attempts,
            lastAttemptAt: updateNow,
            failedHead: updateState?.failedHead,
            failedAt: updateState?.failedAt,
          });
          return attempts;
        };

        try {
          const prevHead = await gitHead();
          await new Promise<void>((resolve, reject) => {
            execFile("git", ["pull", "--ff-only"], { cwd: repoDir, timeout: 30_000 },
              (err, stdout) => {
                if (err) reject(err);
                else { console.log(`[satellite] git pull: ${(stdout || "").trim()}`); resolve(); }
              });
          });
          const newHead = await gitHead();

          // Version-stuck guard: the pull landed nothing new while this
          // process already runs that exact commit. Restarting would loop
          // forever (the hello mismatch re-triggers the update), so record
          // the attempt and report loudly instead. Comparing the RUNNING
          // version (captured at process start) to the post-pull HEAD keeps
          // two legitimate restarts working: a repo pulled while this
          // process was stale, and the version="unknown" repair path.
          if (this.runningVersion !== "unknown" && newHead === this.runningVersion) {
            const attempts = recordStuckAttempt();
            const giveUpNote = attempts >= SATELLITE_UPDATE_MAX_ATTEMPTS
              ? " — giving up, manual intervention required (push the primary's commits or fix this satellite's branch)"
              : "";
            const stuck = `version stuck at ${this.runningVersion}: git pull did not change HEAD (attempt ${attempts}/${SATELLITE_UPDATE_MAX_ATTEMPTS})${giveUpNote}. The primary may have unpushed commits or this satellite is on a different branch.`;
            console.log(`[satellite] ${stuck}`);
            this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: stuck });
            break;
          }

          // Per-commit failure memo: a commit that recently failed the
          // validation/install gate is rolled back immediately instead of
          // re-running the expensive gate on every reconnect.
          if (newHead !== "unknown" && isRecentlyFailedHead(updateState, newHead, updateNow)) {
            await this.rollbackRepo(repoDir, prevHead);
            const memoMsg = `commit ${newHead} recently failed the update validation gate — rolled back to ${prevHead}, will retry after cooldown`;
            console.log(`[satellite] ${memoMsg}`);
            this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: memoMsg });
            break;
          }

          // Install dependencies directly (not via install.sh — its runtime
          // cleanup kills this process). 10-minute timeout covers a cold npm
          // cache; failure is treated as FAILURE, because restarting into
          // code whose dependencies did not install bricks the satellite
          // under the supervisor's restart loop.
          const installResult = await this.runDependencyInstall(repoDir);
          if (!installResult.ok) {
            await this.rollbackRepo(repoDir, prevHead);
            await this.runDependencyInstall(repoDir); // best-effort: restore old lockfile's deps
            this.recordFailedHead(updateState, newHead, updateNow);
            const errMsg = `update aborted, rolled back to ${prevHead}: ${installResult.error}`;
            console.log(`[satellite] ${errMsg}`);
            this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
            break;
          }

          // Validation gate: typecheck the pulled code BEFORE restarting into
          // it. A startup-crashing push otherwise puts every satellite into a
          // supervisor crash loop simultaneously, and the self-heal mechanism
          // lives inside the crashing process.
          const validation = await this.validatePulledCode(repoDir);
          if (!validation.ok) {
            await this.rollbackRepo(repoDir, prevHead);
            this.recordFailedHead(updateState, newHead, updateNow);
            const errMsg = `update rejected, rolled back to ${prevHead}: ${validation.error}`;
            console.log(`[satellite] ${errMsg}`);
            this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
            break;
          }

          // Update converged and validated — clear the attempt state.
          this.clearUpdateState();

          // Re-run install script to update process supervisor config
          // (batch file restart loop, Task Scheduler triggers, launchd
          // plist). Detached on unix because install.sh's cleanup step kills
          // this process; the result is reported before spawning it.
          const primaryUrlPath = join(homedir(), ".hive", "primary-url");
          const primaryTokenPath = join(homedir(), ".hive", "primary-token");
          const logPath = join(homedir(), ".hive", "logs", "satellite-update.log");
          const isWindows = process.platform === "win32";

          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });

          if (isWindows) {
            const psCmd = `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`;
            await new Promise<void>((resolve) => {
              execFile("powershell", ["-NoProfile", "-Command", psCmd],
                { timeout: 600_000 }, (err) => {
                  if (err) console.log(`[satellite] install.ps1 re-run warning: ${err.message.slice(0, 100)}`);
                  else console.log("[satellite] install.ps1 re-run complete");
                  resolve(); // config refresh is best-effort — code is already validated
                });
            });
          } else {
            const bashCmd = `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && nohup bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1 &`;
            const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
            await new Promise<void>((resolve) => {
              execFile(shell, ["-lc", bashCmd],
                { timeout: 10_000 }, (err) => {
                  if (err) console.log(`[satellite] install.sh re-run spawn warning: ${err.message.slice(0, 100)}`);
                  else console.log("[satellite] install.sh re-run started (detached)");
                  resolve();
                });
            });
          }
          // Ensure the launchd plist is loaded before exiting so the supervisor
          // can restart us. Without this, process.exit(0) is a one-way trip if
          // the plist was unloaded or the install script re-run failed.
          if (process.platform === "darwin") {
            const plistPath = join(homedir(), "Library", "LaunchAgents", "com.hive.satellite.plist");
            if (existsSync(plistPath)) {
              const uid = process.getuid?.() ?? 501;
              try {
                execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { timeout: 5000 });
                console.log("[satellite] Ensured launchd plist is bootstrapped");
              } catch {
                try {
                  execFileSync("launchctl", ["load", "-w", plistPath], { timeout: 5000 });
                  console.log("[satellite] Ensured launchd plist is loaded (legacy)");
                } catch { /* already loaded — fine */ }
              }
            }
          } else if (process.platform === "win32") {
            // On Windows, ensure the restart-loop bat is running before we exit.
            // If we were started manually (not via the bat), process.exit would be
            // a one-way trip. Start the bat in the background so it takes over.
            const batPath = join(homedir(), ".hive", "satellite.bat");
            if (existsSync(batPath)) {
              try {
                // Check if the bat is already running (another cmd.exe with satellite.bat)
                const check = execFileSync("powershell", ["-NoProfile", "-Command",
                  `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%satellite.bat%'" | Where-Object { $_.ProcessId -ne $PID } | Select-Object -First 1 | ForEach-Object { $_.ProcessId }`
                ], { encoding: "utf-8", timeout: 5000 }).trim();
                if (!check) {
                  // Not running — start it so it restarts us after we exit
                  execFileSync("cmd.exe", ["/c", "start", "/min", "", batPath], { timeout: 5000 });
                  console.log("[satellite] Started restart-loop bat for Windows auto-restart");
                } else {
                  console.log("[satellite] Restart-loop bat already running (pid " + check + ")");
                }
              } catch {
                // Best effort — if this fails, the identity hook will restart on next Claude open
                console.log("[satellite] Could not verify restart-loop bat — identity hook will recover");
              }
            }
          } else if (process.platform === "linux") {
            // On Linux, try starting the systemd service if it exists
            try {
              execFileSync("systemctl", ["--user", "start", "hive-satellite"], { timeout: 5000 });
              console.log("[satellite] Ensured systemd service is started");
            } catch { /* not using systemd or already running */ }
          }
          console.log("[satellite] Restarting in 2 seconds...");
          setTimeout(() => process.exit(0), 2000);
        } catch (err) {
          // git pull (or another pre-validation step) failed. Record the
          // attempt so repeated hello-triggered updates back off instead of
          // re-running a doomed pull every reconnect.
          const attempts = recordStuckAttempt();
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite] Update failed (attempt ${attempts}/${SATELLITE_UPDATE_MAX_ATTEMPTS}): ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      case "satellite_maintenance": {
        const repoDir = join(import.meta.dirname, "..", "..", "..");
        const action = msg.action === "repair" || msg.action === "reinstall" ? msg.action : "repair";
        const logPath = join(homedir(), ".hive", "logs", action === "reinstall" ? "satellite-reinstall.log" : "satellite-repair.log");
        const primaryUrlPath = join(homedir(), ".hive", "primary-url");
        const primaryTokenPath = join(homedir(), ".hive", "primary-token");

        const isWindows = process.platform === "win32";
        let detachedCommand: string;
        let shell: string;
        let shellArgs: string[];

        if (isWindows) {
          shell = "powershell";
          if (action === "reinstall") {
            // Read URL/token from files, then run install script
            detachedCommand = `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; git pull --ff-only; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`;
          } else {
            detachedCommand = `Set-Location '${repoDir}'; & .\\scripts\\doctor.ps1 --repair-satellite *> '${logPath}'`;
          }
          shellArgs = ["-NoProfile", "-Command", detachedCommand];
        } else {
          shell = "/bin/zsh";
          if (action === "reinstall") {
            detachedCommand = `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && git pull --ff-only && nohup bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1 &`;
          } else {
            detachedCommand = `cd '${repoDir}' && nohup bash scripts/doctor.sh --repair-satellite > '${logPath}' 2>&1 &`;
          }
          shellArgs = ["-lc", detachedCommand];
        }

        console.log(`[satellite] Received maintenance command  --  action=${action}`);

        try {
          await new Promise<void>((resolve, reject) => {
            execFile(shell, shellArgs, { timeout: 10_000 }, (err) => err ? reject(err) : resolve());
          });
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: true,
            action,
            logPath,
          } as unknown as SatelliteUpMessage);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite] Maintenance failed: ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      // Ignore messages meant for dashboard clients (workers, auth, etc.)
      default:
        break;
    }
  }

  // ── satellite_update support ──────────────────────────────────────────

  private readUpdateState(): SatelliteUpdateAttemptState | null {
    try {
      const raw = readFileSync(join(homedir(), ".hive", "update-state.json"), "utf-8");
      const parsed = JSON.parse(raw) as SatelliteUpdateAttemptState;
      if (typeof parsed?.fromVersion === "string" && typeof parsed?.attempts === "number") {
        return parsed;
      }
    } catch { /* missing or corrupt — treat as no prior attempts */ }
    return null;
  }

  private writeUpdateState(state: SatelliteUpdateAttemptState): void {
    try {
      const hiveDir = join(homedir(), ".hive");
      mkdirSync(hiveDir, { recursive: true });
      writeFileSync(join(hiveDir, "update-state.json"), JSON.stringify(state, null, 2) + "\n");
    } catch { /* best-effort — worst case the gate just never engages */ }
  }

  private clearUpdateState(): void {
    try { unlinkSync(join(homedir(), ".hive", "update-state.json")); } catch { /* absent */ }
  }

  /** Remember that a pulled commit failed the validation/install gate so the
   *  next satellite_update within the cooldown skips the expensive re-run. */
  private recordFailedHead(prev: SatelliteUpdateAttemptState | null, head: string, now: number): void {
    this.writeUpdateState({
      fromVersion: prev?.fromVersion ?? this.runningVersion,
      attempts: prev?.fromVersion === this.runningVersion ? prev.attempts : 0,
      lastAttemptAt: prev?.fromVersion === this.runningVersion ? prev.lastAttemptAt : 0,
      failedHead: head,
      failedAt: now,
    });
  }

  /** Roll the repo back to a known-good commit after a failed update.
   *  Uses `git reset --keep` (not --hard) so intentional uncommitted local
   *  changes survive. If --keep refuses (a dirty file differs between the
   *  commits), the tree is left as pulled — the running process is still on
   *  the old code either way, but a supervisor restart would boot the
   *  unvalidated code, so the refusal is logged loudly. */
  private rollbackRepo(repoDir: string, head: string): Promise<boolean> {
    if (!head || head === "unknown") return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile("git", ["reset", "--keep", head], { cwd: repoDir, timeout: 15_000 }, (err) => {
        if (err) {
          console.log(`[satellite] Rollback to ${head} FAILED (${err.message.slice(0, 120)}) — tree left as pulled; a supervisor restart would boot unvalidated code`);
          resolve(false);
        } else {
          console.log(`[satellite] Rolled back repo to ${head}`);
          resolve(true);
        }
      });
    });
  }

  /** npm install with a cold-cache-sized timeout and a truthful result. */
  private runDependencyInstall(repoDir: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      execFile("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoDir, timeout: 600_000 }, (err, _stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed === true;
          const detail = killed ? "timed out after 600s" : (stderr || err.message).slice(0, 300);
          resolve({ ok: false, error: `npm install failed: ${detail}` });
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  /** Typecheck the pulled code before restarting into it.
   *
   *  tsx happily runs type-bad code, so this gate is stricter than the
   *  runtime strictly needs — a real type error gets reported upstream as
   *  ok:false with the first errors attached, instead of every satellite
   *  crash-looping under its supervisor at the same time.
   *
   *  Infrastructure failures (npx/tsc missing, timeout) FAIL OPEN with a
   *  loud log: a broken validator must never be able to freeze the whole
   *  fleet on old code. */
  private validatePulledCode(repoDir: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const npx = process.platform === "win32" ? "npx.cmd" : "npx";
      execFile(npx, ["tsc", "--noEmit"], {
        cwd: join(repoDir, "apps", "daemon"),
        timeout: 180_000,
        encoding: "utf-8",
      }, (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true }); return; }
        const output = `${stdout || ""}\n${stderr || ""}`;
        if (/error TS\d+/.test(output)) {
          const firstErrors = output
            .split("\n")
            .filter((line) => line.includes("error TS"))
            .slice(0, 5)
            .join(" | ");
          resolve({ ok: false, error: `typecheck failed: ${firstErrors.slice(0, 400)}` });
          return;
        }
        const killed = (err as { killed?: boolean }).killed === true;
        const spawnFailed = (err as NodeJS.ErrnoException).code === "ENOENT";
        const why = spawnFailed ? "npx not found" : killed ? "timed out" : err.message.slice(0, 120);
        console.log(`[satellite] Update validation gate could not run (${why}) — proceeding WITHOUT validation`);
        resolve({ ok: true });
      });
    });
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.federation.stop();

    // Clean up pending API requests to prevent memory leaks and phantom rejections.
    for (const [id, entry] of this.pendingApiRequests) {
      clearTimeout(entry.timer);
      entry.resolve(null);
      this.pendingApiRequests.delete(id);
    }
  }
}
