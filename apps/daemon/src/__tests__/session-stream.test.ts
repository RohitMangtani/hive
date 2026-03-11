import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStreamer } from "../session-stream.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "hive-session-stream-"));
  tempDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "", "utf-8");
  return file;
}

function claudeUser(text: string, isoTs: string): string {
  return `${JSON.stringify({
    type: "user",
    timestamp: isoTs,
    message: { content: text },
  })}\n`;
}

function claudeAssistant(text: string, isoTs: string): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: isoTs,
    message: { content: text },
  })}\n`;
}

function compact(entries: Array<{ role: string; text: string }>): Array<{ role: string; text: string }> {
  return entries.map(({ role, text }) => ({ role, text }));
}

describe("SessionStreamer pending chat", () => {
  it("preserves the original routed message text after the session file echoes a context-bundle pointer", () => {
    const file = makeTempFile();
    const streamer = new SessionStreamer();
    streamer.setSessionFile("w1", file);

    const display = "Audit the current launch flow and summarize the gaps";
    const pointer = "Read /Users/rmgtni/.hive/context-messages/msg-123.md and follow it exactly. The full routed message and peer context are in that file.";

    streamer.addPendingEntry(
      "w1",
      { role: "user", text: display, timestamp: Date.parse("2026-03-11T20:10:00.000Z") },
      { echoText: pointer },
    );

    appendFileSync(file, claudeUser(pointer, "2026-03-11T20:10:01.000Z"));
    appendFileSync(file, claudeAssistant("done", "2026-03-11T20:10:04.000Z"));

    expect(compact(streamer.readHistory("w1"))).toEqual([
      { role: "user", text: display },
      { role: "agent", text: "done" },
    ]);
  });

  it("broadcasts pending user entries immediately even before a session file is known", () => {
    const streamer = new SessionStreamer();
    const callback = vi.fn();

    streamer.subscribe("sub", "w1", callback);
    streamer.addPendingEntry("w1", {
      role: "user",
      text: "Continue",
      timestamp: Date.parse("2026-03-11T20:11:00.000Z"),
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(compact(callback.mock.calls[0]?.[0] ?? [])).toEqual([
      { role: "user", text: "Continue" },
    ]);

    streamer.unsubscribe("sub");
  });

  it("keeps non-echo dashboard selections ordered before later agent output", () => {
    const file = makeTempFile();
    const streamer = new SessionStreamer();
    streamer.setSessionFile("w1", file);

    streamer.addPendingEntry(
      "w1",
      {
        role: "user",
        text: "Selected option 1 from dashboard",
        timestamp: Date.parse("2026-03-11T20:12:00.000Z"),
      },
      { expectEcho: false },
    );

    appendFileSync(file, claudeAssistant("Continuing with the task", "2026-03-11T20:12:03.000Z"));

    expect(compact(streamer.readHistory("w1"))).toEqual([
      { role: "user", text: "Selected option 1 from dashboard" },
      { role: "agent", text: "Continuing with the task" },
    ]);
  });
});
