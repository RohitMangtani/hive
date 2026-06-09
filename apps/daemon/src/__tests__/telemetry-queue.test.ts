/**
 * Message queue tests: drainQueues starvation/failure-cap behavior and
 * queued-message field preservation across all enqueue sites.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryReceiver } from "../telemetry.js";
import type { WorkerState } from "../types.js";

const { writeFileSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}));
const { sendInputToTty } = vi.hoisted(() => ({
  sendInputToTty: vi.fn((..._args: unknown[]) => ({ ok: true })),
}));
const { execFileSync, execFile } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync,
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock("../tty-input.js", () => ({
  sendInputToTty,
  sendInputToTtyAsync: vi.fn(() => Promise.resolve({ ok: true })),
  isSendInFlight: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execFileSync,
  execFile,
}));

function makeWorker(id: string, tty: string, status: WorkerState["status"] = "idle", managed = false): WorkerState {
  return {
    id,
    pid: 100 + Number(tty.slice(-1)),
    project: "/tmp/project",
    projectName: "project",
    status,
    currentAction: null,
    lastAction: "Waiting",
    lastActionAt: Date.now(),
    errorCount: 0,
    startedAt: 1,
    task: null,
    managed,
    tty: managed ? undefined : tty,
    model: "claude",
  };
}

type QueueMap = Map<string, Array<Record<string, unknown>>>;

function getQueue(telemetry: TelemetryReceiver, workerId: string): Array<Record<string, unknown>> {
  const queues = (telemetry as unknown as { messageQueue: QueueMap }).messageQueue;
  return queues.get(workerId) || [];
}

function drain(telemetry: TelemetryReceiver): void {
  (telemetry as unknown as { drainQueues: () => void }).drainQueues();
}

describe("drainQueues", () => {
  let telemetry: TelemetryReceiver;

  beforeEach(() => {
    writeFileSync.mockClear();
    sendInputToTty.mockClear();
    sendInputToTty.mockImplementation((..._args: unknown[]) => ({ ok: true }));
    telemetry = new TelemetryReceiver(3001, "token");
    telemetry.registerDiscovered("w_a", makeWorker("w_a", "ttys001"));
    telemetry.registerDiscovered("w_b", makeWorker("w_b", "ttys002"));
  });

  it("continues to the next worker's queue when the head queue fails (no head-of-line starvation)", () => {
    sendInputToTty.mockImplementation((...args: unknown[]) => {
      const tty = args[0] as string;
      return tty === "ttys001" ? { ok: false, error: "Automation permission denied" } : { ok: true };
    });

    telemetry.enqueueMessage("w_a", { content: "to A", source: "test" });
    telemetry.enqueueMessage("w_b", { content: "to B", source: "test" });

    drain(telemetry);

    // A's send failed and was re-queued; B's message still drained this tick.
    expect(getQueue(telemetry, "w_a")).toHaveLength(1);
    expect(getQueue(telemetry, "w_b")).toHaveLength(0);
    const ttysTried = sendInputToTty.mock.calls.map((c) => c[0]);
    expect(ttysTried).toContain("ttys001");
    expect(ttysTried).toContain("ttys002");
  });

  it("drops a message after repeated drain failures instead of retrying forever", () => {
    sendInputToTty.mockImplementation((..._args: unknown[]) => ({ ok: false, error: "tab gone" }));
    telemetry.enqueueMessage("w_a", { content: "doomed", source: "test" });

    for (let i = 0; i < 4; i++) {
      drain(telemetry);
      expect(getQueue(telemetry, "w_a")).toHaveLength(1);
    }
    expect(getQueue(telemetry, "w_a")[0].failures).toBe(4);

    drain(telemetry); // 5th failure hits the cap
    expect(getQueue(telemetry, "w_a")).toHaveLength(0);
  });

  it("sends at most one successful message per tick", () => {
    telemetry.enqueueMessage("w_a", { content: "to A", source: "test" });
    telemetry.enqueueMessage("w_b", { content: "to B", source: "test" });

    drain(telemetry);

    expect(getQueue(telemetry, "w_a")).toHaveLength(0);
    expect(getQueue(telemetry, "w_b")).toHaveLength(1);
  });
});

describe("queued message field preservation (toQueuedMessage)", () => {
  let telemetry: TelemetryReceiver;

  beforeEach(() => {
    sendInputToTty.mockClear();
    sendInputToTty.mockImplementation((..._args: unknown[]) => ({ ok: true }));
    telemetry = new TelemetryReceiver(3001, "token");
  });

  const dispatchOptions = {
    source: "test",
    verify: true,
    maxVerifyAttempts: 3,
    autoCommit: true,
    taskId: "t1",
    workflowId: "wf1",
  };

  it("sync busy path keeps verify, maxVerifyAttempts and autoCommit", () => {
    telemetry.registerDiscovered("w_busy", makeWorker("w_busy", "ttys003", "working"));
    const result = telemetry.sendToWorker("w_busy", "do the thing", dispatchOptions);
    expect(result.ok).toBe(true);
    expect((result as { queued?: boolean }).queued).toBe(true);

    const [queued] = getQueue(telemetry, "w_busy");
    expect(queued.verify).toBe(true);
    expect(queued.maxVerifyAttempts).toBe(3);
    expect(queued.autoCommit).toBe(true);
    expect(queued.taskId).toBe("t1");
    expect(queued.workflowId).toBe("wf1");
  });

  it("async busy path keeps verify, maxVerifyAttempts and autoCommit", async () => {
    telemetry.registerDiscovered("w_busy2", makeWorker("w_busy2", "ttys004", "working"));
    const result = await telemetry.sendToWorkerAsync("w_busy2", "do the thing", dispatchOptions);
    expect(result.ok).toBe(true);
    expect((result as { queued?: boolean }).queued).toBe(true);

    const [queued] = getQueue(telemetry, "w_busy2");
    expect(queued.verify).toBe(true);
    expect(queued.maxVerifyAttempts).toBe(3);
    expect(queued.autoCommit).toBe(true);
  });

  it("managed busy path keeps verify, maxVerifyAttempts and autoCommit", () => {
    telemetry.registerDiscovered("w_managed", makeWorker("w_managed", "ttys005", "idle", true));
    telemetry.registerProcessManager({
      sendMessage: () => ({ status: "busy" }),
    } as never);

    const result = telemetry.sendToWorker("w_managed", "do the thing", dispatchOptions);
    expect(result.ok).toBe(true);
    expect((result as { queued?: boolean }).queued).toBe(true);

    const [queued] = getQueue(telemetry, "w_managed");
    expect(queued.verify).toBe(true);
    expect(queued.maxVerifyAttempts).toBe(3);
    expect(queued.autoCommit).toBe(true);
  });
});
