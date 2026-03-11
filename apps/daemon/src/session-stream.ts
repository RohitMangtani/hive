import { readFileSync, statSync, readdirSync, watch, type FSWatcher } from "fs";
import { basename, join } from "path";
import type { ChatEntry } from "./types.js";
import { describeAction, describeBashCommand, truncate } from "./utils.js";

const MAX_HISTORY = 50;
const MAX_PENDING = 200;
const POLL_INTERVAL = 500; // fallback poll if fs.watch misses events
const NUDGE_INTERVALS = [200, 500, 1_000, 2_000, 4_000]; // rapid polls after message send

interface Subscription {
  workerId: string;
  filePath: string;
  byteOffset: number;
  timer: ReturnType<typeof setInterval>;
  watcher: FSWatcher | null;
  callback: (entries: ChatEntry[], full?: boolean) => void;
  nudgeTimers: ReturnType<typeof setTimeout>[];
}

interface PendingChatEntry {
  id: string;
  entry: ChatEntry;
  echoNorm: string | null;
  expectEcho: boolean;
  resolved: boolean;
}

export class SessionStreamer {
  private subscriptions = new Map<string, Subscription>();
  // worker_id → session file path (set by discovery)
  private sessionFiles = new Map<string, string>();
  private pendingEntries = new Map<string, PendingChatEntry[]>();
  private pendingSeq = 0;

  setSessionFile(workerId: string, filePath: string): void {
    this.sessionFiles.set(workerId, filePath);
  }

  getSessionFile(workerId: string): string | null {
    return this.sessionFiles.get(workerId) || null;
  }

  /**
   * Find the best session file for a worker by scanning .claude/projects/
   */
  findSessionFile(sessionIds: string[]): string | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");

    let bestFile: string | null = null;
    let bestMtime = 0;

    try {
      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const jsonlPath = join(fullDir, `${sessionId}.jsonl`);
          try {
            const stat = statSync(jsonlPath);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = jsonlPath;
            }
          } catch {
            // File doesn't exist
          }
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    return bestFile;
  }

  /**
   * Read recent chat history from a session file.
   */
  readHistory(workerId: string): ChatEntry[] {
    const fileEntries = this.readFileEntries(workerId);
    const merged = this.mergePending(workerId, fileEntries);
    return merged.slice(-MAX_HISTORY);
  }

  addPendingEntry(
    workerId: string,
    entry: ChatEntry,
    options: { echoText?: string; expectEcho?: boolean } = {},
  ): void {
    const pending: PendingChatEntry = {
      id: `p${++this.pendingSeq}`,
      entry: {
        ...entry,
        timestamp: entry.timestamp ?? Date.now(),
      },
      echoNorm: options.expectEcho === false
        ? null
        : normalize(options.echoText ?? entry.text),
      expectEcho: options.expectEcho !== false,
      resolved: false,
    };

    const list = this.pendingEntries.get(workerId) ?? [];
    list.push(pending);
    if (list.length > MAX_PENDING) {
      list.splice(0, list.length - MAX_PENDING);
    }
    this.pendingEntries.set(workerId, list);

    for (const sub of this.subscriptions.values()) {
      if (sub.workerId !== workerId) continue;
      sub.callback([pending.entry]);
    }
  }

  /**
   * Subscribe to new messages from a worker's session file.
   * @param subKey - unique subscription key (e.g. workerId + clientId)
   * @param workerId - plain worker ID used to look up the session file
   * @param callback - receives new chat entries
   */
  subscribe(subKey: string, workerId: string, callback: (entries: ChatEntry[], full?: boolean) => void): void {
    this.unsubscribe(subKey);

    const filePath = this.sessionFiles.get(workerId) || "";
    let byteOffset = 0;
    if (filePath) {
      try {
        byteOffset = statSync(filePath).size;
      } catch {
        byteOffset = 0;
      }
    }

    // Use fs.watch for instant file change detection, with polling fallback
    let watcher: FSWatcher | null = null;
    if (filePath) {
      try {
        watcher = watch(filePath, () => this.poll(subKey));
      } catch {
        // fs.watch can fail on some filesystems
      }
    }

    const sub: Subscription = {
      workerId,
      filePath,
      byteOffset,
      callback,
      watcher,
      timer: setInterval(() => this.poll(subKey), POLL_INTERVAL),
      nudgeTimers: [],
    };

    this.subscriptions.set(subKey, sub);
  }

  unsubscribe(workerId: string): void {
    const sub = this.subscriptions.get(workerId);
    if (sub) {
      clearInterval(sub.timer);
      for (const t of sub.nudgeTimers) clearTimeout(t);
      if (sub.watcher) sub.watcher.close();
      this.subscriptions.delete(workerId);
    }
  }

  /**
   * Trigger rapid polling for a worker after a message was sent to it.
   * Schedules multiple polls at increasing intervals so the agent's response
   * appears on the dashboard within ~200ms of being written to the JSONL.
   */
  nudge(workerId: string): void {
    for (const [subKey, sub] of this.subscriptions) {
      if (sub.workerId !== workerId) continue;
      // Clear any existing nudge timers to avoid stacking
      for (const t of sub.nudgeTimers) clearTimeout(t);
      sub.nudgeTimers = NUDGE_INTERVALS.map((ms) =>
        setTimeout(() => this.poll(subKey), ms)
      );
    }
  }

  private poll(subKey: string): void {
    const sub = this.subscriptions.get(subKey);
    if (!sub) return;

    // Detect session file change (context compaction creates a new JSONL).
    // Discovery updates sessionFiles on every scan — if the file changed,
    // switch to the new one and send its full history as a full replace.
    let isFileChange = false;
    const currentFile = this.sessionFiles.get(sub.workerId) || "";
    if (currentFile && currentFile !== sub.filePath) {
      if (sub.watcher) sub.watcher.close();
      sub.filePath = currentFile;
      sub.byteOffset = 0; // Read from start of new file
      isFileChange = true;
      try {
        sub.watcher = watch(currentFile, () => this.poll(subKey));
      } catch { sub.watcher = null; }
    }

    if (!sub.filePath) return;

    try {
      const stat = statSync(sub.filePath);
      if (stat.size <= sub.byteOffset) return;

      const buf = readFileSync(sub.filePath);
      const newContent = buf.subarray(sub.byteOffset).toString("utf-8");
      // Use buf.length (actual bytes read) not stat.size — file may have grown between stat and read
      sub.byteOffset = buf.length;

      const entries: ChatEntry[] = [];
      for (const line of newContent.split("\n").filter(Boolean)) {
        const parsed = parseLine(line);
        if (parsed) entries.push(...parsed);
      }

      if (entries.length === 0 && !isFileChange) return;

      if (isFileChange) {
        sub.callback(this.readHistory(sub.workerId), true);
        return;
      }

      const visible = this.filterIncrementalEntries(sub.workerId, entries);
      if (visible.length > 0) {
        sub.callback(visible);
      }
    } catch {
      // File might have been deleted/rotated
    }
  }

  private readFileEntries(workerId: string): ChatEntry[] {
    const filePath = this.sessionFiles.get(workerId);
    if (!filePath) return [];

    try {
      const buf = readFileSync(filePath);
      const content = buf.toString("utf-8");
      const lines = content.split("\n").filter(Boolean);

      const entries: ChatEntry[] = [];
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed) entries.push(...parsed);
      }
      return entries;
    } catch {
      return [];
    }
  }

  private mergePending(workerId: string, fileEntries: ChatEntry[]): ChatEntry[] {
    const pending = this.pendingEntries.get(workerId);
    if (!pending || pending.length === 0) return fileEntries;

    const consumed = new Set<string>();
    const overlaid: ChatEntry[] = [];

    for (const entry of fileEntries) {
      if (entry.role === "user") {
        const match = this.findPendingMatch(pending, normalize(entry.text), consumed);
        if (match) {
          match.resolved = true;
          consumed.add(match.id);
          overlaid.push(match.entry);
          continue;
        }
      }
      overlaid.push(entry);
    }

    const unresolved = pending
      .filter((item) => !consumed.has(item.id) && (!item.expectEcho || !item.resolved))
      .map((item) => item.entry);

    return mergeByTimestamp(overlaid, unresolved);
  }

  private filterIncrementalEntries(workerId: string, entries: ChatEntry[]): ChatEntry[] {
    const pending = this.pendingEntries.get(workerId);
    if (!pending || pending.length === 0) return entries;

    const consumed = new Set<string>();
    const visible: ChatEntry[] = [];

    for (const entry of entries) {
      if (entry.role === "user") {
        const match = this.findPendingMatch(pending, normalize(entry.text), consumed);
        if (match) {
          match.resolved = true;
          consumed.add(match.id);
          continue;
        }
      }
      visible.push(entry);
    }

    return visible;
  }

  private findPendingMatch(
    pending: PendingChatEntry[],
    entryNorm: string,
    consumed: Set<string>,
  ): PendingChatEntry | null {
    for (const item of pending) {
      if (!item.expectEcho || !item.echoNorm) continue;
      if (consumed.has(item.id)) continue;
      if (item.echoNorm === entryNorm) return item;
    }
    return null;
  }
}

/** Parse a single JSONL line into chat entries (Claude or Codex format) */
function parseLine(line: string): ChatEntry[] | null {
  try {
    const obj = JSON.parse(line);
    const type = obj.type as string;
    const timestamp = parseTimestamp(obj.timestamp);

    // ── Claude format ──
    if (type === "user") {
      const text = extractText(obj.message?.content);
      if (text) return [{ role: "user", text, timestamp }];
    }

    if (type === "assistant") {
      const entries: ChatEntry[] = [];
      const content = obj.message?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            entries.push({ role: "agent", text: block.text.trim(), timestamp });
          } else if (block.type === "tool_use") {
            const desc = describeAction(block.name, block.input);
            entries.push({ role: "tool", text: desc, timestamp });
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        entries.push({ role: "agent", text: content.trim(), timestamp });
      }

      return entries.length > 0 ? entries : null;
    }

    // ── Codex format ──
    // Codex wraps everything in {type, payload}
    const p = obj.payload;
    if (!p) return null;

    // User message: {type:"event_msg", payload:{type:"user_message", message:"..."}}
    if (type === "event_msg" && p.type === "user_message" && p.message) {
      const text = typeof p.message === "string" ? p.message.trim() : null;
      if (text) return [{ role: "user", text, timestamp }];
    }

    if (type === "response_item") {
      // Assistant text: {type:"response_item", payload:{role:"assistant", content:[{type:"output_text", text:"..."}]}}
      if (p.role === "assistant" && p.content) {
        const entries: ChatEntry[] = [];
        if (Array.isArray(p.content)) {
          for (const block of p.content) {
            if (block.type === "output_text" && block.text?.trim()) {
              entries.push({ role: "agent", text: block.text.trim(), timestamp });
            }
          }
        }
        return entries.length > 0 ? entries : null;
      }

      // Tool call: {type:"response_item", payload:{type:"function_call", name:"exec_command", arguments:"..."}}
      if (p.type === "function_call" && p.name) {
        let input: Record<string, unknown> | undefined;
        try { input = JSON.parse(p.arguments || "{}"); } catch { /* ignore */ }
        const desc = describeCodexAction(p.name, input);
        return [{ role: "tool", text: desc, timestamp }];
      }

      // Tool result: {type:"response_item", payload:{type:"function_call_output", output:"..."}}
      if (p.type === "function_call_output") {
        return null; // Skip tool outputs (same as Claude — only show call descriptions)
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Describe a Codex tool call for display */
function describeCodexAction(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "exec_command":
      return input.cmd ? describeBashCommand(truncate(input.cmd as string, 60)) : "Running command";
    case "read_file":
      return input.path ? `Reading ${basename(input.path as string)}` : "Reading file";
    case "write_file":
      return input.path ? `Writing ${basename(input.path as string)}` : "Writing file";
    case "list_directory":
      return input.path ? `Listing ${basename(input.path as string)}` : "Listing files";
    default:
      return name;
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        return block.text.trim();
      }
    }
  }
  return null;
}

function normalize(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function mergeByTimestamp(base: ChatEntry[], extras: ChatEntry[]): ChatEntry[] {
  if (extras.length === 0) return base;
  if (base.length === 0) return extras;

  const merged: ChatEntry[] = [];
  let i = 0;
  let j = 0;

  while (i < base.length && j < extras.length) {
    const baseTs = base[i]?.timestamp;
    const extraTs = extras[j]?.timestamp;
    if (baseTs == null || extraTs == null) break;
    if (extraTs <= baseTs) {
      merged.push(extras[j++]!);
    } else {
      merged.push(base[i++]!);
    }
  }

  if (i < base.length || j < extras.length) {
    merged.push(...base.slice(i), ...extras.slice(j));
  }

  return merged;
}
