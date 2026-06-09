# Hive Dashboard

Next.js frontend for the Hive daemon. Shows a vertical stack of full-width agent status tiles grouped by machine (up to 8 slots), with live chat, messaging, and spawn controls.

## Running

From the project root:
```bash
npm run dev:dashboard
```

Opens at `localhost:3000`. Requires the daemon running on port 3001/3002.

`npm -w apps/dashboard run start` serves the static export via `npx serve out` (`next start` is incompatible with `output: 'export'`).

## Components

| Component | Purpose |
|-----------|---------|
| `AgentCard` | Stoplight tile showing status, current action, and quick-reply buttons for stuck prompts |
| `ChatPanel` | Live conversation stream + message input |
| `SpawnDialog` | Spawn a new agent with a task prompt |
| `InviteDialog` | Invite collaborators with role-based tokens |
| `ReviewDrawer` | Slide-out drawer of recent pushes, deploys, and PRs |
| `LivePreview` | Terminal output preview for a tile |
| `DiagnosticsPanel` | Fleet check details (no UI trigger currently; `GET /api/check` is the supported health surface) |
| `ServiceWorker` | Service worker registration + Web Push subscription |
| `SitePasswordGate` | Viewer/Admin authentication toggle |

## Connecting to a Daemon

The dashboard resolves its WebSocket URL at runtime in this order: `?ws=` query param, then the stored URL from a previous session, then the baked `NEXT_PUBLIC_WS_URL` env value, then (when served from localhost or Tauri) the loopback default `ws://127.0.0.1:3002`. Static and desktop builds therefore do not require `NEXT_PUBLIC_WS_URL`.

Invite links and `?ws=` accept any `wss://` host (ngrok-free.app, ngrok.app, reserved/custom domains, self-hosted tunnels). Plain `ws://` is accepted only for loopback and private hosts (RFC1918, Tailscale 100.64/10 and `.ts.net`, `.local`, link-local), so a crafted link can never point the token at a plaintext public endpoint.

Message delivery is honest: sends while disconnected fail immediately (your draft is kept) instead of queueing silently, and daemon error frames surface in the activity line.

The service worker cache is versioned (`hive-v2`) and bounded to 64 entries.

## Remote Access

The supported hosted flow is:

```bash
npm start
npm run deploy:dashboard
```

`npm start` creates a public tunnel for the local WebSocket server and writes the public URL to `~/.hive/tunnel-url.txt`. `npm run deploy:dashboard` deploys this app to your Vercel account with that tunnel URL as `NEXT_PUBLIC_WS_URL`.
