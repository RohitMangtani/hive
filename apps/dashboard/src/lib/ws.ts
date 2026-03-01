"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonMessage, DaemonResponse, WorkerState } from "@/lib/types";

const MAX_CHAT_MESSAGES = 500;

export function useHive(daemonUrl: string) {
  const [connected, setConnected] = useState(false);
  const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
  const [chatMessages, setChatMessages] = useState<Map<string, string[]>>(
    new Map()
  );

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(
    (msg: DaemonMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
    []
  );

  useEffect(() => {
    if (!daemonUrl) return;

    function connect() {
      const ws = new WebSocket(daemonUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        let data: DaemonResponse;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (data.type) {
          case "workers": {
            const next = new Map<string, WorkerState>();
            if (data.workers) {
              for (const w of data.workers) {
                next.set(w.id, w);
              }
            }
            setWorkers(next);
            break;
          }

          case "worker_update": {
            if (data.worker) {
              const w = data.worker;
              setWorkers((prev) => {
                const next = new Map(prev);
                next.set(w.id, w);
                return next;
              });
            }
            break;
          }

          case "chat": {
            if (data.workerId && data.content) {
              const wid = data.workerId;
              const content = data.content;
              setChatMessages((prev) => {
                const next = new Map(prev);
                const existing = next.get(wid) ?? [];
                const updated = [...existing, content];
                if (updated.length > MAX_CHAT_MESSAGES) {
                  updated.splice(0, updated.length - MAX_CHAT_MESSAGES);
                }
                next.set(wid, updated);
                return next;
              });
            }
            break;
          }

          case "orchestrator":
          case "error":
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [daemonUrl]);

  return { connected, workers, chatMessages, send };
}
