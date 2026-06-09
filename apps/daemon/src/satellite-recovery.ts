export type SatelliteRecoveryAction = "none" | "repair" | "reinstall";

export interface SatelliteRecoveryDecisionInput {
  consecutiveFailures: number;
  shortLivedConnections: number;
  offlineMs: number;
  selfHealAttempts: number;
  msSinceLastSelfHeal: number;
  /** True if the satellite has NEVER successfully connected since startup. */
  neverConnected?: boolean;
}

export const SATELLITE_STABLE_CONNECTION_MS = 60_000;
export const SATELLITE_SELF_HEAL_COOLDOWN_MS = 120_000;
export const SATELLITE_REPAIR_FAILURE_THRESHOLD = 4;
export const SATELLITE_REPAIR_OFFLINE_MS = 90_000;

/**
 * Decide whether to self-heal (repair/reinstall) or just keep reconnecting.
 *
 * Key insight: when the primary's tunnel is down, self-heal makes things worse
 * because repair/reinstall both call process.exit(0), causing launchd to
 * throttle and eventually stop the service. The satellite should only self-heal
 * for LOCAL issues (broken install, stale config). If we had a connection before
 * and now can't reconnect, the primary is likely just unreachable — keep trying.
 *
 * Self-heal triggers ONLY when:
 * - shortLivedConnections >= threshold (connects but immediately drops = local issue)
 * - AND we're past the cooldown
 *
 * Pure connection failures (never connected, or lost connection and can't get back)
 * are treated as "primary unreachable" — no self-heal, just exponential backoff.
 */
export function chooseSatelliteRecoveryAction(
  input: SatelliteRecoveryDecisionInput,
): SatelliteRecoveryAction {
  if (input.msSinceLastSelfHeal < SATELLITE_SELF_HEAL_COOLDOWN_MS) {
    return "none";
  }

  // Already tried twice — stop escalating
  if (input.selfHealAttempts >= 2) return "none";

  // Short-lived connections (connects then immediately drops) suggest a local issue
  // like version mismatch, broken dependencies, or corrupt state. Self-heal.
  if (input.shortLivedConnections >= SATELLITE_REPAIR_FAILURE_THRESHOLD) {
    return input.selfHealAttempts >= 1 ? "reinstall" : "repair";
  }

  // Pure connection failures (can't reach primary at all) — don't self-heal.
  // The primary tunnel is probably down. Keep reconnecting with backoff.
  // The primary's TunnelHealthMonitor will restart the tunnel, and URL rotation
  // + broadcast will eventually restore the connection.
  return "none";
}

// ---------------------------------------------------------------------------
//  satellite_update attempt gating
//
//  The primary re-sends satellite_update on every satellite_hello whenever git
//  hashes differ. If `git pull --ff-only` cannot converge on the primary's
//  commit (unpushed primary commits, divergent branch), the naive flow loops
//  forever: pull → install → restart → hello → mismatch → update. These pure
//  policy helpers add a persisted attempt counter with exponential backoff and
//  a give-up state so the satellite reports "version stuck" loudly instead of
//  burning a multi-minute install cycle on every reconnect.
//
//  Reset semantics (deliberate, see audit fix-risk notes):
//  - State is keyed on the version the satellite was RUNNING when the attempt
//    failed. As soon as an update actually converges, the running version
//    changes and the gate opens with a fresh counter.
//  - A runningVersion of "unknown" never gates: that is the maintenance-repair
//    path (broken repo) and must always be allowed to attempt recovery.
//  - The give-up state is not permanent: a long-cooldown retry remains so a
//    later reachable push still lands without human action.
// ---------------------------------------------------------------------------

export const SATELLITE_UPDATE_MAX_ATTEMPTS = 4;
export const SATELLITE_UPDATE_BASE_BACKOFF_MS = 5 * 60_000;
export const SATELLITE_UPDATE_GIVEUP_RETRY_MS = 6 * 60 * 60_000;
/** How long a commit that failed validation/install is skipped before retrying. */
export const SATELLITE_UPDATE_FAILED_HEAD_COOLDOWN_MS = 30 * 60_000;

export interface SatelliteUpdateAttemptState {
  /** Running-code version (short git hash) the failed attempts started from. */
  fromVersion: string;
  attempts: number;
  lastAttemptAt: number;
  /** Last pulled commit that failed the validation/install gate. */
  failedHead?: string;
  failedAt?: number;
}

export interface SatelliteUpdateGateInput {
  runningVersion: string;
  state: SatelliteUpdateAttemptState | null;
  now: number;
}

export type SatelliteUpdateGateDecision =
  | { allowed: true; attempts: number }
  | { allowed: false; reason: string; retryInMs: number; gaveUp: boolean };

/** Exponential backoff between stuck-update attempts: 5m, 20m, 80m, ... */
export function satelliteUpdateBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(
    SATELLITE_UPDATE_BASE_BACKOFF_MS * Math.pow(4, attempts - 1),
    SATELLITE_UPDATE_GIVEUP_RETRY_MS,
  );
}

export function chooseSatelliteUpdateGate(
  input: SatelliteUpdateGateInput,
): SatelliteUpdateGateDecision {
  const { runningVersion, state, now } = input;
  // No prior failures from this running version → always allow. This is what
  // keeps the offline-satellite catch-up path working: any version change
  // (either side) resets the counter implicitly.
  if (!state || runningVersion === "unknown" || state.fromVersion !== runningVersion) {
    return { allowed: true, attempts: 0 };
  }

  const gaveUp = state.attempts >= SATELLITE_UPDATE_MAX_ATTEMPTS;
  const waitMs = gaveUp
    ? SATELLITE_UPDATE_GIVEUP_RETRY_MS
    : satelliteUpdateBackoffMs(state.attempts);
  const elapsedMs = now - state.lastAttemptAt;
  if (elapsedMs >= waitMs) {
    return { allowed: true, attempts: state.attempts };
  }
  const retryInMs = waitMs - elapsedMs;
  const reason = gaveUp
    ? `update loop: still on ${state.fromVersion} after ${state.attempts} attempts — gave up, manual intervention required (auto-retry in ${Math.ceil(retryInMs / 60_000)}m)`
    : `update backoff: ${state.attempts} failed attempt(s) from ${state.fromVersion}, retry in ${Math.ceil(retryInMs / 1_000)}s`;
  return { allowed: false, reason, retryInMs, gaveUp };
}

/** True when the pulled commit recently failed the validation/install gate. */
export function isRecentlyFailedHead(
  state: SatelliteUpdateAttemptState | null,
  head: string,
  now: number,
): boolean {
  if (!state?.failedHead || state.failedHead !== head) return false;
  return now - (state.failedAt || 0) < SATELLITE_UPDATE_FAILED_HEAD_COOLDOWN_MS;
}
