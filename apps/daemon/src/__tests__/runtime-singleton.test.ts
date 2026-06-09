import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { acquireRuntimeSingleton } from "../runtime-singleton.js";

describe("acquireRuntimeSingleton", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims and releases a new runtime lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.claim.release();

    const second = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(second.ok).toBe(true);
  });

  it("replaces a stale lock file automatically", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);

    writeFileSync(join(dir, "satellite.json"), JSON.stringify({
      role: "satellite",
      pid: 999999,
      acquiredAt: Date.now() - 60_000,
      cwd: "/tmp/stale",
    }) + "\n");

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
  });

  it("refuses to claim a live lock owned by another process", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });

    try {
      writeFileSync(join(dir, "satellite.json"), JSON.stringify({
        role: "satellite",
        pid: child.pid,
        acquiredAt: Date.now(),
        cwd: "/tmp/live",
      }) + "\n");

      const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.conflict.metadata?.pid).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("leaves a live lock file untouched after a failed acquisition", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });

    try {
      const lockPath = join(dir, "daemon.json");
      const original = JSON.stringify({
        role: "daemon",
        pid: child.pid,
        acquiredAt: Date.now(),
        cwd: "/tmp/live",
      }) + "\n";
      writeFileSync(lockPath, original);

      const result = acquireRuntimeSingleton("daemon", { baseDir: dir });
      expect(result.ok).toBe(false);
      // The losing claimant must never delete or replace the live lock.
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf-8")).toBe(original);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("acquires despite leftover aside files from a crashed takeover", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);

    // A crashed claimant can leave a renamed-aside stale lock behind. It must
    // never be read as the lock itself.
    writeFileSync(join(dir, "satellite.json.stale-424242-0"), JSON.stringify({
      role: "satellite",
      pid: 999999,
      acquiredAt: Date.now() - 120_000,
      cwd: "/tmp/crashed",
    }) + "\n");

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.metadata.pid).toBe(process.pid);
  });

  it("takes over a stale lock and records its own metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);
    const lockPath = join(dir, "satellite.json");

    writeFileSync(lockPath, JSON.stringify({
      role: "satellite",
      pid: 999999,
      acquiredAt: Date.now() - 60_000,
      cwd: "/tmp/stale",
    }) + "\n");

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const onDisk = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.role).toBe("satellite");
  });
});
