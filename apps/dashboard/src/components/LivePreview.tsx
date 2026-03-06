"use client";

import { useCallback, useRef, useState } from "react";

export interface Pin {
  id: number;
  x: number; // 0-100 percentage from left
  y: number; // 0-100 percentage from top
}

export function LivePreview({
  url,
  onUrlChange,
  pins,
  onAddPin,
  onRemovePin,
  onClearPins,
  fullHeight,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  pins: Pin[];
  onAddPin: (x: number, y: number) => void;
  onRemovePin: (id: number) => void;
  onClearPins: () => void;
  fullHeight?: boolean;
}) {
  const [pinMode, setPinMode] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!pinMode) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      onAddPin(x, y);
    },
    [pinMode, onAddPin]
  );

  if (!url) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2.5 ${fullHeight ? "flex-1 justify-center" : "border-b border-[var(--border)]"}`}>
        <input
          type="text"
          placeholder="http://localhost:3000"
          className="preview-url-input flex-1 max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const val = (e.target as HTMLInputElement).value.trim();
              if (val) onUrlChange(val);
            }
          }}
        />
        <span className="text-[9px] text-[var(--text-light)] shrink-0">Enter to connect</span>
      </div>
    );
  }

  return (
    <div className={fullHeight ? "flex-1 flex flex-col min-h-0" : "border-b border-[var(--border)]"}>
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-[var(--border)] bg-[var(--bg-card)] shrink-0">
        <span className="text-[9px] text-[var(--text-light)] truncate flex-1 font-mono">{url}</span>
        <button
          type="button"
          onClick={() => setPinMode(!pinMode)}
          className={`suggestion-btn !text-[9px] !py-0 !px-1.5 ${pinMode ? "preview-pin-active" : ""}`}
        >
          {pinMode ? "Done" : "Pin"}
        </button>
        {pins.length > 0 && (
          <button
            type="button"
            onClick={onClearPins}
            className="suggestion-btn !text-[9px] !py-0 !px-1.5"
          >
            Clear {pins.length}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = url;
          }}
          className="text-[11px] text-[var(--text-light)] hover:text-[var(--text)] cursor-pointer leading-none"
          title="Reload"
        >
          &#8635;
        </button>
        <button
          type="button"
          onClick={() => onUrlChange("")}
          className="text-[11px] text-[var(--text-light)] hover:text-[var(--text)] cursor-pointer leading-none"
          title="Disconnect"
        >
          &times;
        </button>
      </div>

      <div className={`${fullHeight ? "flex-1 min-h-0" : "preview-frame"} relative`}>
        <iframe
          ref={iframeRef}
          src={url}
          className="w-full h-full border-0 bg-white rounded-b-sm"
          title="Live preview"
        />
        <div
          className={`absolute inset-0 ${pinMode ? "cursor-crosshair" : "pointer-events-none"}`}
          onClick={handleOverlayClick}
        >
          {pins.map((pin) => (
            <button
              key={pin.id}
              type="button"
              className="preview-pin"
              style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
              onClick={(e) => {
                e.stopPropagation();
                if (pinMode) onRemovePin(pin.id);
              }}
              title={pinMode ? `Remove #${pin.id}` : `#${pin.id}`}
            >
              {pin.id}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Format pin positions into a context block for the agent */
export function describePins(pins: Pin[]): string {
  if (pins.length === 0) return "";
  const lines = pins.map(
    (p) =>
      `#${p.id}: ~${Math.round(p.x)}% from left, ~${Math.round(p.y)}% from top of the live preview`
  );
  return `\n\n[Reference Points]\n${lines.join("\n")}`;
}
