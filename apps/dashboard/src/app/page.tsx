"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHive } from "@/lib/ws";
import type { WorkerState } from "@/lib/types";

const DEFAULT_URL = "ws://localhost:3002";

// --- Helpers ---

function statusClass(w: WorkerState): "active" | "needs" | "queued" | "idle" {
  if (w.status === "stuck") return "needs";
  if (w.status === "working") return "active";
  if (w.status === "waiting") return "active";
  return "idle";
}

function statusLabel(w: WorkerState): string {
  if (w.status === "stuck")
    return w.currentAction || "Needs direction";
  if (w.status === "working")
    return w.currentAction || "Working...";
  if (w.status === "waiting")
    return w.lastAction || "Waiting";
  return "Idle";
}

function timeActive(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Position agents in a natural spatial layout (like Find My iPhone pins)
function agentPositions(count: number): { x: number; y: number }[] {
  const positions = [
    { x: 25, y: 18 },
    { x: 55, y: 30 },
    { x: 70, y: 60 },
    { x: 30, y: 70 },
    { x: 80, y: 20 },
    { x: 15, y: 45 },
    { x: 50, y: 80 },
    { x: 85, y: 45 },
    { x: 40, y: 50 },
    { x: 65, y: 15 },
  ];
  return positions.slice(0, count);
}

// --- Setup Screen ---

function SetupScreen({ onConnect }: { onConnect: (url: string, token: string) => void }) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState("");

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg)]">
      <form
        onSubmit={(e) => { e.preventDefault(); if (token.trim()) onConnect(url.trim(), token.trim()); }}
        className="w-full max-w-sm space-y-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold text-center tracking-tight">FIND MY AGENTS</h1>
        <p className="text-sm text-[var(--text-muted)] text-center">Connect to your local daemon</p>
        <input
          type="text" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://localhost:3002"
          className="w-full bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-neutral-400"
        />
        <input
          type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="Auth token from daemon"
          className="w-full bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-neutral-400"
        />
        <button
          type="submit" disabled={!token.trim()}
          className="w-full text-sm px-4 py-2.5 rounded-lg bg-neutral-900 text-white disabled:opacity-30 hover:bg-neutral-800 transition-colors font-medium"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

// --- Agent Card (left sidebar) ---

function AgentCard({
  worker,
  selected,
  onClick,
}: {
  worker: WorkerState;
  selected: boolean;
  onClick: () => void;
}) {
  const sc = statusClass(worker);
  const agentColor = worker.color || (
    sc === "needs" ? "var(--dot-needs)" :
    sc === "active" ? "var(--dot-active)" :
    "var(--dot-idle)"
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`agent-card w-full text-left ${sc === "needs" ? "needs-direction" : ""} ${selected ? "selected" : ""}`}
      style={{ borderLeftColor: agentColor, borderLeftWidth: "3px" }}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 w-3 h-3 rounded-full shrink-0 ${sc === "needs" ? "animate-pulse" : ""}`}
          style={{ background: agentColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm truncate">{worker.projectName}</span>
            {worker.tty && (
              <span className="text-[10px] font-mono text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">{worker.tty}</span>
            )}
          </div>
          <p className={`text-xs mt-0.5 truncate ${sc === "needs" ? "text-[var(--dot-needs)] font-medium" : "text-[var(--text-muted)]"}`}>
            {statusLabel(worker)}
          </p>
          <p className="text-[10px] text-[var(--text-light)] mt-0.5 truncate">
            PID {worker.pid} · {timeActive(worker.startedAt)}
          </p>
        </div>
      </div>
    </button>
  );
}

// --- Agent Map (right side) ---

function AgentMap({
  workers,
  selectedId,
  onSelect,
}: {
  workers: WorkerState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const positions = useMemo(() => agentPositions(workers.length), [workers.length]);

  return (
    <div className="relative w-full h-full bg-[var(--bg-panel)] rounded-2xl border border-[var(--border)] overflow-hidden">
      {/* Grid dots background */}
      <div className="absolute inset-0" style={{
        backgroundImage: "radial-gradient(circle, #d4d4d4 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }} />

      {/* "Live view" indicator */}
      <div className="absolute top-4 right-5 flex items-center gap-2 z-20">
        <span className="text-xs text-[var(--text-muted)] font-medium">Live view</span>
        <span className="w-2.5 h-2.5 rounded-full bg-[var(--dot-active)]" />
      </div>

      {/* "Agent Map" title */}
      <div className="absolute top-4 left-5 z-20">
        <span className="text-sm font-semibold text-[var(--text)]">Agent Map</span>
      </div>

      {/* Connection lines (dashed) */}
      <svg className="absolute inset-0 w-full h-full z-0" xmlns="http://www.w3.org/2000/svg">
        {workers.length > 1 && positions.map((pos, i) => {
          // Connect to next agent and to a "nearby" one
          const next = positions[(i + 1) % positions.length];
          return (
            <line
              key={`line-${i}`}
              x1={`${pos.x}%`} y1={`${pos.y}%`}
              x2={`${next.x}%`} y2={`${next.y}%`}
              stroke="#d4d4d4"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          );
        })}
      </svg>

      {/* Agent dots */}
      {workers.map((w, i) => {
        const pos = positions[i];
        if (!pos) return null;
        const sc = statusClass(w);
        const isSelected = w.id === selectedId;
        const agentColor = w.color || (
          sc === "needs" ? "var(--dot-needs)" :
          sc === "active" ? "var(--dot-active)" :
          "var(--dot-idle)"
        );

        return (
          <button
            key={w.id}
            type="button"
            onClick={() => onSelect(w.id)}
            className="absolute z-10 group"
            style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%, -50%)" }}
          >
            {/* Dot */}
            <div
              className={`w-4 h-4 rounded-full ${isSelected ? "ring-2 ring-neutral-900 ring-offset-2" : ""} ${sc === "needs" ? "animate-pulse" : ""}`}
              style={{
                background: agentColor,
                boxShadow: `0 0 0 4px ${agentColor}22`,
                position: "relative",
              }}
            />
            {/* Label */}
            <div className="absolute top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-center">
              <span className={`text-xs font-semibold ${isSelected ? "text-[var(--text)]" : "text-[var(--text-muted)]"}`}>
                {w.projectName}
              </span>
              <div className="mt-0.5">
                <span className="text-[10px] text-[var(--text-light)]">
                  {sc === "active" ? statusLabel(w) : sc === "needs" ? "" : "(idle)"}
                </span>
              </div>
              {sc === "needs" && (
                <div className="mt-0.5">
                  <span className="needs-badge">needs direction</span>
                </div>
              )}
            </div>
          </button>
        );
      })}

      {/* Empty state */}
      {workers.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-[var(--text-muted)]">No agents detected</p>
        </div>
      )}
    </div>
  );
}

// --- Chat Drawer ---

function ChatDrawer({
  worker,
  messages,
  onSend,
  onClose,
}: {
  worker: WorkerState;
  messages: string[];
  onSend: (msg: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const sc = statusClass(worker);

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: worker.color || "var(--dot-idle)" }} />
            <span className="font-semibold text-sm">{worker.projectName}</span>
            {worker.tty && <span className="text-[10px] font-mono text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">{worker.tty}</span>}
            {!worker.managed && <span className="text-[10px] text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">read-only</span>}
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">PID {worker.pid} · {timeActive(worker.startedAt)} active</p>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-xs text-[var(--text-muted)]">
        {messages.length === 0 && (
          <p className="text-center text-[var(--text-light)] mt-8">
            {worker.managed ? "Send a message to this agent..." : "Discovered agent — output not available"}
          </p>
        )}
        {messages.map((msg, i) => (
          <pre key={i} className="whitespace-pre-wrap break-words">{msg}</pre>
        ))}
      </div>

      {worker.managed && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (input.trim()) { onSend(input.trim()); setInput(""); } }}
          className="border-t border-[var(--border)] p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message this agent..."
            className="w-full bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-neutral-400"
          />
        </form>
      )}
    </div>
  );
}

// --- Main Page ---

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const u = localStorage.getItem("hive_daemon_url");
    const t = localStorage.getItem("hive_token");
    if (u && t) { setDaemonUrl(u); setToken(t); }
    setLoaded(true);
  }, []);

  const { connected, workers, chatMessages, send } = useHive(daemonUrl ?? "", token ?? "");

  const handleConnect = useCallback((url: string, t: string) => {
    // Normalize URL: https:// → wss://, http:// → ws://
    let normalized = url;
    if (normalized.startsWith("https://")) normalized = "wss://" + normalized.slice(8);
    else if (normalized.startsWith("http://")) normalized = "ws://" + normalized.slice(7);
    else if (!normalized.startsWith("ws://") && !normalized.startsWith("wss://")) normalized = "wss://" + normalized;
    // Strip trailing slash
    normalized = normalized.replace(/\/+$/, "");
    localStorage.setItem("hive_daemon_url", normalized);
    localStorage.setItem("hive_token", t);
    setDaemonUrl(normalized);
    setToken(t);
  }, []);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem("hive_daemon_url");
    localStorage.removeItem("hive_token");
    setDaemonUrl(null);
    setToken(null);
  }, []);

  if (!loaded) return <main className="min-h-screen bg-[var(--bg)]" />;
  if (!token) return <SetupScreen onConnect={handleConnect} />;

  const workersArray = Array.from(workers.values());
  const activeCount = workersArray.filter((w) => w.status === "working" || w.status === "waiting").length;
  const needsCount = workersArray.filter((w) => w.status === "stuck").length;
  const selectedWorker = selectedId ? workers.get(selectedId) : null;

  const summaryParts: string[] = [];
  if (activeCount > 0) summaryParts.push(`${activeCount} active`);
  if (needsCount > 0) summaryParts.push(`${needsCount} needs direction`);
  if (summaryParts.length === 0 && workersArray.length > 0) summaryParts.push(`${workersArray.length} idle`);

  return (
    <main className="h-screen flex flex-col bg-[var(--bg)]">
      {/* Title */}
      <div className="text-center pt-6 pb-4">
        <h1 className="text-base font-bold tracking-[0.2em] uppercase text-[var(--text)]">Find My Agents</h1>
      </div>

      {/* Connection indicator */}
      <div className="text-center pb-2 flex items-center justify-center gap-3">
        {!connected && (
          <span className="text-xs text-[var(--dot-needs)] font-medium">Disconnected — reconnecting...</span>
        )}
        <button
          type="button"
          onClick={handleDisconnect}
          className="text-[10px] text-[var(--text-light)] hover:text-[var(--text-muted)] underline"
        >
          Change connection
        </button>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex gap-5 px-6 pb-6 min-h-0">
        {/* Left: Agent list */}
        <div className="w-[280px] shrink-0 flex flex-col">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">All Agents</h2>
            <p className="text-xs text-[var(--text-muted)]">{summaryParts.join(", ") || "No agents"}</p>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {workersArray.map((w) => (
              <AgentCard
                key={w.id}
                worker={w}
                selected={selectedId === w.id}
                onClick={() => setSelectedId(selectedId === w.id ? null : w.id)}
              />
            ))}
          </div>
        </div>

        {/* Right: Agent Map */}
        <div className="flex-1 min-w-0">
          <AgentMap
            workers={workersArray}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(selectedId === id ? null : id)}
          />
        </div>
      </div>

      {/* Chat drawer */}
      {selectedWorker && (
        <ChatDrawer
          worker={selectedWorker}
          messages={chatMessages.get(selectedWorker.id) ?? []}
          onSend={(msg) => send({ type: "message", workerId: selectedWorker.id, content: msg })}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}
