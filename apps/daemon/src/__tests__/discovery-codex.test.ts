import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ProcessDiscovery } from "../discovery.js";

function createDiscovery() {
  return new ProcessDiscovery({} as never, {} as never);
}

function writeSession(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hive-codex-discovery-"));
  const file = join(dir, "rollout-test.jsonl");
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function analyze(filePath: string) {
  const discovery = createDiscovery() as unknown as {
    analyzeJsonlTail: (filePath: string, result: {
      projectName: string | null;
      latestAction: string | null;
      lastDirection: string | null;
      status: "working" | "idle";
      fileAgeMs: number;
      highConfidence: boolean;
    }) => {
      projectName: string | null;
      latestAction: string | null;
      lastDirection: string | null;
      status: "working" | "idle";
      fileAgeMs: number;
      highConfidence: boolean;
    };
  };

  return discovery.analyzeJsonlTail(filePath, {
    projectName: null,
    latestAction: null,
    lastDirection: null,
    status: "idle",
    fileAgeMs: 0,
    highConfidence: false,
  });
}

describe("ProcessDiscovery Codex tail parsing", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Codex working when a new turn starts after a previous task_complete", () => {
    const file = writeSession([
      '{"timestamp":"2026-03-11T12:21:22.238Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","last_agent_message":"done"}}',
      '{"timestamp":"2026-03-11T12:22:36.410Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","model_context_window":258400}}',
      '{"timestamp":"2026-03-11T12:22:36.410Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"What were the fixes"}]}}',
      '{"timestamp":"2026-03-11T12:22:36.410Z","type":"event_msg","payload":{"type":"user_message","message":"What were the fixes","images":[],"local_images":[],"text_elements":[]}}',
    ]);
    dirs.push(file.replace(/\/[^/]+$/, ""));

    const result = analyze(file);

    expect(result.status).toBe("working");
    expect(result.highConfidence).toBe(true);
    expect(result.latestAction).toBe("Thinking...");
  });

  it("still marks Codex idle when the latest turn really completed", () => {
    const file = writeSession([
      '{"timestamp":"2026-03-11T12:22:36.410Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","model_context_window":258400}}',
      '{"timestamp":"2026-03-11T12:22:36.410Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"What were the fixes"}]}}',
      '{"timestamp":"2026-03-11T12:22:46.680Z","type":"event_msg","payload":{"type":"agent_message","message":"answer","phase":"final_answer"}}',
      '{"timestamp":"2026-03-11T12:22:46.699Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","last_agent_message":"answer"}}',
    ]);
    dirs.push(file.replace(/\/[^/]+$/, ""));

    const result = analyze(file);

    expect(result.status).toBe("idle");
    expect(result.highConfidence).toBe(true);
  });
});
