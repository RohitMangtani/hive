import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { randomBytes } from "crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const runtimeRoot = join(desktopDir, ".generated", "runtime");
const launcherPath = join(runtimeRoot, "launcher", "desktop-launcher.mjs");
const nodePath = join(runtimeRoot, "bin", "node");

// The staged runtime ships its own ws package; reuse it so the smoke test
// works on Node 20 (no global WebSocket) without adding a desktop dependency.
const requireFromRuntime = createRequire(join(runtimeRoot, "hive", "package.json"));
const WebSocketClient = requireFromRuntime("ws");

const home = mkdtempSync(join(tmpdir(), "hive-desktop-smoke-"));
const dashboardPort = "3410";
const daemonPort = "3411";
const wsPort = "3412";
const bootstrapSecret = randomBytes(32).toString("hex");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, attempts = 60, init = undefined) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
    } catch {
      // Retry.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForHealth(predicate, attempts = 60) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${dashboardPort}/health`);
      if (response.ok) {
        last = await response.json();
        if (predicate(last)) return last;
      }
    } catch {
      // Retry.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health: ${JSON.stringify(last)}`);
}

async function waitForAuthenticatedWorkers(token, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response = null;
    try {
      response = await fetch(`http://127.0.0.1:${daemonPort}/api/workers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Daemon REST not up yet. Retry.
    }
    if (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Daemon rejected the admin token on /api/workers (${response.status}).`);
      }
      if (response.ok) {
        const body = await response.json();
        if (!Array.isArray(body)) {
          throw new Error("Daemon /api/workers did not return a workers array.");
        }
        return body;
      }
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for authenticated /api/workers on port ${daemonPort}`);
}

// One authenticated WS connection. The server sends {type:"workers"} first on
// a successful dashboard connection; a wiring regression (e.g. missing
// userRegistry) kills the daemon here instead of passing silently.
function checkWebSocket(token) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocketClient(`ws://127.0.0.1:${wsPort}/?token=${token}`);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Best effort only.
      }
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the authenticated WS workers message.")), 20_000);
    socket.on("message", (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "error") {
        finish(new Error(`WS handshake rejected: ${message.error}`));
      } else if (message.type === "workers") {
        finish();
      }
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error("WS closed before the workers message arrived.")));
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

const child = spawn(nodePath, [launcherPath], {
  env: {
    ...process.env,
    HOME: home,
    HIVE_RUNTIME_ROOT: runtimeRoot,
    HIVE_DESKTOP_MODE: "fresh",
    HIVE_DASHBOARD_PORT: dashboardPort,
    HIVE_DAEMON_PORT: daemonPort,
    HIVE_WS_PORT: wsPort,
    HIVE_BOOTSTRAP_SECRET: bootstrapSecret,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let ok = false;

try {
  await waitForHealth((health) => health.tokenReady === true);

  const token = readFileSync(join(home, ".hive", "token"), "utf8").trim();
  if (!token || token.length !== 64) {
    throw new Error("Desktop smoke test token was not generated correctly.");
  }

  // Bootstrap requires the launch secret; without it the token must be withheld.
  const blocked = await fetch(`http://127.0.0.1:${dashboardPort}/bootstrap.html`);
  if (blocked.status !== 403) {
    throw new Error(`Unauthenticated /bootstrap.html should return 403, got ${blocked.status}.`);
  }

  const bootstrap = await waitFor(`http://127.0.0.1:${dashboardPort}/bootstrap.html?secret=${bootstrapSecret}`);
  const bootstrapHtml = await bootstrap.text();
  if (!bootstrapHtml.includes("Bootstrapping Hive")) {
    throw new Error("Bootstrap page missing expected copy.");
  }
  if (!bootstrapHtml.includes(token)) {
    throw new Error("Bootstrap page with the launch secret did not embed the admin token.");
  }

  await waitFor(`http://127.0.0.1:${dashboardPort}/manifest.json`);

  // The daemon must accept an authenticated REST call and an authenticated
  // WS connection -- this catches crash-on-connect wiring regressions.
  const workers = await waitForAuthenticatedWorkers(token);
  const unauthenticated = await fetch(`http://127.0.0.1:${daemonPort}/api/workers`);
  if (unauthenticated.ok) {
    throw new Error("Daemon /api/workers accepted a request without a token.");
  }
  await checkWebSocket(token);

  if (child.exitCode !== null) {
    throw new Error(`Launcher exited early with code ${child.exitCode}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    dashboardPort,
    daemonPort,
    wsPort,
    workerCount: workers.length,
    home,
  }));
  ok = true;
} finally {
  child.kill("SIGTERM");
  await waitForExit(child);
  if (!ok) {
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    console.error(`Smoke temp HOME preserved at ${home}`);
  } else {
    rmSync(home, { recursive: true, force: true });
  }
}
