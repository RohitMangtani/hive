import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import crypto from "crypto";

const REPLAY_DIR = join(homedir(), ".hive", "replays");

export interface ReplayMetadata {
  id: string;
  name: string;
  path: string;
  startedAt: number;
  endedAt: number | null;
}

interface ReplaySession {
  meta: ReplayMetadata;
  stream: ReturnType<typeof createWriteStream>;
  active: boolean;
}

export class ReplayManager {
  private sessions = new Map<string, ReplaySession>();
  private history = new Map<string, ReplayMetadata>();

  constructor() {
    if (!existsSync(REPLAY_DIR)) {
      mkdirSync(REPLAY_DIR, { recursive: true });
    }
    this.loadHistoryFromDisk();
  }

  /** Rebuild history from the JSONL files on disk so recordings made by a
   *  previous daemon run stay listable and downloadable after a restart. */
  private loadHistoryFromDisk(): void {
    let files: string[];
    try {
      files = readdirSync(REPLAY_DIR);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -".jsonl".length);
      const path = join(REPLAY_DIR, file);
      try {
        const stat = statSync(path);
        // id format: replay_<startedAtMs>_<hex>
        const tsMatch = id.match(/^replay_(\d+)_/);
        const startedAt = tsMatch ? Number(tsMatch[1]) : Math.floor(stat.birthtimeMs || stat.mtimeMs);
        this.history.set(id, {
          id,
          name: `Replay ${new Date(startedAt).toISOString()}`,
          path,
          startedAt,
          // Recordings from a previous run are no longer being written;
          // the last write time is the best available end marker.
          endedAt: Math.floor(stat.mtimeMs),
        });
      } catch { /* unreadable file  --  skip */ }
    }
  }

  start(name?: string): ReplayMetadata {
    const id = `replay_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const meta: ReplayMetadata = {
      id,
      name: name ? name.trim() : `Replay ${new Date().toISOString()}`,
      path: join(REPLAY_DIR, `${id}.jsonl`),
      startedAt: Date.now(),
      endedAt: null,
    };
    const stream = createWriteStream(meta.path, { flags: "a" });
    this.sessions.set(id, { meta, stream, active: true });
    this.history.set(id, { ...meta });
    return meta;
  }

  stop(id: string): ReplayMetadata | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.active) {
      session.stream.end();
      session.active = false;
      const updated: ReplayMetadata = { ...session.meta, endedAt: Date.now() };
      session.meta = updated;
      this.history.set(id, updated);
    }
    this.sessions.delete(id);
    return this.history.get(id) || null;
  }

  list(): ReplayMetadata[] {
    return Array.from(this.history.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  read(id: string): Buffer | null {
    const meta = this.history.get(id);
    if (!meta) return null;
    try {
      return readFileSync(meta.path);
    } catch {
      return null;
    }
  }

  record(type: string, payload: unknown): void {
    const event = {
      ts: Date.now(),
      type,
      payload,
    };
    for (const session of this.sessions.values()) {
      if (!session.active) continue;
      session.stream.write(JSON.stringify(event) + "\n");
    }
  }
}
