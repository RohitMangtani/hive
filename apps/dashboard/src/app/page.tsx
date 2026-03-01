"use client";

import { useCallback, useEffect, useState } from "react";
import { useHive } from "@/lib/ws";
import { WorkerCard } from "@/components/WorkerCard";
import { ChatPanel } from "@/components/ChatPanel";
import { OrchestratorBar } from "@/components/OrchestratorBar";
import { SpawnDialog } from "@/components/SpawnDialog";

const DEFAULT_URL = "ws://localhost:3002";

function SetupScreen({
  onConnect,
}: {
  onConnect: (url: string, token: string) => void;
}) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    onConnect(url.trim(), token.trim());
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6"
      >
        <h1 className="text-xl font-semibold text-center">Hive</h1>
        <p className="text-sm text-[var(--text-muted)] text-center">
          Connect to your daemon
        </p>

        <div>
          <label
            htmlFor="setup-url"
            className="block text-xs text-[var(--text-muted)] mb-1"
          >
            Daemon URL
          </label>
          <input
            id="setup-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://localhost:3002"
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text)] placeholder:text-zinc-600 outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        <div>
          <label
            htmlFor="setup-token"
            className="block text-xs text-[var(--text-muted)] mb-1"
          >
            Token
          </label>
          <input
            id="setup-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter daemon token"
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text)] placeholder:text-zinc-600 outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        <button
          type="submit"
          disabled={!token.trim()}
          className="w-full text-sm px-4 py-2 rounded bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [showSpawn, setShowSpawn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Read from localStorage on mount
  useEffect(() => {
    const storedUrl = localStorage.getItem("hive_daemon_url");
    const storedToken = localStorage.getItem("hive_token");
    if (storedUrl && storedToken) {
      setDaemonUrl(storedUrl);
      setToken(storedToken);
    }
    setLoaded(true);
  }, []);

  const { connected, workers, chatMessages, send } = useHive(
    daemonUrl ?? "",
    token ?? ""
  );

  const handleConnect = useCallback((url: string, t: string) => {
    localStorage.setItem("hive_daemon_url", url);
    localStorage.setItem("hive_token", t);
    setDaemonUrl(url);
    setToken(t);
  }, []);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem("hive_daemon_url");
    localStorage.removeItem("hive_token");
    setDaemonUrl(null);
    setToken(null);
    setShowSettings(false);
  }, []);

  const handleKill = useCallback(
    (workerId: string) => {
      send({ type: "kill", workerId });
    },
    [send]
  );

  const handleSpawn = useCallback(
    (project: string, task: string) => {
      send({ type: "spawn", project, task: task || undefined });
      setShowSpawn(false);
    },
    [send]
  );

  const handleChatSend = useCallback(
    (message: string) => {
      if (!selectedWorkerId) return;
      send({ type: "message", workerId: selectedWorkerId, content: message });
    },
    [send, selectedWorkerId]
  );

  const handleOrchestratorSend = useCallback(
    (message: string) => {
      send({ type: "orchestrator", content: message });
    },
    [send]
  );

  // Don't render until localStorage is read
  if (!loaded) {
    return (
      <main className="min-h-screen bg-[var(--bg)]" />
    );
  }

  // Show setup if no token
  if (!token) {
    return <SetupScreen onConnect={handleConnect} />;
  }

  const workersArray = Array.from(workers.values());
  const selectedWorker = selectedWorkerId
    ? workers.get(selectedWorkerId)
    : null;
  const selectedMessages = selectedWorkerId
    ? chatMessages.get(selectedWorkerId) ?? []
    : [];

  return (
    <main className="flex flex-col h-screen bg-[var(--bg)]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Hive</h1>
          <span className="text-sm text-[var(--text-muted)]">
            {workersArray.length} worker{workersArray.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSpawn(true)}
            className="text-sm px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            + New Worker
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="text-sm px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-zinc-600 transition-colors"
            title="Settings"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="8" cy="8" r="2.5" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
            </svg>
          </button>
        </div>
      </header>

      {/* Settings dropdown */}
      {showSettings && (
        <div className="absolute top-14 right-6 z-40 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 shadow-lg">
          <p className="text-xs text-[var(--text-muted)] mb-1">Connected to</p>
          <p className="text-sm mb-3 truncate max-w-xs">{daemonUrl}</p>
          <button
            type="button"
            onClick={handleDisconnect}
            className="text-sm px-3 py-1.5 rounded border border-[var(--error)] text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors w-full"
          >
            Disconnect
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 overflow-hidden pb-14">
        {/* Worker grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {workersArray.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <p className="text-[var(--text-muted)] mb-2">
                No workers running
              </p>
              <button
                type="button"
                onClick={() => setShowSpawn(true)}
                className="text-sm text-[var(--accent)] hover:underline"
              >
                Spawn a worker
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {workersArray.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  selected={selectedWorkerId === w.id}
                  onClick={() =>
                    setSelectedWorkerId(
                      selectedWorkerId === w.id ? null : w.id
                    )
                  }
                  onKill={() => handleKill(w.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Chat panel */}
        {selectedWorker && (
          <div className="w-[40%] min-w-[320px] max-w-[480px]">
            <ChatPanel
              workerId={selectedWorker.id}
              projectName={selectedWorker.projectName}
              messages={selectedMessages}
              onSend={handleChatSend}
              onClose={() => setSelectedWorkerId(null)}
            />
          </div>
        )}
      </div>

      {/* Orchestrator bar */}
      <OrchestratorBar onSend={handleOrchestratorSend} connected={connected} />

      {/* Spawn dialog */}
      {showSpawn && (
        <SpawnDialog
          onSpawn={handleSpawn}
          onClose={() => setShowSpawn(false)}
        />
      )}
    </main>
  );
}
