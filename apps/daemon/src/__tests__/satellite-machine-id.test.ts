import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir, hostname } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMachineId } from "../satellite.js";

describe("resolveMachineId", () => {
  let hiveDir: string;

  beforeEach(() => {
    hiveDir = mkdtempSync(join(tmpdir(), "hive-machine-id-"));
  });

  afterEach(() => {
    rmSync(hiveDir, { recursive: true, force: true });
  });

  it("generates hostname plus a random suffix and persists it", () => {
    const id = resolveMachineId(hiveDir);

    // Routing constraints: [a-z0-9-] only (worker ids split on the first
    // colon, and the id is embedded in the WS auth URL).
    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/);
    expect(id).not.toContain(":");
    // Suffix appended AFTER the 24-char hostname truncation.
    expect(id.length).toBeLessThanOrEqual(29);

    const base = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "satellite";
    expect(id.startsWith(`${base}-`)).toBe(true);

    expect(readFileSync(join(hiveDir, "machine-id"), "utf-8").trim()).toBe(id);
  });

  it("reuses the persisted id forever", () => {
    const first = resolveMachineId(hiveDir);
    const second = resolveMachineId(hiveDir);
    expect(second).toBe(first);
  });

  it("accepts a pre-existing bare-hostname id from older installs unchanged", () => {
    writeFileSync(join(hiveDir, "machine-id"), "macbook-air\n");
    expect(resolveMachineId(hiveDir)).toBe("macbook-air");
  });

  it("sanitizes a corrupted persisted id instead of breaking worker routing", () => {
    writeFileSync(join(hiveDir, "machine-id"), "Mac:Book Air!!\n");
    const id = resolveMachineId(hiveDir);
    expect(id).toBe("macbookair");
    expect(id).not.toContain(":");
  });

  it("regenerates when the persisted file is empty", () => {
    writeFileSync(join(hiveDir, "machine-id"), "\n");
    const id = resolveMachineId(hiveDir);
    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/);
  });

  it("creates the hive dir when missing", () => {
    const nested = join(hiveDir, "does", "not", "exist");
    mkdirSync(join(hiveDir, "does"), { recursive: true });
    const id = resolveMachineId(nested);
    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/);
    expect(readFileSync(join(nested, "machine-id"), "utf-8").trim()).toBe(id);
  });
});
