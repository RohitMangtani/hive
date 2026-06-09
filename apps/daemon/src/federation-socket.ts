import { WebSocket } from "ws";

/**
 * Minimum socket surface the federation transport needs.
 *
 * We keep this intentionally narrow so the transport can be tested with a fake
 * socket and can later wrap something other than `ws` without changing the
 * higher-level satellite logic.
 */
export interface FederationSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeAllListeners?(): this;
}

/**
 * Why a connection closed, from the transport's point of view.
 *
 * The existing Hive recovery policy already distinguishes "normal close" from
 * "we stopped hearing from the primary". Surfacing that distinction keeps the
 * recovery policy in SatelliteClient while moving the socket mechanics here.
 */
export type FederationDisconnectReason = "closed" | "heartbeat-timeout";

/**
 * Rich disconnect context passed back to the higher-level satellite policy.
 *
 * The transport owns timing, retry delay, and active URL rotation. The caller
 * owns the business decision of whether to reconnect or trigger a self-heal.
 */
export interface FederationDisconnectMeta {
  url: string;
  reason: FederationDisconnectReason;
  connectionAgeMs: number;
  stable: boolean;
  /** True if the WebSocket actually opened before disconnecting. False if connection was refused/timed out. */
  wasConnected: boolean;
}

/**
 * Reconnect scheduling data exposed for logging and tests.
 */
export interface FederationReconnectMeta {
  nextUrl: string;
  delayMs: number;
  rotatedUrl: boolean;
}

/**
 * Callback contract for the transport.
 *
 * The transport is deliberately dumb about Hive commands. It only knows how to
 * authenticate, maintain liveness, and hand parsed payloads back to the
 * existing satellite command handler.
 */
export interface FederationSocketHooks<TIncoming, TOutgoing> {
  onOpen(): void;
  onMessage(message: TIncoming): void;
  onDisconnect(meta: FederationDisconnectMeta): Promise<"reconnect" | "handled"> | "reconnect" | "handled";
  onReconnectScheduled?(meta: FederationReconnectMeta): void;
  onHeartbeatTimeout?(meta: { url: string; silenceMs: number }): void;
  onMalformedMessage?(raw: string): void;
  isHeartbeatAck?(message: TIncoming): boolean;
  makeHeartbeat(): TOutgoing;
}

/**
 * Persistence hooks for primary URL candidates.
 *
 * Hive already persists these URLs under `~/.hive/`. Keeping storage outside
 * the transport avoids coupling this module to filesystem choices while still
 * letting it own rotation and reconnect behavior.
 */
export interface FederationUrlStore {
  load(): string[];
  save(urls: string[], activeUrl: string): void;
  /**
   * Optional append-only history of every primary URL ever learned.
   *
   * The live candidate list is capped at 5, so a long offline window can
   * evict URLs that later turn out to be the only working ones. Persisting
   * the full history (small LRU on the caller's side) gives operators and
   * the exhaustion fallback something to fall back on.
   */
  appendHistory?(url: string): void;
}

/**
 * Construction options for the transport.
 */
export interface FederationSocketOptions<TIncoming, TOutgoing> {
  primaryUrl: string;
  token: string;
  satelliteId: string;
  stableConnectionMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxReconnectDelayMs?: number;
  /**
   * How long a socket may sit in CONNECTING before the transport gives up on
   * it. Without this, a black-holed connection (tunnel edge accepts TCP but
   * the upgrade never completes) stalls reconnect and URL rotation until the
   * OS-level timeout fires (60-130s).
   */
  connectTimeoutMs?: number;
  socketFactory?: (url: string) => FederationSocketLike;
  parseMessage?: (raw: string) => TIncoming;
  urls: FederationUrlStore;
  hooks: FederationSocketHooks<TIncoming, TOutgoing>;
}

/**
 * Authenticated, self-healing WebSocket transport for Hive federation.
 *
 * This is a non-breaking wrapper around the existing satellite protocol. It
 * does not change any command payloads. It only centralizes the connection
 * mechanics that used to be spread through SatelliteClient:
 * - authenticated URL construction
 * - reconnect backoff
 * - primary URL candidate rotation
 * - liveness heartbeat
 * - malformed frame isolation
 *
 * That separation makes the transport easier to reason about, test, and extend
 * without dragging the operational command layer into every socket change.
 */
export class FederationSocketClient<TIncoming extends { type?: string }, TOutgoing> {
  private readonly token: string;
  private readonly satelliteId: string;
  private readonly stableConnectionMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly socketFactory: (url: string) => FederationSocketLike;
  private readonly parseMessage: (raw: string) => TIncoming;
  private readonly urls: FederationUrlStore;
  private readonly hooks: FederationSocketHooks<TIncoming, TOutgoing>;

  private readonly connectTimeoutMs: number;
  /** The URL this transport was constructed with — the install-time URL on
   *  satellites, since the supervisor config bakes it into the launch args. */
  private readonly installUrl: string;

  private currentPrimaryUrl: string;
  private primaryUrlCandidates: string[] = [];
  private primaryUrlIndex = 0;
  private socket: FederationSocketLike | null = null;
  private reconnectDelayMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt = 0;
  private lastInboundAt = 0;
  private stopped = false;
  private pendingDisconnectReason: FederationDisconnectReason = "closed";
  private reconnectAttemptsSinceOpen = 0;

  constructor(options: FederationSocketOptions<TIncoming, TOutgoing>) {
    this.currentPrimaryUrl = this.normalizePrimaryUrl(options.primaryUrl);
    this.installUrl = this.currentPrimaryUrl;
    this.token = options.token;
    this.satelliteId = options.satelliteId;
    this.stableConnectionMs = options.stableConnectionMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.parseMessage = options.parseMessage ?? ((raw) => JSON.parse(raw) as TIncoming);
    this.urls = options.urls;
    this.hooks = options.hooks;
    this.rememberPrimaryUrl(this.currentPrimaryUrl, true);
  }

  /**
   * Start the transport.
   *
   * We keep `start()` idempotent so callers can treat it like a lifecycle hook
   * and not worry about duplicate timers or duplicate socket opens.
   */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /**
   * Stop the transport and suppress any future reconnects.
   */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearConnectTimer();
    const active = this.socket;
    this.socket = null;
    if (active) {
      active.removeAllListeners?.();
      active.close();
    }
  }

  /**
   * Send a protocol payload if the socket is currently open.
   *
   * Missing an opportunistic send is safer than queueing stale control-plane
   * traffic in memory. The existing higher-level logic already handles retries
   * for the operations that need them.
   *
   * Returns true only when the frame was handed to an OPEN socket, so callers
   * can report dropped sends truthfully instead of assuming delivery.
   */
  send(message: TOutgoing): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Persist a newly learned primary URL and optionally prioritize it.
   *
   * The primary broadcasts its current tunnel URL. Satellites remember that
   * URL so a later reconnect uses the freshest known address without any user
   * intervention.
   */
  rememberPrimaryUrl(url: string, prioritize = false): void {
    const normalized = this.normalizePrimaryUrl(url);
    if (!normalized) return;

    try {
      this.urls.appendHistory?.(normalized);
    } catch { /* history is best-effort */ }

    const merged = [
      ...(prioritize ? [normalized] : []),
      ...this.primaryUrlCandidates,
      ...this.urls.load().map((value) => this.normalizePrimaryUrl(value)).filter(Boolean),
      ...(!prioritize ? [normalized] : []),
    ].filter(Boolean);

    this.primaryUrlCandidates = Array.from(new Set(merged)).slice(0, 5);
    this.primaryUrlIndex = this.primaryUrlCandidates.indexOf(normalized);
    if (this.primaryUrlIndex < 0) this.primaryUrlIndex = 0;
    this.currentPrimaryUrl = normalized;
    this.urls.save(this.primaryUrlCandidates, this.currentPrimaryUrl);
  }

  /**
   * Resume reconnect flow after a caller-handled failure path.
   *
   * SatelliteClient uses this when a self-heal attempt fails and it wants to
   * drop back to the normal reconnect loop without reimplementing it.
   */
  scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.scheduleReconnectInternal(false);
  }

  private connect(): void {
    this.clearReconnectTimer();
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.loadPrimaryUrlCandidates();
    const url = this.buildAuthenticatedUrl(this.currentPrimaryUrl);
    const socket = this.socketFactory(url);
    this.socket = socket;

    // Connect/handshake timeout: a socket stuck in CONNECTING has no timer of
    // its own (the heartbeat watchdog only starts on "open"), so without this
    // a black-holed dial stalls reconnect and URL rotation for the OS-level
    // TCP timeout. Terminating feeds the normal close → reconnect path.
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || this.stopped) return;
      if (socket.readyState === WebSocket.OPEN) return;
      console.log(`[federation] Connect attempt to ${this.currentPrimaryUrl} timed out after ${Math.round(this.connectTimeoutMs / 1000)}s`);
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    }, this.connectTimeoutMs);

    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) {
        socket.close();
        return;
      }
      this.clearConnectTimer();
      this.connectedAt = Date.now();
      this.lastInboundAt = this.connectedAt;
      this.reconnectDelayMs = 1_000;
      this.reconnectAttemptsSinceOpen = 0;
      this.pendingDisconnectReason = "closed";
      this.startHeartbeatLoop();
      this.hooks.onOpen();
    });

    socket.on("message", (raw) => {
      if (this.socket !== socket || this.stopped) return;
      this.lastInboundAt = Date.now();
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
      try {
        const message = this.parseMessage(text);
        if (this.hooks.isHeartbeatAck?.(message)) return;
        this.hooks.onMessage(message);
      } catch {
        this.hooks.onMalformedMessage?.(text);
      }
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectTimer();
      this.clearHeartbeatTimer();
      this.handleDisconnect(this.pendingDisconnectReason).catch((err) => {
        console.log(`[federation] Disconnect handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.pendingDisconnectReason = "closed";
    });

    socket.on("error", () => {
      if (this.socket !== socket) return;
      // The ws client will emit `close` next. Keeping reconnect decisions in a
      // single place avoids split-brain retry logic.
    });
  }

  private async handleDisconnect(reason: FederationDisconnectReason): Promise<void> {
    if (this.stopped) return;

    const now = Date.now();
    const wasConnected = this.connectedAt > 0;
    const connectionAgeMs = wasConnected ? now - this.connectedAt : 0;
    const stable = connectionAgeMs >= this.stableConnectionMs;
    this.connectedAt = 0;

    const decision = await this.hooks.onDisconnect({
      url: this.currentPrimaryUrl,
      reason,
      connectionAgeMs,
      stable,
      wasConnected,
    });

    if (this.stopped || decision === "handled") return;
    this.scheduleReconnectInternal(!stable);
  }

  private scheduleReconnectInternal(rotateUrl: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    const rotatedUrl = rotateUrl ? this.rotatePrimaryUrlCandidate() : false;
    this.reconnectAttemptsSinceOpen += 1;
    this.handleRotationExhaustion();
    const delayMs = this.reconnectDelayMs;
    this.hooks.onReconnectScheduled?.({
      nextUrl: this.currentPrimaryUrl,
      delayMs,
      rotatedUrl,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
  }

  private startHeartbeatLoop(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      const active = this.socket;
      if (!active || active.readyState !== WebSocket.OPEN) return;

      const silenceMs = Date.now() - this.lastInboundAt;
      if (silenceMs > this.heartbeatTimeoutMs) {
        this.pendingDisconnectReason = "heartbeat-timeout";
        this.hooks.onHeartbeatTimeout?.({ url: this.currentPrimaryUrl, silenceMs });
        if (typeof active.terminate === "function") active.terminate();
        else active.close();
        return;
      }

      this.send(this.hooks.makeHeartbeat());
    }, this.heartbeatIntervalMs);
  }

  /**
   * Out-of-band recovery for the ephemeral-tunnel orphan case.
   *
   * When the primary's tunnel restarts with a brand-new URL while every
   * satellite is disconnected, all persisted candidates are dead and the
   * normal rotation can never recover. Once a full cycle through the
   * candidates has failed, log an explicit operator runbook line and, if the
   * install-time URL was evicted from the capped candidate list, retry it as
   * an extra fallback. This is purely additive: the locked rotation behavior
   * is untouched for every attempt where candidates still work.
   */
  private handleRotationExhaustion(): void {
    const cycleLen = Math.max(this.primaryUrlCandidates.length, 1) + 1;
    if (this.reconnectAttemptsSinceOpen === 0 || this.reconnectAttemptsSinceOpen % cycleLen !== 0) return;

    console.log(`[federation] Exhausted all ${this.primaryUrlCandidates.length || 1} known primary URL candidate(s) without connecting (${this.reconnectAttemptsSinceOpen} attempts since last successful connection).`);
    console.log(`[federation] Runbook: the primary's tunnel URL may have rotated while this satellite was offline. On the primary run: cat ~/.hive/tunnel-url.txt — then on this machine run: bash scripts/install.sh --connect <new-url> \"$(cat ~/.hive/primary-token)\"`);

    if (
      this.installUrl &&
      this.currentPrimaryUrl !== this.installUrl &&
      !this.primaryUrlCandidates.includes(this.installUrl)
    ) {
      console.log(`[federation] Also retrying the original install-time URL: ${this.installUrl}`);
      // connect() folds currentPrimaryUrl back into the candidate list, so a
      // working install URL re-enters rotation naturally.
      this.currentPrimaryUrl = this.installUrl;
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private loadPrimaryUrlCandidates(): void {
    const candidates = [
      this.currentPrimaryUrl,
      ...this.urls.load(),
    ].map((value) => this.normalizePrimaryUrl(value)).filter(Boolean);

    if (candidates.length === 0) return;
    this.primaryUrlCandidates = Array.from(new Set(candidates)).slice(0, 5);
    const currentIndex = this.primaryUrlCandidates.indexOf(this.currentPrimaryUrl);
    this.primaryUrlIndex = currentIndex >= 0 ? currentIndex : 0;
    this.currentPrimaryUrl = this.primaryUrlCandidates[this.primaryUrlIndex]!;
    this.urls.save(this.primaryUrlCandidates, this.currentPrimaryUrl);
  }

  private rotatePrimaryUrlCandidate(): boolean {
    this.loadPrimaryUrlCandidates();
    if (this.primaryUrlCandidates.length <= 1) return false;
    this.primaryUrlIndex = (this.primaryUrlIndex + 1) % this.primaryUrlCandidates.length;
    this.currentPrimaryUrl = this.primaryUrlCandidates[this.primaryUrlIndex]!;
    this.urls.save(this.primaryUrlCandidates, this.currentPrimaryUrl);
    return true;
  }

  private buildAuthenticatedUrl(baseUrl: string): string {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}token=${encodeURIComponent(this.token)}&satellite=${encodeURIComponent(this.satelliteId)}`;
  }

  private normalizePrimaryUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("https://")) return trimmed.replace("https://", "wss://");
    return trimmed;
  }
}
