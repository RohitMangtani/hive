import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WsServer } from "../ws-server.js";

type RemovalHandler = () => void;
type UpdateHandler = (workerId: string, worker: unknown) => void;

function createServer(initialWorkers: unknown[] = []) {
  let workers = initialWorkers;
  let removalHandler: RemovalHandler | null = null;
  let updateHandler: UpdateHandler | null = null;

  const telemetry = {
    onUpdate(handler: UpdateHandler) {
      updateHandler = handler;
    },
    onRemoval(handler: RemovalHandler) {
      removalHandler = handler;
    },
    getAll() {
      return workers;
    },
  };

  const procMgr = {
    setOutputHandler: vi.fn(),
  };

  const streamer = {
    unsubscribe: vi.fn(),
    readHistory: vi.fn(() => []),
    subscribe: vi.fn(),
    nudge: vi.fn(),
  };

  const server = new WsServer(
    telemetry as never,
    procMgr as never,
    streamer as never,
    3002,
    "token",
    "viewer-token"
  ) as unknown as {
    clients: Set<{ readyState: number; send: (data: string) => void }>;
    pushState: () => void;
  };

  return {
    server,
    setWorkers(nextWorkers: unknown[]) {
      workers = nextWorkers;
    },
    addClient() {
      const client = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      };
      server.clients.add(client);
      return client;
    },
    triggerRemoval() {
      removalHandler?.();
    },
    triggerUpdate(workerId: string, worker: unknown) {
      updateHandler?.(workerId, worker);
    },
  };
}

describe("WsServer pushState", () => {
  it("broadcasts workers only when the snapshot changes", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.server.pushState();
    harness.server.pushState();
    harness.setWorkers([{ id: "w1", status: "working" }]);
    harness.server.pushState();

    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "workers",
        workers: [{ id: "w1", status: "idle" }],
      })
    );
    expect(client.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: "workers",
        workers: [{ id: "w1", status: "working" }],
      })
    );
  });

  it("does not rebroadcast the same removal snapshot on the next tick", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.triggerRemoval();
    harness.server.pushState();

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "workers",
        workers: [{ id: "w1", status: "idle" }],
      })
    );
  });

  it("keeps immediate worker_update broadcasts unchanged", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.triggerUpdate("w1", { id: "w1", status: "working" });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.send.mock.calls[0]![0] as string)).toEqual({
      type: "worker_update",
      workerId: "w1",
      worker: { id: "w1", status: "working" },
    });
  });
});
