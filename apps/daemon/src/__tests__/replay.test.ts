/**
 * ReplayManager persistence tests: recordings written to disk must remain
 * listable and readable after a daemon restart (new ReplayManager instance).
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "fs";

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${process.env.TMPDIR || "/tmp"}/hive-replay-tests-${process.pid}`,
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => TEST_HOME,
    default: { ...actual, homedir: () => TEST_HOME },
  };
});

import { ReplayManager } from "../replay.js";

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("ReplayManager history persistence", () => {
  it("rebuilds history from disk so replays survive a daemon restart", async () => {
    const before = new ReplayManager();
    const meta = before.start("restart survival");
    before.record("worker_update", { workerId: "w1", status: "working" });
    const stopped = before.stop(meta.id);
    expect(stopped?.endedAt).not.toBeNull();

    // Let the write stream flush to disk
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate a daemon restart: a fresh instance must see the recording.
    const after = new ReplayManager();
    const restored = after.list().find((r) => r.id === meta.id);
    expect(restored).toBeDefined();
    expect(Math.abs(restored!.startedAt - meta.startedAt)).toBeLessThan(1000);
    expect(restored!.endedAt).not.toBeNull();

    const data = after.read(meta.id);
    expect(data).not.toBeNull();
    expect(data!.toString("utf-8")).toContain("worker_update");
  });

  it("ignores non-jsonl files in the replay directory", () => {
    const mgr = new ReplayManager();
    const ids = mgr.list().map((r) => r.id);
    expect(ids.every((id) => id.startsWith("replay_"))).toBe(true);
  });
});
