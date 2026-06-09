/**
 * Daemon WebSocket URL validation + runtime resolution.
 *
 * Scheme discipline instead of a TLD allowlist:
 *  - wss:// is accepted for any host (TLS protects the token in transit),
 *    so ngrok-free.app, reserved/custom domains, and self-hosted tunnels work.
 *  - ws:// (plaintext) is only accepted for loopback/private/local hosts
 *    (localhost, RFC1918, CGNAT/Tailscale 100.64/10, link-local, .local,
 *    .ts.net, .localhost) so a crafted ?ws= link can never point the
 *    dashboard's token at a plaintext public endpoint.
 */

const DAEMON_URL_KEY = "hive_daemon_url";
/** Default daemon WS port for same-host (desktop/static) serves. */
const DEFAULT_LOCAL_WS = "ws://127.0.0.1:3002";

/** Loopback-only check: used to decide if the same-host default applies. */
export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") || // covers tauri.localhost
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Private/local host check: loopback + RFC1918 + CGNAT + link-local + local DNS suffixes. */
function isPrivateHost(rawHost: string): boolean {
  if (isLoopbackHost(rawHost)) return true;
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  // mDNS, Tailscale MagicDNS
  if (host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/.test(host) || host.startsWith("fe80")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (Tailscale)
  return false;
}

/** Validate a daemon WS URL: wss:// to any host, ws:// only to private/local hosts. */
export function isValidWsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:") return true;
    if (parsed.protocol !== "ws:") return false;
    return isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the daemon URL at runtime. Resolution order:
 *  1. explicit ?ws= query param (invite links, manual override)
 *  2. stored value (localStorage, written by invite links / setup)
 *  3. the build-time env value passed in (empty in static builds without NEXT_PUBLIC_WS_URL)
 *  4. same-host default for desktop/static serves only -- never applied on
 *     remote origins, so a hosted dashboard cannot silently probe a
 *     visitor's own machine (preserves the prod NEXT_PUBLIC_WS_URL hardening).
 */
export function resolveDaemonUrl(preferredUrl: string): string {
  if (typeof window === "undefined") return preferredUrl;
  try {
    const wsParam = new URLSearchParams(window.location.search).get("ws");
    if (wsParam && isValidWsUrl(wsParam)) return wsParam;
  } catch {
    /* malformed query, ignore */
  }
  try {
    const stored = window.localStorage.getItem(DAEMON_URL_KEY);
    if (stored) return stored;
  } catch {
    /* storage unavailable, ignore */
  }
  if (preferredUrl) return preferredUrl;
  if (isLoopbackHost(window.location.hostname) || window.location.protocol === "tauri:") {
    return DEFAULT_LOCAL_WS;
  }
  return "";
}
