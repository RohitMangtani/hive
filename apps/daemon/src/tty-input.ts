import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { homedir, tmpdir } from "os";

const SEND_RETURN_BIN = process.env.SEND_RETURN_BIN || join(homedir(), "send-return");

/**
 * Capture the bundle ID of the currently frontmost application.
 * Returns null on failure (non-critical — restore just won't happen).
 */
function getFrontmostApp(): string | null {
  try {
    const result = execFileSync("/usr/bin/osascript", ["-e",
      'tell application "System Events" to return bundle identifier of first application process whose frontmost is true'
    ], { timeout: 2000, encoding: "utf-8" });
    const bid = result.trim();
    return bid && bid !== "com.apple.Terminal" ? bid : null;
  } catch {
    return null;
  }
}

/**
 * Restore focus to the app that was frontmost before we activated Terminal.
 * Fire-and-forget — if it fails, the user just stays on Terminal (no worse than before).
 */
function restoreFrontmostApp(bundleId: string): void {
  try {
    execFileSync("/usr/bin/osascript", ["-e",
      `tell application id "${bundleId}" to activate`
    ], { timeout: 2000, encoding: "utf-8" });
  } catch {
    // Non-critical — worst case user stays on Terminal (current behavior)
  }
}

/**
 * Send text + Enter to a Claude Code instance running in a Terminal.app tab.
 *
 * Two-step approach:
 * 1. Write the text to a temp file (avoids AppleScript string escaping and
 *    keeps the `do script` payload to a single call).
 * 2. AppleScript loads the file and injects it into the correct Terminal tab.
 * 3. A compiled Swift helper (`~/send-return`) posts a CGEvent Return keystroke
 *    at the HID level (requires Accessibility permission for the binary).
 *
 * After the Return lands, focus is restored to whatever app was frontmost
 * before Terminal was activated.
 */
export function sendInputToTty(tty: string, text: string): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  // Collapse newlines to spaces — Claude Code input is single-line
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, error: "Empty message" };

  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, cleaned, { encoding: "utf-8", mode: 0o600 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  // Snapshot the currently frontmost app so we can restore after send
  const previousApp = getFrontmostApp();

  const script = `
tell application "Terminal"
  set payload to read POSIX file "${tmpFile}" as «class utf8»
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
  do script payload in targetTab
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
    cleanup(tmpFile);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Type failed: ${msg.slice(0, 180)}` };
  }

  cleanup(tmpFile);

  // Step 2: Send Return keystroke via CGEvent (HID-level, no Apple Events)
  try {
    execFileSync(SEND_RETURN_BIN, [], {
      timeout: 3000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Still try to restore even if Return failed
    if (previousApp) restoreFrontmostApp(previousApp);
    return { ok: false, error: `Enter failed: ${msg.slice(0, 180)}` };
  }

  // Step 3: Restore focus to the app that was frontmost before Terminal
  if (previousApp) restoreFrontmostApp(previousApp);

  return { ok: true };
}

/**
 * Send keystrokes (arrow keys + Enter) to a Terminal.app tab via System Events.
 *
 * Used for ink-based selection UIs (AskUserQuestion, EnterPlanMode) where
 * `do script` text injection doesn't work — ink's raw-mode selection
 * component ignores injected text and only responds to key events.
 *
 * @param optionIndex 0-based index of the option to select (0 = first/default)
 */
export function sendSelectionToTty(tty: string, optionIndex: number): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  // Build arrow-down keystrokes to reach the desired option
  const downKeys = Array(optionIndex)
    .fill('    key code 125\n    delay 0.05') // 125 = Down arrow
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
  set selected of targetTab to true
  set index of targetWin to 1
  activate
  delay 0.3
end tell
tell application "System Events"
  tell process "Terminal"
${downKeys ? downKeys + "\n    delay 0.05" : ""}
    key code 36
  end tell
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 15000,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Selection failed: ${msg.slice(0, 180)}` };
  }
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
