import { describe, expect, it } from "vitest";
import {
  chooseSatelliteRecoveryAction,
  chooseSatelliteUpdateGate,
  isRecentlyFailedHead,
  satelliteUpdateBackoffMs,
  SATELLITE_UPDATE_FAILED_HEAD_COOLDOWN_MS,
  SATELLITE_UPDATE_GIVEUP_RETRY_MS,
  SATELLITE_UPDATE_MAX_ATTEMPTS,
} from "../satellite-recovery.js";

describe("chooseSatelliteRecoveryAction", () => {
  it("does nothing for a normal reconnect blip", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 1,
      shortLivedConnections: 0,
      offlineMs: 10_000,
      selfHealAttempts: 0,
      msSinceLastSelfHeal: Number.POSITIVE_INFINITY,
    })).toBe("none");
  });

  it("triggers repair after repeated short-lived failures", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 4,
      shortLivedConnections: 4,
      offlineMs: 30_000,
      selfHealAttempts: 0,
      msSinceLastSelfHeal: Number.POSITIVE_INFINITY,
    })).toBe("repair");
  });

  it("escalates to reinstall after a prior self-heal failed to stabilize the satellite", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 5,
      shortLivedConnections: 4,
      offlineMs: 120_000,
      selfHealAttempts: 1,
      msSinceLastSelfHeal: 300_000,
    })).toBe("reinstall");
  });

  it("respects the self-heal cooldown", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 8,
      shortLivedConnections: 8,
      offlineMs: 180_000,
      selfHealAttempts: 1,
      msSinceLastSelfHeal: 30_000,
    })).toBe("none");
  });

  it("stops escalating forever once repair and reinstall were both attempted", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 12,
      shortLivedConnections: 12,
      offlineMs: 600_000,
      selfHealAttempts: 2,
      msSinceLastSelfHeal: 600_000,
    })).toBe("none");
  });
});

describe("satelliteUpdateBackoffMs", () => {
  it("is immediate for the first attempt and grows exponentially after", () => {
    expect(satelliteUpdateBackoffMs(0)).toBe(0);
    expect(satelliteUpdateBackoffMs(1)).toBe(5 * 60_000);
    expect(satelliteUpdateBackoffMs(2)).toBe(20 * 60_000);
    expect(satelliteUpdateBackoffMs(3)).toBe(80 * 60_000);
  });

  it("caps at the give-up retry interval", () => {
    expect(satelliteUpdateBackoffMs(50)).toBe(SATELLITE_UPDATE_GIVEUP_RETRY_MS);
  });
});

describe("chooseSatelliteUpdateGate", () => {
  const now = 1_000_000_000;

  it("allows the first update from any version", () => {
    expect(chooseSatelliteUpdateGate({
      runningVersion: "abc12345",
      state: null,
      now,
    })).toEqual({ allowed: true, attempts: 0 });
  });

  it("resets the counter when the running version changed since the failures", () => {
    expect(chooseSatelliteUpdateGate({
      runningVersion: "newversi",
      state: { fromVersion: "oldversi", attempts: 3, lastAttemptAt: now - 1 },
      now,
    })).toEqual({ allowed: true, attempts: 0 });
  });

  it("never gates the version-unknown repair path", () => {
    expect(chooseSatelliteUpdateGate({
      runningVersion: "unknown",
      state: { fromVersion: "unknown", attempts: 10, lastAttemptAt: now - 1 },
      now,
    })).toEqual({ allowed: true, attempts: 0 });
  });

  it("blocks a retry inside the backoff window", () => {
    const decision = chooseSatelliteUpdateGate({
      runningVersion: "abc12345",
      state: { fromVersion: "abc12345", attempts: 1, lastAttemptAt: now - 60_000 },
      now,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.gaveUp).toBe(false);
      expect(decision.retryInMs).toBe(4 * 60_000);
    }
  });

  it("allows a retry once the backoff window elapsed", () => {
    expect(chooseSatelliteUpdateGate({
      runningVersion: "abc12345",
      state: { fromVersion: "abc12345", attempts: 1, lastAttemptAt: now - 5 * 60_000 },
      now,
    })).toEqual({ allowed: true, attempts: 1 });
  });

  it("enters a loud give-up state after max attempts but still permits a long-cooldown retry", () => {
    const blocked = chooseSatelliteUpdateGate({
      runningVersion: "abc12345",
      state: { fromVersion: "abc12345", attempts: SATELLITE_UPDATE_MAX_ATTEMPTS, lastAttemptAt: now - 60_000 },
      now,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.gaveUp).toBe(true);
      expect(blocked.reason).toContain("manual intervention");
    }

    expect(chooseSatelliteUpdateGate({
      runningVersion: "abc12345",
      state: { fromVersion: "abc12345", attempts: SATELLITE_UPDATE_MAX_ATTEMPTS, lastAttemptAt: now - SATELLITE_UPDATE_GIVEUP_RETRY_MS },
      now,
    })).toEqual({ allowed: true, attempts: SATELLITE_UPDATE_MAX_ATTEMPTS });
  });
});

describe("isRecentlyFailedHead", () => {
  const now = 1_000_000_000;

  it("matches only the recorded commit inside the cooldown", () => {
    const state = { fromVersion: "abc12345", attempts: 0, lastAttemptAt: 0, failedHead: "deadbeef", failedAt: now - 60_000 };
    expect(isRecentlyFailedHead(state, "deadbeef", now)).toBe(true);
    expect(isRecentlyFailedHead(state, "cafebabe", now)).toBe(false);
    expect(isRecentlyFailedHead(null, "deadbeef", now)).toBe(false);
  });

  it("expires after the cooldown so the commit gets a fresh validation run", () => {
    const state = { fromVersion: "abc12345", attempts: 0, lastAttemptAt: 0, failedHead: "deadbeef", failedAt: now - SATELLITE_UPDATE_FAILED_HEAD_COOLDOWN_MS };
    expect(isRecentlyFailedHead(state, "deadbeef", now)).toBe(false);
  });
});
