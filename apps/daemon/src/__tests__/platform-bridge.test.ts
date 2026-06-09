import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDetectQuadrantsScript } from "../platform/windows/windows-window-manager.js";

function createTerminalMock() {
  return {
    sendText: vi.fn(() => ({ ok: true })),
    sendTextAsync: vi.fn(async () => ({ ok: true })),
    sendSelection: vi.fn(() => ({ ok: true })),
    sendKeystroke: vi.fn(() => ({ ok: true })),
    sendKeystrokeAsync: vi.fn(async () => ({ ok: true })),
    isSendInFlight: vi.fn(() => false),
  };
}

function stubPlatform(terminal: ReturnType<typeof createTerminalMock>) {
  return {
    terminal,
    discovery: {
      findAgentProcesses: () => [],
      getCpu: () => 0,
      getPtyOffset: () => null,
    },
    windows: {
      spawnTerminal: () => ({ ok: true }),
      closeTerminal: () => ({ ok: true }),
      arrangeWindows: () => {},
    },
  };
}

describe("platform bridge", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("uses the Linux implementation when os.platform() is linux", async () => {
    vi.doMock("os", () => ({ platform: () => "linux" }));
    const linuxTerminal = createTerminalMock();
    vi.doMock("../platform/index.js", () => ({
      loadPlatform: () => stubPlatform(linuxTerminal),
    }));

    const bridge = await import("../platform-bridge.js");
    bridge.sendInputToTty("tty1", "hello", "claude");
    bridge.sendInputToTtyAsync("tty1", "hi", "codex");
    bridge.sendSelectionToTty("tty1", 2);
    bridge.sendEnterToTty("tty1");
    bridge.sendEnterToTtyAsync("tty1");
    bridge.isSendInFlight();

    expect(linuxTerminal.sendText).toHaveBeenCalledWith("tty1", "hello", "claude");
    expect(linuxTerminal.sendTextAsync).toHaveBeenCalledWith("tty1", "hi", "codex");
    expect(linuxTerminal.sendSelection).toHaveBeenCalledWith("tty1", 2);
    expect(linuxTerminal.sendKeystroke).toHaveBeenCalledWith("tty1", "enter");
    expect(linuxTerminal.sendKeystrokeAsync).toHaveBeenCalledWith("tty1", "enter");
    expect(linuxTerminal.isSendInFlight).toHaveBeenCalled();
  });

  it("uses the macOS implementation when os.platform() is darwin", async () => {
    vi.doMock("os", () => ({ platform: () => "darwin" }));
    const macTerminal = createTerminalMock();
    vi.doMock("../platform/index.js", () => ({
      loadPlatform: () => stubPlatform(macTerminal),
    }));

    const bridge = await import("../platform-bridge.js");
    bridge.sendInputToTty("tty2", "desk", "claude");
    bridge.sendSelectionToTty("tty2", 1);
    bridge.sendEnterToTty("tty2");
    bridge.isSendInFlight();

    expect(macTerminal.sendText).toHaveBeenCalledWith("tty2", "desk", "claude");
    expect(macTerminal.sendSelection).toHaveBeenCalledWith("tty2", 1);
    expect(macTerminal.sendKeystroke).toHaveBeenCalledWith("tty2", "enter");
    expect(macTerminal.isSendInFlight).toHaveBeenCalled();
  });
});

describe("WindowsWindowManager detect-quadrants script", () => {
  // $PID is a documented read-only PowerShell automatic variable. Using it
  // as a loop variable throws "Cannot overwrite variable PID", the loop never
  // iterates, and quadrant detection fails silently. The generated script
  // must never reference bare $pid (the distinct names $pids/$targetPid are fine).
  it("never assigns the read-only PowerShell automatic variable $pid", () => {
    const script = buildDetectQuadrantsScript(["1234", "5678"]);
    expect(script).toContain("$pids = @(1234,5678)");
    expect(script).not.toMatch(/\$pid\b/i);
    expect(script).toContain("foreach ($targetPid in $pids)");
    // The output line must echo the loop variable, not the PS host's own PID.
    expect(script).toContain('Write-Output "$targetPid$([char]9)$q"');
    // The CIM parent lookup must filter on the loop variable too.
    expect(script).toContain('"ProcessId=$targetPid"');
  });

  it("dedupes PIDs that resolve to the same window handle", () => {
    // Multiple WT-tab agents share one wt.exe window; emitting identical
    // quadrants for all of them would thrash telemetry's snap-back logic.
    const script = buildDetectQuadrantsScript(["1", "2"]);
    expect(script).toContain("$seenHwnd = @{}");
    expect(script).toContain("if ($seenHwnd.ContainsKey($hwndKey)) { continue }");
  });
});
