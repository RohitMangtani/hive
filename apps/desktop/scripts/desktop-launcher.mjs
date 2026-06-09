import { chmodSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "fs";
import { extname, join, normalize } from "path";
import { homedir, platform } from "os";
import { spawn } from "child_process";
import { timingSafeEqual } from "crypto";
import http from "http";
import net from "net";

const runtimeRoot = process.env.HIVE_RUNTIME_ROOT;
if (!runtimeRoot) {
  throw new Error("HIVE_RUNTIME_ROOT is required.");
}

const mode = process.env.HIVE_DESKTOP_MODE || "fresh";
// One-time secret minted by the Tauri shell per launch. /bootstrap only reads
// the admin token from disk when the caller presents this secret, so arbitrary
// local processes cannot harvest the token from the loopback HTTP server.
const bootstrapSecret = process.env.HIVE_BOOTSTRAP_SECRET || "";
const primaryUrl = process.env.HIVE_DESKTOP_PRIMARY_URL || "";
const primaryToken = process.env.HIVE_DESKTOP_PRIMARY_TOKEN || "";
const dashboardPort = Number(process.env.HIVE_DASHBOARD_PORT || 3310);
const daemonPort = Number(process.env.HIVE_DAEMON_PORT || 3001);
const wsPort = Number(process.env.HIVE_WS_PORT || 3002);
const hiveRoot = join(runtimeRoot, "hive");
const daemonEntry = join(hiveRoot, "apps", "daemon", "dist", "index.js");
const dashboardRoot = join(hiveRoot, "apps", "dashboard", "out");
const logsDir = join(homedir(), ".hive", "logs");
const adminTokenPath = join(homedir(), ".hive", "token");
const desktopDaemonEntry = join(runtimeRoot, "launcher", "desktop-daemon.mjs");

mkdirSync(logsDir, { recursive: true });

const daemonLog = openSync(join(logsDir, "desktop-daemon.log"), "a");
const launcherLog = openSync(join(logsDir, "desktop-launcher.log"), "a");

const sendReturnBin = join(homedir(), "send-return");
const sendReturnSource = join(runtimeRoot, "tools", "send-return.swift");

// The daemon's two-step send relies on ~/send-return for the Return keystroke.
// CLI installs compile it in setup.sh; the desktop bundle has no shell scripts,
// so compile it here on first run when swiftc is available. Never overwrite an
// existing binary (its Accessibility grant is tied to the exact file).
function ensureSendReturn() {
  if (platform() !== "darwin") return;
  if (existsSync(sendReturnBin)) return;
  if (!existsSync(sendReturnSource)) {
    process.stderr.write("[desktop-launcher] WARNING: send-return source missing from runtime; dashboard sends will type text but cannot press Enter.\n");
    return;
  }
  const compile = spawn("swiftc", ["-o", sendReturnBin, sendReturnSource], {
    stdio: ["ignore", launcherLog, launcherLog],
  });
  compile.on("error", () => {
    process.stderr.write("[desktop-launcher] WARNING: swiftc not found; cannot compile ~/send-return. Dashboard sends will type text but cannot press Enter. Install Xcode Command Line Tools and relaunch.\n");
  });
  compile.on("exit", (code) => {
    if (code === 0) {
      try {
        chmodSync(sendReturnBin, 0o755);
      } catch {
        // Best effort only.
      }
      process.stdout.write(`[desktop-launcher] Compiled ${sendReturnBin}. Grant it Accessibility permission for auto-pilot.\n`);
    } else if (code !== null) {
      process.stderr.write(`[desktop-launcher] WARNING: swiftc exited with code ${code}; ~/send-return was not compiled. Dashboard sends will type text but cannot press Enter.\n`);
    }
  });
}

ensureSendReturn();

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // Ignore cleanup races.
      }
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

const reuseExistingDaemon = mode === "fresh" && await portOpen(daemonPort) && await portOpen(wsPort);

let daemonArgs = [desktopDaemonEntry];
if (mode === "connect") {
  daemonArgs = [daemonEntry];
  if (!primaryUrl || !primaryToken) {
    throw new Error("Connect mode requires primary URL and token.");
  }
  daemonArgs.push("--satellite", primaryUrl, primaryToken);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function secretMatches(candidate) {
  if (!bootstrapSecret || !candidate) return false;
  const expected = Buffer.from(bootstrapSecret);
  const provided = Buffer.from(candidate);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function bootstrapHtml(token) {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hive Bootstrap</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07090d; color: #f8fafc; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      p { color: #9aa4b2; }
    </style>
  </head>
  <body>
    <div>
      <h1>Bootstrapping Hive…</h1>
      <p>Persisting the local admin token and loading the dashboard.</p>
    </div>
    <script>
      localStorage.setItem("hive_token", ${safeToken});
      localStorage.setItem("hive_mode", "admin");
      location.replace("/");
    </script>
  </body>
</html>`;
}

function serveFile(res, filePath) {
  const extension = extname(filePath);
  const contentType = contentTypes[extension] || "application/octet-stream";
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": contentType,
  });
  createReadStream(filePath).pipe(res);
}

let dashboardServer = null;
let daemon = null;

if (mode === "fresh") {
  dashboardServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${dashboardPort}`);

    if (url.pathname === "/health") {
      sendJson(res, {
        mode,
        dashboardPort,
        daemonPort,
        wsPort,
        reuseExistingDaemon,
        tokenReady: existsSync(adminTokenPath),
        sendReturnReady: platform() !== "darwin" || existsSync(sendReturnBin),
      });
      return;
    }

    if (url.pathname === "/bootstrap" || url.pathname === "/bootstrap.html") {
      // Two legitimate callers: the webview passes ?token= explicitly (no new
      // information disclosed), and the Tauri shell's launch URL passes the
      // one-time ?secret= it minted. Anything else gets the token withheld so
      // arbitrary local processes cannot read ~/.hive/token over loopback.
      let token = url.searchParams.get("token") || "";
      if (!token && secretMatches(url.searchParams.get("secret"))) {
        token = existsSync(adminTokenPath) ? readFileSync(adminTokenPath, "utf8").trim() : "";
      } else if (!token) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden: bootstrap requires the launch secret or an explicit token.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(bootstrapHtml(token));
      return;
    }

    let filePath = normalize(join(dashboardRoot, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")));
    if (!filePath.startsWith(dashboardRoot)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      filePath = join(dashboardRoot, "index.html");
    }

    serveFile(res, filePath);
  });

  dashboardServer.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      process.stderr.write(`[desktop-launcher] Port ${dashboardPort} is already in use. Another Hive desktop launcher appears to be running. Stop it (or quit the other Hive window) and relaunch.\n`);
    } else {
      process.stderr.write(`[desktop-launcher] Dashboard server error: ${err && err.message ? err.message : err}\n`);
    }
    shutdown();
  });

  dashboardServer.listen(dashboardPort, "127.0.0.1");
}

if (!reuseExistingDaemon) {
  daemon = spawn(process.execPath, daemonArgs, {
    cwd: hiveRoot,
    env: {
      ...process.env,
      HIVE_DESKTOP_WRAPPER: "1",
      HIVE_RUNTIME_ROOT: runtimeRoot,
      HIVE_DAEMON_PORT: String(daemonPort),
      HIVE_WS_PORT: String(wsPort),
    },
    stdio: ["ignore", daemonLog, daemonLog],
  });
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (dashboardServer) {
    dashboardServer.close();
  }

  if (daemon) {
    try {
      daemon.kill("SIGTERM");
    } catch {
      // Best effort only.
    }
  }

  setTimeout(() => {
    if (daemon) {
      try {
        daemon.kill("SIGKILL");
      } catch {
        // Best effort only.
      }
    }
    process.exit(0);
  }, 4_000);
}

if (daemon) {
  daemon.on("exit", (code) => {
    if (shuttingDown) return;
    // Exit 0 in fresh mode means the runtime-singleton lock was lost: an
    // external daemon (e.g. launchd) already owns 3001/3002. Keep the 3310
    // dashboard server alive and serve against the existing daemon instead
    // of tearing the whole wrapper down.
    if (code === 0 && mode === "fresh" && dashboardServer) {
      daemon = null;
      process.stdout.write("[desktop-launcher] Daemon exited as duplicate; reusing the already-running daemon.\n");
      return;
    }
    if (code && code !== 0) {
      process.stderr.write(`Hive desktop daemon exited with code ${code}\n`);
    }
    shutdown();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the launcher alive even in satellite mode when only the daemon child is active.
setInterval(() => {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[desktop-launcher] ${timestamp} ${mode}\n`);
}, 60_000).unref();

process.stdout.write(`Hive desktop launcher running in ${mode} mode${reuseExistingDaemon ? " (reusing existing daemon)" : ""}.\n`);
process.stdout.write(`Logs: ${logsDir}\n`);
process.stdout.write(`Launcher log fd: ${launcherLog}\n`);
