"use client";

import { useCallback, useRef } from "react";
import { formatDuration } from "@/lib/utils";

interface TrimBarProps {
  duration: number; // seconds
  start: number;
  end: number;
  currentTime: number;
  onChange: (start: number, end: number) => void;
  onSeek: (seconds: number) => void;
}

const MIN_RANGE = 1; // seconds

export function TrimBar({
  duration,
  start,
  end,
  currentTime,
  onChange,
  onSeek,
}: TrimBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const toSeconds = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration]
  );

  const dragHandle = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const t = toSeconds(ev.clientX);
      if (which === "start") {
        onChange(Math.min(t, end - MIN_RANGE), end);
      } else {
        onChange(start, Math.max(t, start + MIN_RANGE));
      }
    };
    const onUp = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const pct = (s: number) => (duration > 0 ? (s / duration) * 100 : 0);

  return (
    <div className="space-y-1.5">
      <div
        ref={trackRef}
        className="relative h-8 cursor-pointer rounded-md bg-white/[0.04]"
        onPointerDown={(e) => onSeek(toSeconds(e.clientX))}
      >
        {/* kept range */}
        <div
          className="absolute inset-y-0 rounded-md border border-white/25 bg-white/[0.10]"
          style={{ left: `${pct(start)}%`, width: `${pct(end - start)}%` }}
        />
        {/* playhead */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-yellow-300"
          style={{ left: `${pct(Math.min(currentTime, duration))}%` }}
        />
        {/* handles */}
        <div
          role="slider"
          aria-label="Trim start"
          aria-valuenow={start}
          className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-sm bg-white"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={dragHandle("start")}
        />
        <div
          role="slider"
          aria-label="Trim end"
          aria-valuenow={end}
          className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-sm bg-white"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={dragHandle("end")}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] tabular-nums text-neutral-500">
        <span>
          {start.toFixed(1)}s - {end.toFixed(1)}s
          <span className="text-neutral-300"> · {formatDuration(Math.round(end - start))} kept</span>
        </span>
        <span>{formatDuration(Math.round(duration))} total</span>
      </div>
    </div>
  );
}
