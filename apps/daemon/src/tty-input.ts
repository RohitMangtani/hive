import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Send text + Enter to a Claude Code instance running in a Terminal.app tab.
 *
 * Two-step approach:
 * 1. Write text to a temp file (avoids AppleScript string limits and escaping).
 *    AppleScript reads the file and uses `do script` to type it into the
 *    correct Terminal tab, then activates the window.
 * 2. A compiled Swift helper (`~/send-return`) posts a CGEvent Return keystroke
 *    at the HID level (requires Accessibility permission for the binary).
 */
export function sendInputToTty(tty: string, text: string): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  // Collapse newlines to spaces — Claude Code input is single-line
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, error: "Empty message" };

  // Write to temp file to avoid AppleScript string escaping/length issues.
  // Random suffix prevents prediction/symlink races.
  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, cleaned, { encoding: "utf-8", mode: 0o600 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  // Step 1: AppleScript types text into the correct Terminal tab.
  // Long text is chunked (500 chars each) to avoid `do script` truncation.
  // Each chunk appends to Claude Code's input buffer in raw mode.
  const CHUNK_SIZE = 500;
  const chunks: string[] = [];
  for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
    chunks.push(cleaned.slice(i, i + CHUNK_SIZE));
  }

  // Write each chunk to its own temp file (avoids AppleScript string escaping)
  const chunkFiles: string[] = [];
  try {
    for (const chunk of chunks) {
      const f = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
      writeFileSync(f, chunk, { encoding: "utf-8", mode: 0o600 });
      chunkFiles.push(f);
    }
  } catch (err: unknown) {
    for (const f of chunkFiles) cleanup(f);
    cleanup(tmpFile);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write chunks failed: ${msg.slice(0, 150)}` };
  }

  // Build AppleScript that sends each chunk sequentially with small delays
  const readChunks = chunkFiles
    .map((f, i) => `  set chunk${i} to read POSIX file "${f}" as «class utf8»\n  do script chunk${i} in targetTab${i < chunkFiles.length - 1 ? "\n  delay 0.05" : ""}`)
    .join("\n");

  const script = `
tell application "Terminal"
  set targetTTY to "${device}"
  set targetTab to missing value
  set targetWin to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set targetTab to t
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "TTY not found in Terminal.app"
${readChunks}
  set selected of targetTab to true
  set index of targetWin to 1
  activate
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 15000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    for (const f of chunkFiles) cleanup(f);
    cleanup(tmpFile);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Type failed: ${msg.slice(0, 180)}` };
  }

  for (const f of chunkFiles) cleanup(f);
  cleanup(tmpFile);

  // Step 2: Send Return keystroke via CGEvent (HID-level, no Apple Events)
  try {
    execFileSync("/Users/rmgtni/send-return", [], {
      timeout: 3000,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Enter failed: ${msg.slice(0, 180)}` };
  }
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
