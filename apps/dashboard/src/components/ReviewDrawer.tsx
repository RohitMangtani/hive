"use client";

import { useEffect, useRef } from "react";
import type { ReviewItem } from "@/lib/types";

interface ReviewDrawerProps {
  open: boolean;
  reviews: ReviewItem[];
  onClose: () => void;
  onDismiss: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onMarkAllSeen: () => void;
}

function typeIcon(type: ReviewItem["type"]): string {
  switch (type) {
    case "deploy": return "\u2191"; // ↑
    case "push": return "\u2197";   // ↗
    case "commit": return "\u2713"; // ✓
    case "pr": return "\u2442";     // ⑂ (branch)
    case "review-needed": return "!";
    default: return "\u2022";       // •
  }
}

function typeLabel(type: ReviewItem["type"]): string {
  switch (type) {
    case "deploy": return "Deploy";
    case "push": return "Push";
    case "commit": return "Commit";
    case "pr": return "PR";
    case "review-needed": return "Review";
    default: return "Update";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ReviewDrawer({
  open,
  reviews,
  onClose,
  onDismiss,
  onMarkSeen,
  onMarkAllSeen,
}: ReviewDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  // Mark items as seen when drawer opens
  useEffect(() => {
    if (open) {
      const unseen = reviews.filter(r => !r.seen);
      for (const r of unseen) {
        onMarkSeen(r.id);
      }
    }
  }, [open, reviews, onMarkSeen]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const unseenCount = reviews.filter(r => !r.seen).length;

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        className="fixed top-0 right-0 h-full z-50 flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]"
        style={{
          width: "min(360px, 85vw)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          background: "var(--bg-card)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text)]">Recent Changes</span>
            {unseenCount > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--accent)] text-white">
                {unseenCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {reviews.length > 0 && (
              <button
                type="button"
                onClick={onMarkAllSeen}
                className="text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors cursor-pointer"
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-lg text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-1 cursor-pointer"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: "touch" }}>
          {reviews.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[var(--text-light)] text-xs">
              No recent changes
            </div>
          ) : (
            <div className="py-2">
              {reviews.map((review) => (
                <div
                  key={review.id}
                  className="group px-4 py-3 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
                  style={{
                    opacity: review.seen ? 0.6 : 1,
                    borderLeft: review.seen ? "2px solid transparent" : "2px solid var(--accent)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    {/* Type badge */}
                    <div
                      className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold mt-0.5"
                      style={{
                        background: review.type === "review-needed"
                          ? "rgba(234, 179, 8, 0.12)"
                          : "rgba(59, 130, 246, 0.1)",
                        color: review.type === "review-needed"
                          ? "var(--dot-needs)"
                          : "var(--accent)",
                      }}
                    >
                      {typeIcon(review.type)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-semibold text-[var(--text-light)] uppercase tracking-wider">
                          {review.quadrant ? `Q${review.quadrant}` : review.projectName}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {typeLabel(review.type)}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] ml-auto shrink-0">
                          {formatTime(review.createdAt)}
                        </span>
                      </div>

                      <p className="text-xs text-[var(--text)] leading-relaxed">
                        {review.summary}
                      </p>

                      {/* Action row */}
                      <div className="flex items-center gap-2 mt-1.5">
                        {review.url && (
                          <a
                            href={review.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-[var(--accent)] hover:underline"
                          >
                            View &rarr;
                          </a>
                        )}
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {timeAgo(review.createdAt)}
                        </span>
                        <button
                          type="button"
                          onClick={() => onDismiss(review.id)}
                          className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--dot-offline)] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
