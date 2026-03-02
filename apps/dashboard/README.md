# Hive Dashboard

Next.js frontend for the Hive daemon. Shows a 2×2 grid of agent status cards with live chat, messaging, and spawn controls.

## Running

From the project root:
```bash
npm run dev:dashboard
```

Opens at `localhost:3000`. Requires the daemon running on port 3001/3002.

## Components

| Component | Purpose |
|-----------|---------|
| `AgentCard` | Stoplight card showing status, current action, and time |
| `ChatPanel` | Live conversation stream + message input |
| `SpawnDialog` | Spawn a new agent with a task prompt |
| `SitePasswordGate` | Viewer/Admin authentication toggle |

## Remote Access

Deploy to Vercel and use a cloudflared tunnel to connect the dashboard to your local daemon's WebSocket. Set `NEXT_PUBLIC_WS_URL` to your tunnel URL.
