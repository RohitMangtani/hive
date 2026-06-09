import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { FederationSocketClient, type FederationSocketLike } from "../federation-socket.js";

class FakeSocket extends EventEmitter implements FederationSocketLike {
  readyState: number = WebSocket.CONNECTING;
  readonly url: string;
  readonly send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  readonly close = vi.fn(() => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  readonly terminate = vi.fn(() => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  readonly sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  pushMessage(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", raw);
  }
}

function createHarness() {
  const sockets: FakeSocket[] = [];
  const save = vi.fn();
  const appendHistory = vi.fn();
  const onOpen = vi.fn();
  const onMessage = vi.fn();
  const onDisconnect = vi.fn((): "reconnect" | "handled" => "handled");
  const onReconnectScheduled = vi.fn();
  const onHeartbeatTimeout = vi.fn();
  const onMalformedMessage = vi.fn();

  const client = new FederationSocketClient<{ type?: string }, { type: string }>({
    primaryUrl: "https://primary.example/hive",
    token: "secret token",
    satelliteId: "remote-mac",
    stableConnectionMs: 60_000,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 2_500,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    urls: {
      load: () => ["wss://primary.example/hive", "wss://backup.example/hive"],
      save,
      appendHistory,
    },
    hooks: {
      onOpen,
      onMessage,
      onDisconnect,
      onReconnectScheduled,
      onHeartbeatTimeout,
      onMalformedMessage,
      isHeartbeatAck: (message) => message.type === "satellite_heartbeat_ack",
      makeHeartbeat: () => ({ type: "satellite_heartbeat" }),
    },
  });

  return {
    client,
    sockets,
    save,
    appendHistory,
    onOpen,
    onMessage,
    onDisconnect,
    onReconnectScheduled,
    onHeartbeatTimeout,
    onMalformedMessage,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FederationSocketClient", () => {
  it("builds an authenticated websocket URL from the configured primary URL", () => {
    const harness = createHarness();

    harness.client.start();

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]!.url).toBe(
      "wss://primary.example/hive?token=secret%20token&satellite=remote-mac",
    );
  });

  it("sends heartbeat frames and swallows heartbeat acknowledgements", () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    harness.sockets[0]!.open();

    vi.advanceTimersByTime(1_000);
    expect(harness.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "satellite_heartbeat" }));

    harness.sockets[0]!.pushMessage({ type: "satellite_heartbeat_ack" });
    expect(harness.onMessage).not.toHaveBeenCalled();
  });

  it("rotates to the next primary URL after an unstable disconnect", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.onDisconnect.mockReturnValue("reconnect");

    harness.client.start();
    harness.sockets[0]!.open();
    harness.sockets[0]!.close();
    await Promise.resolve();

    expect(harness.onReconnectScheduled).toHaveBeenCalledWith({
      nextUrl: "wss://backup.example/hive",
      delayMs: 1_000,
      rotatedUrl: true,
    });

    vi.advanceTimersByTime(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1]!.url).toBe(
      "wss://backup.example/hive?token=secret%20token&satellite=remote-mac",
    );
  });

  it("terminates stale sockets when heartbeat acknowledgements stop arriving", () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    harness.sockets[0]!.open();
    vi.advanceTimersByTime(3_000);

    expect(harness.onHeartbeatTimeout).toHaveBeenCalledWith({
      url: "wss://primary.example/hive",
      silenceMs: 3_000,
    });
    expect(harness.sockets[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(harness.onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "heartbeat-timeout",
      stable: false,
      url: "wss://primary.example/hive",
    }));
  });

  it("reports whether a frame was actually handed to an open socket", () => {
    const harness = createHarness();

    expect(harness.client.send({ type: "satellite_result" })).toBe(false);

    harness.client.start();
    // Socket exists but is still CONNECTING — the frame would be dropped.
    expect(harness.client.send({ type: "satellite_result" })).toBe(false);

    harness.sockets[0]!.open();
    expect(harness.client.send({ type: "satellite_result" })).toBe(true);
    expect(harness.sockets[0]!.sent).toContain(JSON.stringify({ type: "satellite_result" }));
  });

  it("terminates a socket stuck in CONNECTING once the connect timeout fires", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.onDisconnect.mockReturnValue("reconnect");

    harness.client.start();
    expect(harness.sockets).toHaveLength(1);

    // The dial never completes. Without the connect timer nothing would ever
    // fire here (the heartbeat watchdog only starts on "open").
    vi.advanceTimersByTime(15_000);

    expect(harness.sockets[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(harness.onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      wasConnected: false,
      stable: false,
    }));
  });

  it("clears the connect timer once the socket opens", () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    harness.sockets[0]!.open();
    // Advance past the connect timeout while keeping the heartbeat fed so
    // the only timer that could kill the socket is the (cleared) connect one.
    for (let i = 0; i < 16; i++) {
      vi.advanceTimersByTime(1_000);
      harness.sockets[0]!.pushMessage({ type: "satellite_heartbeat_ack" });
    }

    expect(harness.sockets[0]!.terminate).not.toHaveBeenCalled();
    // Still connected: heartbeats were sent rather than the socket dying.
    expect(harness.sockets[0]!.sent.length).toBeGreaterThan(0);
  });

  it("appends every learned primary URL to the history store", () => {
    const harness = createHarness();

    harness.client.rememberPrimaryUrl("https://fresh.example/hive", true);

    expect(harness.appendHistory).toHaveBeenCalledWith("wss://primary.example/hive");
    expect(harness.appendHistory).toHaveBeenCalledWith("wss://fresh.example/hive");
  });

  it("retries the install-time URL after a full failed rotation evicted it from the candidates", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stored: string[] = [];
    const client = new FederationSocketClient<{ type?: string }, { type: string }>({
      primaryUrl: "https://install.example/hive",
      token: "t",
      satelliteId: "sat",
      stableConnectionMs: 60_000,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 2_500,
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      urls: {
        load: () => [...stored],
        save: (urls) => {
          stored.length = 0;
          stored.push(...urls);
        },
      },
      hooks: {
        onOpen: vi.fn(),
        onMessage: vi.fn(),
        onDisconnect: vi.fn((): "reconnect" | "handled" => "reconnect"),
        makeHeartbeat: () => ({ type: "satellite_heartbeat" }),
      },
    });

    // Five primary-broadcast URLs evict the install URL from the capped list.
    for (const url of ["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example", "wss://e.example"]) {
      client.rememberPrimaryUrl(url, true);
    }
    expect(stored).not.toContain("wss://install.example/hive");

    client.start();
    // Fail one full rotation through all five candidates plus one extra
    // attempt — that triggers the exhaustion fallback.
    let delay = 1_000;
    for (let i = 0; i < 6; i++) {
      sockets[sockets.length - 1]!.close();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    const lastDial = sockets[sockets.length - 1]!.url;
    expect(lastDial.startsWith("wss://install.example/hive?")).toBe(true);
  });

  it.todo("verifies federation transport interoperates with the live ws-server heartbeat ack flow");
  it.todo("verifies reconnect resume after a failed satellite self-heal against a real daemon instance");
});
