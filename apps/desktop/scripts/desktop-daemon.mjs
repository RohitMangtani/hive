// Desktop fresh-mode daemon entry. Mirrors the primary-mode wiring of
// apps/daemon/src/index.ts exactly (same constructor args, same tick set).
// Deliberate differences from index.ts, and nothing else:
//   - ports come from HIVE_DAEMON_PORT / HIVE_WS_PORT (smoke tests use 3411/3412)
//   - patchHookUrls only runs on the canonical port 3001 (hook URLs hardcode it)
//   - modules load from the staged dist/ inside the bundled runtime
// When index.ts wiring changes, this file must change with it.
import { execFile } from "child_process";
import { platform as osPlatform } from "os";

const runtimeRoot = process.env.HIVE_RUNTIME_ROOT;
if (!runtimeRoot) {
  throw new Error("HIVE_RUNTIME_ROOT is required.");
}

const daemonPort = Number(process.env.HIVE_DAEMON_PORT || 3001);
const wsPort = Number(process.env.HIVE_WS_PORT || 3002);

const { TelemetryReceiver } = await import(new URL("../hive/apps/daemon/dist/telemetry.js", import.meta.url));
const { ProcessManager } = await import(new URL("../hive/apps/daemon/dist/process-mgr.js", import.meta.url));
const { SessionStreamer } = await import(new URL("../hive/apps/daemon/dist/session-stream.js", import.meta.url));
const { WsServer } = await import(new URL("../hive/apps/daemon/dist/ws-server.js", import.meta.url));
const { ProcessDiscovery } = await import(new URL("../hive/apps/daemon/dist/discovery.js", import.meta.url));
const { AutoPilot } = await import(new URL("../hive/apps/daemon/dist/auto-pilot.js", import.meta.url));
const { StateStore } = await import(new URL("../hive/apps/daemon/dist/state-store.js", import.meta.url));
const { NotificationManager } = await import(new URL("../hive/apps/daemon/dist/notifications.js", import.meta.url));
const { WebPushManager } = await import(new URL("../hive/apps/daemon/dist/web-push.js", import.meta.url));
const { Collector } = await import(new URL("../hive/apps/daemon/dist/collector.js", import.meta.url));
const { OutboxScanner } = await import(new URL("../hive/apps/daemon/dist/outbox.js", import.meta.url));
const { loadOrCreateToken, deriveViewerToken, patchHookUrls } = await import(new URL("../hive/apps/daemon/dist/auth.js", import.meta.url));
const { acquireRuntimeSingleton } = await import(new URL("../hive/apps/daemon/dist/runtime-singleton.js", import.meta.url));
const { loadPlatform } = await import(new URL("../hive/apps/daemon/dist/platform/index.js", import.meta.url));
const { TunnelHealthMonitor } = await import(new URL("../hive/apps/daemon/dist/tunnel-health.js", import.meta.url));
const { UserRegistry } = await import(new URL("../hive/apps/daemon/dist/user-registry.js", import.meta.url));
const { ReplayManager } = await import(new URL("../hive/apps/daemon/dist/replay.js", import.meta.url));
const { RevertHistory } = await import(new URL("../hive/apps/daemon/dist/revert-history.js", import.meta.url));
const { DeviceLayer } = await import(new URL("../hive/apps/daemon/dist/devices/index.js", import.meta.url));
const { detectAndWriteMachineManifest } = await import(new URL("../hive/apps/daemon/dist/detect-capabilities.js", import.meta.url));

if (osPlatform() === "darwin") {
  // Probe Automation permission early -- macOS shows the approval dialog on first
  // use, so we trigger it at startup rather than waiting for the user to click X.
  execFile("/usr/bin/osascript", ["-e",
    'tell application "Terminal" to get name of first window'
  ], { timeout: 5000 }, () => { /* result doesn't matter -- the dialog is the point */ });
}

const token = loadOrCreateToken();
const viewerToken = deriveViewerToken(token);
if (daemonPort === 3001) {
  patchHookUrls(token);
}
const platform = loadPlatform();
const userRegistry = new UserRegistry();
const daemonLock = acquireRuntimeSingleton("daemon");
if (!daemonLock.ok) {
  const owner = daemonLock.conflict.metadata;
  const ownerText = owner ? `PID ${owner.pid}` : "another process";
  console.log(`[desktop-daemon] Runtime already owned by ${ownerText}. Exiting duplicate instance.`);
  process.exit(0);
}

// Write machine capabilities to ~/.hive/machine.json on primary startup
detectAndWriteMachineManifest();

const tunnelHealth = new TunnelHealthMonitor();
const replayManager = new ReplayManager();
const telemetry = new TelemetryReceiver(daemonPort, token, {
  terminal: platform.terminal,
  windows: platform.windows,
  userRegistry,
  replayManager,
});
const revertHistory = new RevertHistory();
telemetry.setRevertHook((payload) => revertHistory.add(payload));
const procMgr = new ProcessManager(telemetry);
const streamer = new SessionStreamer();
const ws = new WsServer(telemetry, procMgr, streamer, wsPort, token, viewerToken, userRegistry, replayManager, {
  terminal: platform.terminal,
  windows: platform.windows,
});
const discovery = new ProcessDiscovery(telemetry, streamer, {
  discovery: platform.discovery,
  terminal: platform.terminal,
});
const pushMgr = new WebPushManager();
const notifications = new NotificationManager();
notifications.setPushManager(pushMgr);
ws.setDiscovery(discovery);
ws.setPushManager(pushMgr);
ws.setRevertHistory(revertHistory);
const autoPilot = new AutoPilot(telemetry, streamer, platform.terminal);
const collector = new Collector();
const outbox = new OutboxScanner(telemetry);
const stateStore = new StateStore();

// Device layer (sensors, cameras, actuators -- parallel to workers)
const devices = new DeviceLayer();
ws.setDeviceLayer(devices);

telemetry.start();
telemetry.registerProcessManager(procMgr);
telemetry.registerApi(procMgr, discovery, revertHistory);
telemetry.registerCollector(collector);
telemetry.setStreamer(streamer);
telemetry.onRemoval((workerId) => streamer.clearWorker(workerId));

// Mount device routes on the Express app
const expressApp = telemetry.getApp();
const authMiddleware = telemetry.getAuthMiddleware();
if (expressApp && authMiddleware) {
  devices.registerRoutes(expressApp, authMiddleware);
}

// Bridge device events -> agent task queue (when events warrant analysis)
devices.setTaskBridge((event) => {
  console.log(`[devices] Event from ${event.deviceId}: ${event.summary}`);
});

ws.start();

// Restore state from previous daemon run (if fresh enough)
const snapshot = StateStore.load();
if (snapshot) {
  telemetry.importState(snapshot);
  // Pre-seed discovery so restored workers go through the existing-worker
  // path on the first scan. Without this, discovery treats them as "new"
  // and overwrites clean imported state with stale JSONL analysis.
  discovery.seedFromImport(snapshot.workers.map((w) => w.pid));
}

// Register push notifications on stuck transitions (local workers)
notifications.register(telemetry);

// Register push notifications for satellite workers (working->idle, stuck)
ws.onSatelliteStatusChange((workerId, worker, prevStatus) => {
  notifications.handleSatelliteStatusChange(workerId, worker, prevStatus);
});

// Initial scan for existing Claude processes
discovery.scan();
console.log(`Hive desktop daemon running on ${daemonPort}/${wsPort}.`);
console.log(`  Found ${telemetry.getAll().length} existing Claude instance(s)`);

// Periodic: status updates + re-scan for new/dead processes + auto-respond
const interval = setInterval(() => {
  telemetry.tick();
  procMgr.tick();
  discovery.scan();
  telemetry.writeWorkersFile();
  ws.pushState();
  autoPilot.tick();
  collector.tick();
  outbox.tick();
  devices.tick();
  tunnelHealth.tick();
}, 3_000);

// Write initial workers file immediately after first scan
telemetry.writeWorkersFile();

// Start periodic state snapshots (every 30s, separate from the 3s tick)
stateStore.startPeriodicSave(() => telemetry.exportState());

const shutdown = () => {
  clearInterval(interval);
  daemonLock.claim.release();
  stateStore.save();
  stateStore.stop();
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 2000);
};

process.on("exit", daemonLock.claim.release);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
