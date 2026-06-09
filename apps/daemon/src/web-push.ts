import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const HIVE_DIR = join(HOME, ".hive");
const VAPID_PATH = join(HIVE_DIR, "vapid.json");
const SUBS_PATH = join(HIVE_DIR, "push-subs.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSub {
  sub: PushSubscription;
  addedAt: number;
  label?: string;
}

export class WebPushManager {
  private vapid: VapidKeys;
  private subs: StoredSub[] = [];
  /** True when VAPID setup failed even with fresh keys — push is disabled
   *  for this run instead of taking the daemon down. */
  private disabled = false;

  constructor() {
    this.vapid = this.loadOrGenerateVapid();
    this.subs = this.loadSubs();

    // setVapidDetails throws on malformed key material. A vapid.json that
    // parses but holds truncated/invalid keys used to kill the daemon at
    // startup (the constructor is called with no try/catch), which launchd
    // then turned into a crash loop until someone deleted the file.
    // Regenerate once on failure; if even fresh keys fail, disable push.
    if (!this.applyVapid(this.vapid)) {
      console.log("[web-push] Stored VAPID keys rejected — regenerating");
      this.vapid = this.generateAndStoreVapid();
      if (!this.applyVapid(this.vapid)) {
        this.disabled = true;
        console.log("[web-push] VAPID setup failed twice — web push disabled for this run");
      }
    }

    if (!this.disabled) {
      console.log(
        `  Web Push: ${this.subs.length} subscription(s), VAPID key ready`,
      );
    }
  }

  private applyVapid(vapid: VapidKeys): boolean {
    try {
      webpush.setVapidDetails(
        "https://github.com/RohitMangtani/hive",
        vapid.publicKey,
        vapid.privateKey,
      );
      return true;
    } catch (err) {
      console.log(`[web-push] setVapidDetails rejected keys: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  getPublicKey(): string {
    return this.disabled ? "" : this.vapid.publicKey;
  }

  addSubscription(sub: PushSubscription, label?: string): void {
    // Deduplicate by endpoint
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ sub, addedAt: Date.now(), label });
    this.saveSubs();
    console.log(
      `[web-push] Subscription added (${label || "unknown"})  --  total: ${this.subs.length}`,
    );
  }

  removeSubscription(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.sub.endpoint !== endpoint);
    if (this.subs.length < before) {
      this.saveSubs();
      return true;
    }
    return false;
  }

  getSubscriptionCount(): number {
    return this.subs.length;
  }

  async sendToAll(
    title: string,
    body: string,
    options?: { tag?: string; data?: Record<string, unknown> },
  ): Promise<{ sent: number; failed: number }> {
    if (this.disabled || this.subs.length === 0) return { sent: 0, failed: 0 };

    const payload = JSON.stringify({
      title,
      body,
      tag: options?.tag,
      data: options?.data,
    });

    let sent = 0;
    let failed = 0;
    const expired: string[] = [];

    await Promise.allSettled(
      this.subs.map(async ({ sub }) => {
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Subscription expired or unsubscribed  --  remove it
            expired.push(sub.endpoint);
          }
          failed++;
        }
      }),
    );

    if (expired.length > 0) {
      this.subs = this.subs.filter((s) => !expired.includes(s.sub.endpoint));
      this.saveSubs();
      console.log(`[web-push] Pruned ${expired.length} expired subscription(s)`);
    }

    return { sent, failed };
  }

  private loadOrGenerateVapid(): VapidKeys {
    if (!existsSync(HIVE_DIR)) mkdirSync(HIVE_DIR, { recursive: true });

    if (existsSync(VAPID_PATH)) {
      try {
        const parsed = JSON.parse(readFileSync(VAPID_PATH, "utf-8")) as Partial<VapidKeys>;
        if (
          typeof parsed.publicKey === "string" && parsed.publicKey.length > 0 &&
          typeof parsed.privateKey === "string" && parsed.privateKey.length > 0
        ) {
          // The private key must not be world-readable. Fix permissions on
          // files written by older versions ({ mode } only applies when the
          // file is first created).
          try { chmodSync(VAPID_PATH, 0o600); } catch { /* best-effort */ }
          return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
        console.log("[web-push] vapid.json parses but is missing key material — regenerating");
      } catch {
        // Corrupted  --  regenerate
      }
    }

    return this.generateAndStoreVapid();
  }

  private generateAndStoreVapid(): VapidKeys {
    const keys = webpush.generateVAPIDKeys();
    const vapid: VapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    try {
      writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2) + "\n", { mode: 0o600 });
      try { chmodSync(VAPID_PATH, 0o600); } catch { /* best-effort */ }
      console.log(`  Generated new VAPID keys → ${VAPID_PATH}`);
    } catch (err) {
      // Keys still work in-memory for this run; persisting can be retried
      // on the next start.
      console.log(`[web-push] Could not persist VAPID keys: ${err instanceof Error ? err.message : err}`);
    }
    return vapid;
  }

  private loadSubs(): StoredSub[] {
    try {
      if (existsSync(SUBS_PATH)) {
        return JSON.parse(readFileSync(SUBS_PATH, "utf-8"));
      }
    } catch {
      /* corrupted  --  start fresh */
    }
    return [];
  }

  private saveSubs(): void {
    try {
      // Push endpoints + auth secrets are capability tokens — keep them
      // out of reach of other local users, same as vapid.json.
      writeFileSync(SUBS_PATH, JSON.stringify(this.subs, null, 2) + "\n", { mode: 0o600 });
      try { chmodSync(SUBS_PATH, 0o600); } catch { /* best-effort */ }
    } catch {
      /* non-critical */
    }
  }
}
