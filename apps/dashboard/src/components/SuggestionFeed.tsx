"use client";

import { idleSuggestions } from "./AgentCard";
import type { WorkerState } from "@/lib/types";

export function SuggestionFeed({
  worker,
  onApply,
  onSuggestionFeedback,
}: {
  worker: WorkerState;
  onApply: (message: string) => void;
  onSuggestionFeedback?: (appliedLabel: string, shownLabels: string[]) => void;
}) {
  const suggestions =
    worker.suggestions && worker.suggestions.length > 0
      ? worker.suggestions.map((s) => ({ label: s.label, message: s.message, reason: s.reason }))
      : worker.status === "idle"
        ? idleSuggestions(worker).map((s) => ({ ...s, reason: undefined as string | undefined }))
        : [];

  if (suggestions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-[var(--text-light)] text-xs text-center">
          {worker.status === "working"
            ? "Working... suggestions appear when idle"
            : worker.status === "stuck"
              ? "Waiting for input"
              : "No suggestions"}
        </p>
      </div>
    );
  }

  const allLabels = suggestions.map((s) => s.label);

  return (
    <div className="feed-scroll flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
      <p className="text-[10px] text-[var(--text-light)] uppercase tracking-wider font-semibold px-1 mb-1">
        Next steps
      </p>
      {suggestions.map((s) => (
        <div key={s.label} className="suggestion-card">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-[var(--text)] leading-tight">
              {s.label}
            </p>
            {s.reason && (
              <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-snug">
                {s.reason}
              </p>
            )}
            <p className="text-[10px] text-[var(--text-light)] mt-1 leading-snug line-clamp-2">
              {s.message}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onApply(s.message);
              if (onSuggestionFeedback) {
                onSuggestionFeedback(s.label, allLabels);
              }
            }}
            className="apply-btn shrink-0 self-center"
          >
            Apply
          </button>
        </div>
      ))}
    </div>
  );
}
