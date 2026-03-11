import { execFileSync } from "child_process";

interface QuadrantSlot {
  quadrant: number;
  tty: string;
  projectName: string;
  model: string;
}

/** Screen quadrant positions: Q1=top-left, Q2=top-right, Q3=bottom-left, Q4=bottom-right */
const QUADRANT_POSITIONS: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },    // top-left
  2: { x: 1, y: 0 },    // top-right
  3: { x: 0, y: 1 },    // bottom-left
  4: { x: 1, y: 1 },    // bottom-right
};

// Track last arrangement to avoid redundant AppleScript calls
let lastArrangement = "";

/**
 * Detect the physical screen position of each Terminal window by TTY
 * and return the quadrant assignment (1-4) based on where the window
 * actually sits on screen.
 *
 * Returns a Map<tty, quadrant>. TTYs whose window can't be found are omitted.
 */
export function detectQuadrantsFromWindowPositions(ttys: string[]): Map<string, number> {
  if (ttys.length === 0) return new Map();

  // Build AppleScript that collects { tty, x, y } for each window's center point
  const ttyChecks = ttys.map(tty => {
    const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    return `
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${device}" then
          set b to bounds of w
          set cx to ((item 1 of b) + (item 3 of b)) / 2
          set cy to ((item 2 of b) + (item 4 of b)) / 2
          set end of results to "${tty}," & cx & "," & cy
          exit repeat
        end if
      end repeat
    end repeat`;
  }).join("\n");

  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set midX to screenW / 2
set midY to screenH / 2

set results to {}
tell application "Terminal"
${ttyChecks}
end tell

set output to ""
repeat with r in results
  set output to output & r & linefeed
end repeat
return "SCREEN:" & midX & "," & midY & linefeed & output
`;

  try {
    const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 8000,
      encoding: "utf-8",
    }).trim();

    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return new Map();

    // Parse screen midpoint
    const screenLine = lines.find(l => l.startsWith("SCREEN:"));
    if (!screenLine) return new Map();
    const [midXStr, midYStr] = screenLine.replace("SCREEN:", "").split(",");
    const midX = parseFloat(midXStr);
    const midY = parseFloat(midYStr);

    // Parse each TTY's center position
    const positions: Array<{ tty: string; cx: number; cy: number }> = [];
    for (const line of lines) {
      if (line.startsWith("SCREEN:")) continue;
      const parts = line.split(",");
      if (parts.length < 3) continue;
      positions.push({
        tty: parts[0],
        cx: parseFloat(parts[1]),
        cy: parseFloat(parts[2]),
      });
    }

    // Assign quadrant based on position relative to screen center
    const result = new Map<string, number>();
    const usedQuadrants = new Set<number>();

    // Sort by distance to each quadrant corner to resolve conflicts
    for (const pos of positions) {
      const isLeft = pos.cx < midX;
      const isTop = pos.cy < midY;
      let q: number;
      if (isTop && isLeft) q = 1;
      else if (isTop && !isLeft) q = 2;
      else if (!isTop && isLeft) q = 3;
      else q = 4;

      // If quadrant already taken, find nearest free one
      if (usedQuadrants.has(q)) {
        const free = [1, 2, 3, 4].filter(n => !usedQuadrants.has(n));
        if (free.length === 0) continue;
        q = free[0];
      }
      result.set(pos.tty, q);
      usedQuadrants.add(q);
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[arrange] Failed to detect window positions: ${msg.slice(0, 150)}`);
    return new Map();
  }
}

/**
 * Set Terminal.app tab titles and window positions to match quadrant assignments.
 * Called whenever quadrant assignments change in writeWorkersFile().
 *
 * Each terminal tab gets titled "Q{N} - {project}" and its window is moved
 * to the corresponding screen quadrant so the physical layout matches the dashboard.
 */
export function arrangeTerminalWindows(slots: QuadrantSlot[]): void {
  if (slots.length === 0) return;

  // Build a fingerprint to skip redundant calls
  const fingerprint = slots
    .map(s => `${s.quadrant}:${s.tty}:${s.projectName}`)
    .sort()
    .join("|");
  if (fingerprint === lastArrangement) return;
  lastArrangement = fingerprint;

  // Build AppleScript that:
  // 1. Gets screen dimensions
  // 2. For each slot, finds the tab by TTY, sets its title, and positions its window
  const tabBlocks = slots.map(slot => {
    const pos = QUADRANT_POSITIONS[slot.quadrant];
    if (!pos) return "";
    const device = slot.tty.startsWith("/dev/") ? slot.tty : `/dev/${slot.tty}`;
    const title = `Q${slot.quadrant} - ${slot.projectName}`;

    return `
    -- Q${slot.quadrant}: ${slot.tty}
    set targetTab to missing value
    set targetWin to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${device}" then
          set targetTab to t
          set targetWin to w
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat
    if targetTab is not missing value then
      set custom title of targetTab to "${title}"
      set title displays custom title of targetTab to true
      set bounds of targetWin to {screenX + ${pos.x} * halfW, screenY + ${pos.y} * halfH + menuBarH, screenX + ${pos.x} * halfW + halfW, screenY + ${pos.y} * halfH + halfH + menuBarH}
    end if
    set targetTab to missing value
    set targetWin to missing value`;
  }).filter(Boolean).join("\n");

  if (!tabBlocks) return;

  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenX to item 1 of screenBounds
  set screenY to item 2 of screenBounds
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set menuBarH to 25
set halfW to (screenW - screenX) / 2
set halfH to (screenH - screenY - menuBarH) / 2

tell application "Terminal"
${tabBlocks}
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 10000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[arrange] Failed to arrange windows: ${msg.slice(0, 150)}`);
  }
}

/**
 * Open a new Terminal.app window, cd to the project, and run the model CLI.
 *
 * - claude: types `claude` then sends keystroke "1" (to select option 1 from the menu)
 * - codex: types `codex`
 *
 * Returns the TTY of the new tab (not reliably available immediately, so returns null).
 */
export function spawnTerminalWindow(
  project: string,
  model: "claude" | "codex",
): { ok: boolean; error?: string } {
  // For claude: `cd <project> && claude` then press "1"
  // For codex: `cd <project> && codex`
  const cdCmd = `cd "${project}"`;
  const launchCmd = model === "claude"
    ? `${cdCmd} && claude`
    : `${cdCmd} && codex`;

  const script = `
tell application "Terminal"
  do script "${launchCmd.replace(/"/g, '\\"')}"
  activate
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 10000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Spawn terminal failed: ${msg.slice(0, 150)}` };
  }

  // For claude, we need to send "1" + Enter after a short delay
  // to select the first option from the CLI menu
  if (model === "claude") {
    setTimeout(() => {
      try {
        // Press "1" key in the frontmost Terminal window
        const selectScript = `
tell application "System Events"
  tell process "Terminal"
    keystroke "1"
    delay 0.3
    key code 36
  end tell
end tell
`;
        execFileSync("/usr/bin/osascript", ["-e", selectScript], {
          timeout: 5000,
          encoding: "utf-8",
        });
      } catch {
        // Non-critical - user can press 1 manually
        console.log("[arrange] Failed to auto-press 1 for claude CLI menu");
      }
    }, 3000); // Wait for claude CLI to show its menu
  }

  return { ok: true };
}
