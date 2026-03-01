"use client";

import { useCallback, useEffect, useState } from "react";
import { useHive } from "@/lib/ws";
import type { WorkerState } from "@/lib/types";

const DEFAULT_URL = "wss://spring-apnic-promoted-equilibrium.trycloudflare.com";

// --- Helpers ---

function normalizeUrl(url: string): string {
  let u = url.trim();
  if (u.startsWith("https://")) u = "wss://" + u.slice(8);
  else if (u.startsWith("http://")) u = "ws://" + u.slice(7);
  else if (!u.startsWith("ws://") && !u.startsWith("wss://")) u = "wss://" + u;
  return u.replace(/\/+$/, "");
}

type DotColor = "green" | "yellow" | "red";

function dotColor(w: WorkerState): DotColor {
  if (w.status === "working") return "green";
  if (w.status === "stuck") return "yellow";
  return "red";
}

const DOT_CSS: Record<DotColor, string> = {
  green: "var(--dot-active)",
  yellow: "var(--dot-needs)",
  red: "var(--dot-offline)",
};

function statusLabel(w: WorkerState): string {
  if (w.status === "stuck") return w.currentAction || "Needs direction";
  if (w.status === "working") return w.currentAction || "Working...";
  if (w.status === "waiting") return w.lastAction || "Paused";
  return "Offline";
}

function statusWord(w: WorkerState): string {
  if (w.status === "working") return "Active";
  if (w.status === "stuck") return "Needs direction";
  if (w.status === "waiting") return "Paused";
  return "Offline";
}

function timeActive(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// --- Status Tile (the useful replacement for the map) ---

function StatusTile({ worker, selected, onClick }: { worker: WorkerState; selected: boolean; onClick: () => void }) {
  const color = dotColor(worker);
  const css = DOT_CSS[color];
  const stuck = color === "yellow";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`status-tile text-left ${stuck ? "needs-direction" : ""} ${selected ? "selected" : ""}`}
      style={{ borderLeftColor: css, borderLeftWidth: "4px" }}
    >
      {/* Top row: dot + project name + uptime */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-3 h-3 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`}
            style={{ background: css }}
          />
          <span className="font-semibold text-sm truncate">{worker.projectName}</span>
        </div>
        <span className="text-[11px] text-[var(--text-light)] shrink-0 tabular-nums">{timeActive(worker.startedAt)}</span>
      </div>

      {/* Meta row: TTY + PID + status word */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {worker.tty && (
          <span className="text-[10px] font-mono text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">{worker.tty}</span>
        )}
        <span className="text-[10px] text-[var(--text-light)]">PID {worker.pid}</span>
        <span
          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
          style={{
            background: color === "green" ? "#dcfce7" : color === "yellow" ? "#fefce8" : "#fef2f2",
            color: color === "green" ? "#166534" : color === "yellow" ? "#a16207" : "#991b1b",
          }}
        >
          {statusWord(worker)}
        </span>
      </div>

      {/* Action: what it's doing right now */}
      <p className={`text-xs truncate ${stuck ? "text-[var(--dot-needs)] font-medium" : "text-[var(--text-muted)]"}`}>
        {statusLabel(worker)}
      </p>

      {/* Last action (if different from current) */}
      {worker.lastAction && worker.lastAction !== worker.currentAction && (
        <p className="text-[10px] text-[var(--text-light)] truncate mt-1">
          Last: {worker.lastAction}
        </p>
      )}
    </button>
  );
}

// --- Compact Card (sidebar on desktop) ---

function AgentCard({ worker, selected, onClick }: { worker: WorkerState; selected: boolean; onClick: () => void }) {
  const color = dotColor(worker);
  const css = DOT_CSS[color];
  const stuck = color === "yellow";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`agent-card w-full text-left ${stuck ? "needs-direction" : ""} ${selected ? "selected" : ""}`}
      style={{ borderLeftColor: css, borderLeftWidth: "3px" }}
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`}
          style={{ background: css }}
        />
        <span className="font-semibold text-sm truncate flex-1">{worker.projectName}</span>
        {worker.tty && (
          <span className="text-[10px] font-mono text-[var(--text-light)]">{worker.tty}</span>
        )}
      </div>
    </button>
  );
}

// --- Chat Drawer (responsive) ---

function ChatDrawer({ worker, messages, onSend, onClose }: { worker: WorkerState; messages: string[]; onSend: (msg: string) => void; onClose: () => void }) {
  const [input, setInput] = useState("");
  const color = dotColor(worker);

  return (
    <div className="chat-drawer">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: DOT_CSS[color] }} />
            <span className="font-semibold text-sm truncate">{worker.projectName}</span>
            {worker.tty && <span className="text-[10px] font-mono text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">{worker.tty}</span>}
            {!worker.managed && <span className="text-[10px] text-[var(--text-light)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded">read-only</span>}
          </div>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">PID {worker.pid} · {timeActive(worker.startedAt)} active</p>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xl leading-none p-1">&times;</button>
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
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message this agent..." className="w-full bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-neutral-400" />
        </form>
      )}
    </div>
  );
}

// --- Main Page ---

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [urlInput, setUrlInput] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("hive_daemon_url");
    const url = stored || DEFAULT_URL;
    setDaemonUrl(url);
    setUrlInput(url);
  }, []);

  const { connected, workers, chatMessages, send } = useHive(daemonUrl);

  const updateUrl = useCallback((url: string) => {
    const normalized = normalizeUrl(url);
    localStorage.setItem("hive_daemon_url", normalized);
    setDaemonUrl(normalized);
    setUrlInput(normalized);
    setShowSettings(false);
  }, []);

  const workersArray = Array.from(workers.values());
  const activeCount = workersArray.filter((w) => w.status === "working").length;
  const needsCount = workersArray.filter((w) => w.status === "stuck").length;
  const offlineCount = workersArray.length - activeCount - needsCount;
  const selectedWorker = selectedId ? workers.get(selectedId) : null;

  const toggleSelect = (id: string) => setSelectedId(selectedId === id ? null : id);

  return (
    <main className="h-screen flex flex-col bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 pt-4 pb-2 sm:pt-5 sm:pb-3">
        <div />
        <div className="text-center">
          <h1 className="text-sm sm:text-base font-bold tracking-[0.2em] uppercase text-[var(--text)]">Find My Agents</h1>
          <div className="flex items-center justify-center gap-2 mt-1">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-[var(--dot-active)]" : "bg-[var(--dot-offline)]"}`} />
            <span className="text-[11px] text-[var(--text-muted)]">
              {connected ? "Connected" : "Reconnecting..."}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className="text-[var(--text-light)] hover:text-[var(--text-muted)] transition-colors"
          title="Connection settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Summary bar */}
      <div className="flex items-center justify-center gap-3 px-4 pb-2 sm:pb-3">
        <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)]">
          {workersArray.length === 0 ? (
            <span>No agents</span>
          ) : (
            <>
              {activeCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--dot-active)]" />
                  {activeCount} active
                </span>
              )}
              {needsCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--dot-needs)]" />
                  {needsCount} needs direction
                </span>
              )}
              {offlineCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--dot-offline)]" />
                  {offlineCount} offline
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Settings dropdown */}
      {showSettings && (
        <div className="mx-auto mb-2 w-full max-w-md px-4 sm:px-6">
          <form
            onSubmit={(e) => { e.preventDefault(); updateUrl(urlInput); }}
            className="flex gap-2 p-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-sm"
          >
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="wss://your-tunnel.trycloudflare.com"
              className="flex-1 bg-[var(--bg-panel)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-neutral-400 font-mono"
            />
            <button type="submit" className="text-xs px-3 py-1.5 rounded bg-neutral-900 text-white hover:bg-neutral-800 transition-colors">
              Save
            </button>
          </form>
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {/* Mobile: status tiles stacked full-width */}
        <div className="block md:hidden h-full overflow-y-auto px-4 pb-4 space-y-3">
          {workersArray.length === 0 && (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-[var(--text-muted)]">No agents detected</p>
            </div>
          )}
          {workersArray.map((w) => (
            <StatusTile
              key={w.id}
              worker={w}
              selected={selectedId === w.id}
              onClick={() => toggleSelect(w.id)}
            />
          ))}
        </div>

        {/* Desktop: sidebar + status grid */}
        <div className="hidden md:flex gap-5 px-6 pb-6 h-full">
          {/* Compact sidebar */}
          <div className="w-[200px] shrink-0 flex flex-col">
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Agents</h2>
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {workersArray.map((w) => (
                <AgentCard key={w.id} worker={w} selected={selectedId === w.id} onClick={() => toggleSelect(w.id)} />
              ))}
            </div>
          </div>

          {/* Status grid */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {workersArray.length === 0 ? (
              <div className="h-full flex items-center justify-center bg-[var(--bg-panel)] rounded-2xl border border-[var(--border)]">
                <p className="text-sm text-[var(--text-muted)]">No agents detected</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {workersArray.map((w) => (
                  <StatusTile
                    key={w.id}
                    worker={w}
                    selected={selectedId === w.id}
                    onClick={() => toggleSelect(w.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

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
