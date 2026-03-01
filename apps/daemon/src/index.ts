import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { WsServer } from "./ws-server.js";
import { ProcessDiscovery } from "./discovery.js";

const telemetry = new TelemetryReceiver(3001);
const procMgr = new ProcessManager(telemetry);
const ws = new WsServer(telemetry, procMgr, 3002);
const discovery = new ProcessDiscovery(telemetry);

telemetry.start();
ws.start();

// Initial scan for existing Claude processes
discovery.scan();
console.log(`  Found ${telemetry.getAll().length} existing Claude instance(s)`);

// Periodic: status updates + re-scan for new/dead processes
setInterval(() => {
  telemetry.tick();
  procMgr.tick();
  discovery.scan();
}, 10_000);

console.log("Hive daemon running.");
console.log("  Telemetry: http://localhost:3001");
console.log("  WebSocket: ws://localhost:3002");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 2000);
});
