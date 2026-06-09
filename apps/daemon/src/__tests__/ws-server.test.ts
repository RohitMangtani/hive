import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { WsServer } from "../ws-server.js";

const LOCAL_HOSTNAME = hostname();

type RemovalHandler = () => void;
type UpdateHandler = (workerId: string, worker: unknown) => void;

function createServer(initialWorkers: unknown[] = []) {
  let workers = initialWorkers;
  let removalHandler: RemovalHandler | null = null;
  let updateHandler: UpdateHandler | null = null;
  const getWorkerContextAsync = vi.fn(async (workerId: string) => ({
    workerId,
    model: "claude",
    project: "/tmp/demo",
    projectName: "demo",
    status: "idle",
    currentAction: null,
    lastAction: "Session ended",
    recentArtifacts: [],
    recentMessages: [{ role: "user", text: "Read /tmp/msg.md and follow it exactly." }],
    contextSummary: "demo context",
  }));

  const telemetry = {
    onUpdate(handler: UpdateHandler) {
      updateHandler = handler;
    },
    onRemoval(handler: RemovalHandler) {
      removalHandler = handler;
    },
    onReviewAdded() {
      // no-op for tests
    },
    setSatelliteRelay() {},
    setPrimaryRebuildFn() {},
    setSatelliteInfoGetter() {},
    setCapabilityRouter() {},
    setSatelliteContextRelay() {},
    setSwarmApi() {},
    onAutoCommit() {},
    onFullBroadcast() {},
    setScratchpad() {},
    setSatelliteSlots() {},
    getWorkerContextAsync,
    getAll() {
      return workers;
    },
    get(workerId: string) {
      return (workers as Array<{ id: string }>).find((worker) => worker.id === workerId) || null;
    },
    getReviews() {
      return [];
    },
    sendToWorkerAsync: vi.fn(async () => ({ ok: true, queued: false })),
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

  // Inert stubs: real UserRegistry/ReplayManager constructors touch ~/.hive.
  const userRegistry = {
    authenticate: vi.fn(() => null),
    getAll: vi.fn(() => []),
    createUser: vi.fn((name: string, role: string) => ({
      id: "u_test",
      name,
      role,
      token: "created-token",
      createdAt: 0,
    })),
    removeUser: vi.fn(() => false),
  };
  const replayManager = {
    list: vi.fn(() => []),
    record: vi.fn(),
  } as never;

  const server = new WsServer(
    telemetry as never,
    procMgr as never,
    streamer as never,
    3002,
    "token",
    "viewer-token",
    userRegistry as never,
    replayManager
  ) as unknown as {
    clients: Set<{ readyState: number; send: (data: string) => void }>;
    pushState: () => void;
  };

  return {
    server,
    getWorkerContextAsync,
    telemetry,
    streamer,
    userRegistry,
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
    // Register a fake dashboard socket the way start() does on connection:
    // tagged in connectedUsers, plus readOnlyClients when the role is viewer.
    connectAs(role: "admin" | "operator" | "viewer" | "voice") {
      const ws = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const internals = server as unknown as {
        connectedUsers: Map<WebSocket, unknown>;
        readOnlyClients: Set<WebSocket>;
      };
      internals.connectedUsers.set(ws, {
        id: `u_${role}`,
        name: role,
        role,
        token: `${role}-token`,
        createdAt: 0,
      });
      if (role === "viewer") internals.readOnlyClients.add(ws);
      return ws;
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

    harness.server.pushState();  // sends workers + models (first call)
    harness.server.pushState();  // no change  --  skips both
    harness.setWorkers([{ id: "w1", status: "working" }]);
    harness.server.pushState();  // sends workers (changed), skips models (same)

    // Filter to workers broadcasts only (pushState also sends models on first call)
    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(2);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle", machineLabel: LOCAL_HOSTNAME }],
    });
    expect(workersCalls[1]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "working", machineLabel: LOCAL_HOSTNAME }],
    });
  });

  it("does not rebroadcast the same removal snapshot on the next tick", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.triggerRemoval();
    harness.server.pushState();

    // triggerRemoval sends workers once, pushState skips workers (same snapshot)
    // but pushState sends models on first call (lastModelsSnapshot starts null)
    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle", machineLabel: LOCAL_HOSTNAME }],
    });
  });

  it("blocks mutating messages from read-only clients but still allows list", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
      readOnlyClients: Set<WebSocket>;
    };
    const viewerWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.readOnlyClients.add(viewerWs);
    server.handleMessage(viewerWs, { type: "spawn", model: "claude", project: "~" });
    server.handleMessage(viewerWs, { type: "list" });

    const sent = (viewerWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent[0]).toEqual({ type: "error", error: "Read-only access" });
    expect(sent[1]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle" }],
    });
  });

  it("allows read-only clients to request worker context", async () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
      readOnlyClients: Set<WebSocket>;
    };
    const viewerWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.readOnlyClients.add(viewerWs);
    server.handleMessage(viewerWs, { type: "worker_context", workerId: "w1", includeHistory: true, historyLimit: 8 });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.getWorkerContextAsync).toHaveBeenCalledWith("w1", {
      includeHistory: true,
      historyLimit: 8,
    });
    const sent = (viewerWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toContainEqual({
      type: "worker_context",
      workerId: "w1",
      context: expect.objectContaining({
        workerId: "w1",
        contextSummary: "demo context",
      }),
    });
  });

  it("rejects malformed privileged ws payloads before handling them", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
    };
    // Registered as admin: privileged types pass the role gate and reach
    // the field validators.
    const adminWs = harness.connectAs("admin");

    server.handleMessage(adminWs, { type: "spawn", model: "claude;rm", project: "~" });
    server.handleMessage(adminWs, { type: "kill", workerId: "../bad-worker" });
    server.handleMessage(adminWs, {
      type: "upload_file",
      workerId: "w1",
      requestId: "bad id",
      fileName: "notes.txt",
      dataBase64: Buffer.from("hello", "utf-8").toString("base64"),
    });

    const sent = (adminWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toEqual([
      { type: "error", error: "Invalid model" },
      { type: "error", error: "Invalid workerId" },
      { type: "error", error: "Invalid requestId" },
    ]);
  });

  it("stores uploaded files for a local worker and returns the machine-local path", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-ws-upload-"));
    vi.stubEnv("HOME", home);
    try {
      const harness = createServer([{
        id: "w1",
        status: "idle",
        tty: "ttys001",
        project: "/tmp/demo",
        projectName: "demo",
      }]);
      const server = harness.server as unknown as {
        handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
      };
      const client = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const payload = Buffer.from("hello from phone\n", "utf-8");

      server.handleMessage(client, {
        type: "upload_file",
        requestId: "req_1",
        workerId: "w1",
        fileName: "notes?.txt",
        mimeType: "text/plain",
        size: payload.length,
        dataBase64: payload.toString("base64"),
      });

      const sent = (client.send as unknown as { mock: { calls: [string][] } }).mock.calls
        .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
      expect(sent).toContainEqual(expect.objectContaining({
        type: "upload_result",
        requestId: "req_1",
        workerId: "w1",
        ok: true,
        upload: expect.objectContaining({
          name: "notes-.txt",
          mimeType: "text/plain",
          size: payload.length,
        }),
      }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
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

  it("buffers satellite workers until satellite_hello arrives", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      pushState: () => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "working",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        currentAction: "Thinking...",
        quadrant: 1,
      }],
    });
  });

  it("acks satellite heartbeats without polluting dashboard state", () => {
    const harness = createServer([]);
    const server = harness.server as unknown as {
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_heartbeat",
      ts: 12345,
    });

    const sent = (satelliteWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toContainEqual({
      type: "satellite_heartbeat_ack",
      ts: 12345,
    });
  });

  it("ignores heartbeats from a superseded satellite connection", () => {
    const harness = createServer([]);
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
    };
    const satelliteWs1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const satelliteWs2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs1, "remote-mac");
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });

    server.registerSatelliteSocket(satelliteWs2, "remote-mac");
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });

    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_heartbeat",
      ts: 111,
    });
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_heartbeat",
      ts: 222,
    });

    const staleSent = (satelliteWs1.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    const activeSent = (satelliteWs2.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);

    expect(staleSent).not.toContainEqual({
      type: "satellite_heartbeat_ack",
      ts: 111,
    });
    expect(activeSent).toContainEqual({
      type: "satellite_heartbeat_ack",
      ts: 222,
    });
  });

  it("ignores close from a superseded satellite connection", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      handleSatelliteDisconnect: (ws: WebSocket, machineId: string) => void;
      pushState: () => void;
    };
    const satelliteWs1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const satelliteWs2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs1, "remote-mac");
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });

    server.registerSatelliteSocket(satelliteWs2, "remote-mac");
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });

    expect(satelliteWs1.close).toHaveBeenCalledTimes(1);

    server.handleSatelliteDisconnect(satelliteWs1, "remote-mac");
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "idle",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        quadrant: 1,
      }],
    });
  });

  it("ignores worker reports from a superseded satellite connection", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      pushState: () => void;
    };
    const satelliteWs1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const satelliteWs2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs1, "remote-mac");
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "working", model: "claude", currentAction: "Thinking..." }],
    });

    server.registerSatelliteSocket(satelliteWs2, "remote-mac");
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude", lastAction: "Session ended" }],
    });

    // Old socket can still deliver a late report before the TCP close lands.
    // That stale snapshot must not overwrite the active connection's state.
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "working", model: "claude", currentAction: "Thinking..." }],
    });
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "idle",
        model: "claude",
        lastAction: "Session ended",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        quadrant: 1,
      }],
    });
  });

  it("keeps satellite workers visible when the old socket closes before the new hello", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      handleSatelliteDisconnect: (ws: WebSocket, machineId: string) => void;
      pushState: () => void;
    };
    const satelliteWs1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const satelliteWs2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs1, "remote-mac");
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });

    server.registerSatelliteSocket(satelliteWs2, "remote-mac");
    expect(satelliteWs1.close).toHaveBeenCalledTimes(1);

    server.handleSatelliteDisconnect(satelliteWs1, "remote-mac");
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "working",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        currentAction: "Thinking...",
        quadrant: 1,
      }],
    });
  });

  it("lets satellite workers turn idle after two idle reports", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      pushState: () => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs, "remote-mac");
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "working", model: "claude", currentAction: "Running tests" }],
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "idle",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        quadrant: 1,
      }],
    });
  });

  it("treats satellite session-end idle as definitive on the first report", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      pushState: () => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs, "remote-mac");
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "working", model: "claude", currentAction: "Thinking..." }],
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude", lastAction: "Session ended" }],
    });
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "idle",
        model: "claude",
        lastAction: "Session ended",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        quadrant: 1,
      }],
    });
  });

  it("merges satellite chat history into relayed context", async () => {
    const harness = createServer([]);
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      requestSatelliteContext: (
        sat: { ws: WebSocket; machineId: string; hostname: string; workers: unknown[]; connectedAt: number; lastSeen: number },
        workerId: string,
        localId: string,
        options: { includeHistory?: boolean; historyLimit?: number },
      ) => Promise<unknown>;
      satellites: Map<string, { ws: WebSocket; machineId: string; hostname: string; workers: unknown[]; connectedAt: number; lastSeen: number }>;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs, "remote-mac");
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });

    const sat = server.satellites.get("remote-mac");
    expect(sat).toBeTruthy();

    const pending = server.requestSatelliteContext(
      sat!,
      "remote-mac:rw1",
      "rw1",
      { includeHistory: true, historyLimit: 4 },
    );

    const sent = (satelliteWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>)
      .find((msg) => msg.type === "satellite_context");
    expect(sent).toBeTruthy();
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_context_response",
      requestId: sent!.requestId,
      context: {
        workerId: "remote-mac:rw1",
        status: "working",
        recentMessages: [],
      },
      chatHistory: [
        { role: "assistant", content: "remote reply" },
      ],
    });

    await expect(pending).resolves.toEqual({
      workerId: "remote-mac:rw1",
      status: "working",
      recentMessages: [
        { role: "assistant", content: "remote reply" },
      ],
    });
  });

  it("routes exec requests to the active satellite and waits for the result", async () => {
    const auditHome = mkdtempSync(join(tmpdir(), "hive-audit-"));
    const previousHiveHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = auditHome;

    const harness = createServer([]);
    const server = harness.server as unknown as {
      handleApiRelay: (method: string, path: string, body: Record<string, unknown> | undefined, fromMachine: string) => Promise<Record<string, unknown>>;
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    try {
      server.registerSatelliteSocket(satelliteWs, "remote-mac");
      server.handleSatelliteMessage(satelliteWs, "remote-mac", {
        type: "satellite_hello",
        hostname: "Remote-Mac.local",
        version: "test",
        capabilities: {
          projects: {
            hive: "/Users/rohitmangtani/hive",
          },
        },
      });

      const pending = server.handleApiRelay("POST", "/api/exec", {
        machine: "remote-mac",
        cwd: "hive",
        command: "pwd",
      }, "local");

      const sentCalls = (satelliteWs.send as unknown as { mock: { calls: [string][] } }).mock.calls;
      const execCall = sentCalls
        .map(([raw]) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === "satellite_exec");
      expect(execCall).toBeTruthy();
      const sentPayload = execCall!;
      expect(sentPayload).toMatchObject({
        type: "satellite_exec",
        command: "pwd",
        cwd: "/Users/rohitmangtani/hive",
      });

      server.handleSatelliteMessage(satelliteWs, "remote-mac", {
        type: "satellite_result",
        requestId: sentPayload.requestId,
        ok: true,
        cwd: "/Users/rohitmangtani/hive",
        stdout: "/Users/rohitmangtani/hive\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 9,
      });

      await expect(pending).resolves.toEqual({
        ok: true,
        machine: "remote-mac",
        command: "pwd",
        cwd: "/Users/rohitmangtani/hive",
        stdout: "/Users/rohitmangtani/hive\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 9,
      });
    } finally {
      if (previousHiveHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHiveHome;
      }
      rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("does not leak the primary home directory into remote exec when cwd is omitted", async () => {
    const harness = createServer([]);
    const server = harness.server as unknown as {
      handleApiRelay: (method: string, path: string, body: Record<string, unknown> | undefined, fromMachine: string) => Promise<Record<string, unknown>>;
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs, "remote-mac");
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });

    const pending = server.handleApiRelay("POST", "/api/exec", {
      machine: "remote-mac",
      command: "pwd",
    }, "local");

    const sentCalls = (satelliteWs.send as unknown as { mock: { calls: [string][] } }).mock.calls;
    const execCall = sentCalls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>)
      .find((msg) => msg.type === "satellite_exec");
    expect(execCall).toBeTruthy();
    expect(execCall).not.toHaveProperty("cwd");

    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_result",
      requestId: execCall!.requestId,
      ok: true,
      cwd: "/Users/rohitmangtani",
      stdout: "/Users/rohitmangtani\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 6,
    });

    await expect(pending).resolves.toEqual({
      ok: true,
      machine: "remote-mac",
      command: "pwd",
      cwd: "/Users/rohitmangtani",
      stdout: "/Users/rohitmangtani\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 6,
    });
  });
});

describe("WsServer admin gating", () => {
  // Mirrors REST's requireAdmin routes (api-routes.ts): spawn, kill, revert,
  // review deletion, user management.
  const adminOnlyMessages: Record<string, unknown>[] = [
    { type: "spawn", model: "claude", project: "~" },
    { type: "kill", workerId: "w1" },
    { type: "revert", revertId: "r1", revertConfirmation: "abc1234" },
    { type: "review_dismiss", reviewId: "rev1" },
    { type: "review_clear_all" },
    { type: "user_list" },
    { type: "user_create", userName: "mallory", userRole: "admin" },
    { type: "user_remove", userId: "u_admin" },
  ];

  it("rejects privileged messages from operator tokens with an error frame", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
    };
    const operatorWs = harness.connectAs("operator");

    for (const msg of adminOnlyMessages) {
      server.handleMessage(operatorWs, msg);
    }

    const sent = (operatorWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toEqual(
      adminOnlyMessages.map(() => ({ type: "error", error: "Admin access required" })),
    );
    // The handlers must never run for non-admins.
    expect(harness.userRegistry.getAll).not.toHaveBeenCalled();
    expect(harness.userRegistry.createUser).not.toHaveBeenCalled();
    expect(harness.userRegistry.removeUser).not.toHaveBeenCalled();
  });

  it("blocks voice tokens from swarm control but still lets them message agents", async () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
    };
    const voiceWs = harness.connectAs("voice");

    server.handleMessage(voiceWs, { type: "spawn", model: "claude", project: "~" });
    server.handleMessage(voiceWs, { type: "kill", workerId: "w1" });
    server.handleMessage(voiceWs, { type: "revert", revertId: "r1", revertConfirmation: "abc1234" });
    server.handleMessage(voiceWs, { type: "message", workerId: "w1", content: "status update please" });
    await Promise.resolve();
    await Promise.resolve();

    const sent = (voiceWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toEqual([
      { type: "error", error: "Admin access required" },
      { type: "error", error: "Admin access required" },
      { type: "error", error: "Admin access required" },
    ]);
    expect(harness.telemetry.sendToWorkerAsync).toHaveBeenCalledWith(
      "w1",
      "status update please",
      expect.objectContaining({ source: "dashboard" }),
    );
    expect(harness.streamer.nudge).toHaveBeenCalledWith("w1");
  });

  it("lets admin tokens through the gate to the real handlers", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
    };
    const adminWs = harness.connectAs("admin");

    // Each privileged type passes the role gate and reaches its handler:
    // kill hits handler validation, revert hits the unwired-history guard,
    // user_list hits the registry.
    server.handleMessage(adminWs, { type: "kill" });
    server.handleMessage(adminWs, { type: "revert", revertId: "r1", revertConfirmation: "abc1234" });
    server.handleMessage(adminWs, { type: "user_list" });

    const sent = (adminWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toEqual([
      { type: "error", error: "Missing workerId" },
      { type: "error", error: "Revert history not available" },
      { type: "user_list", users: [] },
    ]);
    expect(harness.userRegistry.getAll).toHaveBeenCalledTimes(1);
  });

  it("keeps registered viewers on the read-only error, not the admin error", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const server = harness.server as unknown as {
      handleMessage: (ws: WebSocket, msg: Record<string, unknown>) => void;
    };
    const viewerWs = harness.connectAs("viewer");

    server.handleMessage(viewerWs, { type: "spawn", model: "claude", project: "~" });
    server.handleMessage(viewerWs, { type: "list" });

    const sent = (viewerWs.send as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent[0]).toEqual({ type: "error", error: "Read-only access" });
    expect(sent[1]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle" }],
    });
  });
});
