import { describe, it, expect, beforeEach, vi } from "vitest";
import { Scratchpad } from "../scratchpad.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "[]"),
  writeFileSync: vi.fn(),
}));

describe("Scratchpad", () => {
  let pad: Scratchpad;

  beforeEach(() => {
    pad = new Scratchpad();
  });

  it("starts empty", () => {
    expect(pad.getAll()).toEqual({});
  });

  it("sets and gets entries", () => {
    const entry = pad.set("migration-status", "step 2 of 5", "worker-1");
    expect(entry.key).toBe("migration-status");
    expect(entry.value).toBe("step 2 of 5");
    expect(entry.setBy).toBe("worker-1");

    const retrieved = pad.get("migration-status");
    expect(retrieved).toEqual(entry);
  });

  it("returns undefined for missing keys", () => {
    expect(pad.get("nonexistent")).toBeUndefined();
  });

  it("overwrites existing keys", () => {
    pad.set("key", "v1", "w1");
    pad.set("key", "v2", "w2");
    const entry = pad.get("key");
    expect(entry?.value).toBe("v2");
    expect(entry?.setBy).toBe("w2");
  });

  it("deletes entries", () => {
    pad.set("key", "value", "w1");
    expect(pad.delete("key")).toBe(true);
    expect(pad.get("key")).toBeUndefined();
  });

  it("returns false when deleting nonexistent key", () => {
    expect(pad.delete("nope")).toBe(false);
  });

  it("returns all entries", () => {
    pad.set("a", "1", "w1");
    pad.set("b", "2", "w2");
    const all = pad.getAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.a.value).toBe("1");
    expect(all.b.value).toBe("2");
  });
});
