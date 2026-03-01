import { WebSocketServer, WebSocket } from "ws";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { DaemonMessage, DaemonResponse } from "./types.js";

export class WsServer {
  private wss: WebSocketServer | null = null;
  private telemetry: TelemetryReceiver;
  private procMgr: ProcessManager;
  private port: number;
  private clients = new Set<WebSocket>();

  constructor(
    telemetry: TelemetryReceiver,
    procMgr: ProcessManager,
    port: number
  ) {
    this.telemetry = telemetry;
    this.procMgr = procMgr;
    this.port = port;

    this.telemetry.onUpdate((workerId, worker) => {
      this.broadcast({
        type: "worker_update",
        worker,
        workerId,
      });
    });

    this.procMgr.setOutputHandler((workerId, data) => {
      this.broadcast({
        type: "chat",
        workerId,
        content: data,
      });
    });
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    console.log(`  WebSocket server listening on port ${this.port}`);

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      // Send workers list immediately on connect — no auth needed
      this.send(ws, { type: "workers", workers: this.telemetry.getAll() });

      ws.on("message", (raw) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.send(ws, { type: "error", error: "Invalid JSON" });
          return;
        }
        this.handleMessage(ws, msg);
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });
  }

  private handleMessage(ws: WebSocket, msg: DaemonMessage): void {
    switch (msg.type) {
      case "spawn": {
        if (!msg.project) {
          this.send(ws, { type: "error", error: "Missing project path" });
          return;
        }
        const workerId = this.procMgr.spawn(msg.project, msg.task || null);
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        console.log(`Spawned worker ${workerId} for ${msg.project}`);
        break;
      }

      case "kill": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }
        this.procMgr.kill(msg.workerId);
        console.log(`Killed worker ${msg.workerId}`);
        break;
      }

      case "message": {
        if (!msg.workerId || !msg.content) {
          this.send(ws, {
            type: "error",
            error: "Missing workerId or content",
          });
          return;
        }
        const sent = this.procMgr.sendMessage(msg.workerId, msg.content);
        if (!sent) {
          this.send(ws, {
            type: "error",
            error: `Worker ${msg.workerId} not found or stdin not writable`,
          });
        }
        break;
      }

      case "list": {
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        break;
      }

      case "orchestrator": {
        this.send(ws, {
          type: "orchestrator",
          content: "Orchestrator not yet implemented",
        });
        break;
      }

      default:
        this.send(ws, { type: "error", error: "Unknown message type" });
    }
  }

  private send(ws: WebSocket, response: DaemonResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private broadcast(response: DaemonResponse): void {
    const data = JSON.stringify(response);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}
