import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { SessionStreamer } from "./session-stream.js";
import { WsServer } from "./ws-server.js";
import { ProcessDiscovery } from "./discovery.js";
import { AutoPilot } from "./auto-pilot.js";
import { Watchdog } from "./watchdog.js";
import { loadOrCreateToken, deriveViewerToken, patchHookUrls } from "./auth.js";

const token = loadOrCreateToken();
const viewerToken = deriveViewerToken(token);
patchHookUrls(token);

const telemetry = new TelemetryReceiver(3001, token);
const procMgr = new ProcessManager(telemetry);
const streamer = new SessionStreamer();
const ws = new WsServer(telemetry, procMgr, streamer, 3002, token, viewerToken);
const discovery = new ProcessDiscovery(telemetry, streamer);
const autoPilot = new AutoPilot(telemetry, streamer);
const watchdog = new Watchdog(telemetry);

telemetry.start();
telemetry.registerProcessManager(procMgr);
telemetry.registerApi(procMgr, discovery);
ws.start();

// Initial scan for existing Claude processes
discovery.scan();
console.log(`  Found ${telemetry.getAll().length} existing Claude instance(s)`);

// Periodic: status updates + re-scan for new/dead processes + auto-respond
setInterval(() => {
  telemetry.tick();
  procMgr.tick();
  discovery.scan();
  telemetry.writeWorkersFile();
  autoPilot.tick();
  watchdog.tick();
}, 3_000);

// Write initial workers file immediately after first scan
telemetry.writeWorkersFile();

console.log("Hive daemon running.");
console.log("  Token: ~/.hive/token");
console.log("  Telemetry: http://127.0.0.1:3001");
console.log("  WebSocket: ws://127.0.0.1:3002");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 2000);
});
