import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { WsServer } from "./ws-server.js";

const telemetry = new TelemetryReceiver(3001);
const procMgr = new ProcessManager(telemetry);
const ws = new WsServer(telemetry, procMgr, 3002);

telemetry.start();
ws.start();

// Periodic status updates
setInterval(() => {
  telemetry.tick();
  procMgr.tick();
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
