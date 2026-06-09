/**
 * SessionStreamer incremental poll tests: torn (partially written) JSONL
 * lines must be carried to the next poll instead of being skipped.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStreamer } from "../session-stream.js";
import type { ChatEntry } from "../types.js";

const TEST_DIR = join(process.env.TMPDIR || tmpdir(), `hive-session-stream-tests-${process.pid}`);

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function poll(streamer: SessionStreamer, subKey: string): void {
  (streamer as unknown as { poll: (key: string) => void }).poll(subKey);
}

describe("SessionStreamer.poll torn-line handling", () => {
  let streamer: SessionStreamer;
  let file: string;
  let received: ChatEntry[];
  const SUB_KEY = "w1_test";

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    file = join(TEST_DIR, `session-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, "");
    received = [];
    streamer = new SessionStreamer();
    streamer.setSessionFile("w1", file);
    streamer.subscribe(SUB_KEY, "w1", (entries) => received.push(...entries));
  });

  afterEach(() => {
    streamer.unsubscribe(SUB_KEY);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("delivers complete lines and carries a torn trailing line to the next poll", () => {
    const torn = assistantLine("world");
    const cut = Math.floor(torn.length / 2);

    appendFileSync(file, assistantLine("hello") + "\n" + torn.slice(0, cut));
    poll(streamer, SUB_KEY);
    expect(received.map((e) => e.text)).toEqual(["hello"]);

    // Writer finishes the torn line  --  it must arrive exactly once.
    appendFileSync(file, torn.slice(cut) + "\n");
    poll(streamer, SUB_KEY);
    expect(received.map((e) => e.text)).toEqual(["hello", "world"]);
  });

  it("does not deliver anything when the only new content is a partial line", () => {
    appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"te');
    poll(streamer, SUB_KEY);
    expect(received).toHaveLength(0);

    appendFileSync(file, 'xt","text":"late"}]}}\n');
    poll(streamer, SUB_KEY);
    expect(received.map((e) => e.text)).toEqual(["late"]);
  });

  it("consumes a complete trailing JSON line that has no newline yet, without duplicating it", () => {
    appendFileSync(file, assistantLine("first") + "\n" + assistantLine("no-newline-yet"));
    poll(streamer, SUB_KEY);
    expect(received.map((e) => e.text)).toEqual(["first", "no-newline-yet"]);

    appendFileSync(file, "\n" + assistantLine("next") + "\n");
    poll(streamer, SUB_KEY);
    expect(received.map((e) => e.text)).toEqual(["first", "no-newline-yet", "next"]);
  });
});
