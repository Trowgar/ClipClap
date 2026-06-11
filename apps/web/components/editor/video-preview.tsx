"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  ClosedCaptioning,
  HighlighterCircle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/components/editor/time";
import type { SubtitleCue } from "@clipfast/shared";

const RATE_PRESETS = [0.6, 1.0, 1.4, 2.0];

// Click-and-drag scrubber with hover timecode, between the video area and the
// controls bar (adapted from ClipSubs VideoPlayer). Hover state stays local so
// the parent only re-renders on actual seeks.
function Scrubber({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState(0);

  const pct =
    duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (duration <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    seekFromClientX(e.clientX);
    const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={barRef}
      onPointerDown={handlePointerDown}
      onPointerMove={(e) => {
        const bar = barRef.current;
        if (!bar || duration <= 0) return;
        const rect = bar.getBoundingClientRect();
        const px = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
        setHoverPx(px);
        setHoverTime((px / rect.width) * duration);
      }}
      onPointerLeave={() => setHoverPx(null)}
      className={cn(
        "group relative h-2.5 shrink-0 border-y border-white/[0.08] bg-white/[0.06] transition-[height] duration-150 hover:h-3.5",
        duration > 0 ? "cursor-pointer" : "cursor-default"
      )}
      title="Seek"
    >
      <div
        className="pointer-events-none h-full bg-white/40"
        style={{ width: `${pct}%` }}
      />
      {duration > 0 && (
        <div
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 rounded-full bg-white shadow ring-2 ring-black/60 transition-all group-hover:h-4 group-hover:w-4"
          style={{ left: `calc(${pct}% - 7px)`, transform: "translateY(-50%)" }}
        />
      )}
      {hoverPx !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-black shadow"
          style={{ left: hoverPx, transform: "translateX(-50%)" }}
        >
          {formatTimecode(hoverTime, false)}
        </div>
      )}
    </div>
  );
}

interface VideoPreviewProps {
  src: string | null;
  cues: SubtitleCue[];
  currentTime: number;
  duration: number;
  playing: boolean;
  playbackRate: number;
  showOverlay: boolean;
  showWordHighlight: boolean;
  onTimeUpdate: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onDuration: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onToggleOverlay: () => void;
  onToggleWordHighlight: () => void;
}

export function VideoPreview({
  src,
  cues,
  currentTime,
  duration,
  playing,
  playbackRate,
  showOverlay,
  showWordHighlight,
  onTimeUpdate,
  onPlayingChange,
  onDuration,
  onPlaybackRateChange,
  onToggleOverlay,
  onToggleWordHighlight,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastEmitRef = useRef(0);
  const lastTimeRef = useRef(0);

  // Sync play/pause state to the element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && video.paused) {
      video.play().catch(() => onPlayingChange(false));
    } else if (!playing && !video.paused) {
      video.pause();
    }
  }, [playing, onPlayingChange]);

  // High-frequency time loop while playing, throttled to limit re-renders
  useEffect(() => {
    const update = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const now = performance.now();
        const nextTime = video.currentTime;
        if (
          now - lastEmitRef.current > 50 ||
          Math.abs(nextTime - lastTimeRef.current) > 0.12
        ) {
          lastEmitRef.current = now;
          lastTimeRef.current = nextTime;
          onTimeUpdate(nextTime);
        }
        rafRef.current = requestAnimationFrame(update);
      }
    };

    if (playing) {
      lastEmitRef.current = performance.now();
      rafRef.current = requestAnimationFrame(update);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, onTimeUpdate]);

  // Seek only on significant drift to avoid jitter from our own ticks
  useEffect(() => {
    const video = videoRef.current;
    if (video && Math.abs(video.currentTime - currentTime) > 0.3) {
      video.currentTime = currentTime;
    }
  }, [currentTime]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const activeCue = cues.find(
    (c) => currentTime >= c.start && currentTime < c.end
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      {/* Video area */}
      <div
        className="group relative min-h-0 flex-1 cursor-pointer bg-black"
        onClick={() => src && onPlayingChange(!playing)}
      >
        {src ? (
          <video
            ref={videoRef}
            src={src}
            className="h-full w-full object-contain"
            playsInline
            onTimeUpdate={(e) => {
              // Keeps the playhead honest while paused (native seeks, ended)
              if (!playing) onTimeUpdate(e.currentTarget.currentTime);
            }}
            onEnded={() => onPlayingChange(false)}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (isFinite(d) && d > 0) onDuration(d);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading video…
          </div>
        )}

        {!playing && src && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30">
            <div className="flex h-16 w-16 transform items-center justify-center rounded-full bg-white/90 text-black shadow-xl transition-transform group-hover:scale-110">
              <Play size={28} weight="fill" className="ml-1" />
            </div>
          </div>
        )}

        {/* Subtitle overlay - browser preview of the burn (the final look comes from the server re-render) */}
        {showOverlay && activeCue && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center px-4">
            <span className="inline-block max-w-[90%] rounded-lg bg-black/75 px-4 py-2 text-center text-base font-bold leading-normal text-white shadow-lg backdrop-blur-sm">
              {showWordHighlight &&
              activeCue.words &&
              activeCue.words.length > 0
                ? activeCue.words.map((word, i) => (
                    <span
                      key={i}
                      className={
                        currentTime >= word.start && currentTime <= word.end
                          ? "text-yellow-300"
                          : ""
                      }
                    >
                      {word.text}
                      {i < activeCue.words!.length - 1 ? " " : ""}
                    </span>
                  ))
                : activeCue.text}
            </span>
          </div>
        )}
      </div>

      <Scrubber currentTime={currentTime} duration={duration} onSeek={onTimeUpdate} />

      {/* Controls bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-t border-white/[0.08] px-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onPlayingChange(!playing)}
            disabled={!src}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause size={18} weight="fill" />
            ) : (
              <Play size={18} weight="fill" />
            )}
          </button>
          <span className="font-mono text-xs tabular-nums text-neutral-400">
            {formatTimecode(currentTime, false)}
            <span className="text-neutral-600"> / </span>
            {formatTimecode(duration, false)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleOverlay}
            className={cn(
              "rounded-md p-1.5 transition-colors",
              showOverlay
                ? "bg-white/[0.12] text-white"
                : "text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-300"
            )}
            title="Toggle captions preview"
          >
            <ClosedCaptioning size={17} />
          </button>
          <button
            type="button"
            onClick={onToggleWordHighlight}
            className={cn(
              "rounded-md p-1.5 transition-colors",
              showWordHighlight
                ? "bg-white/[0.12] text-white"
                : "text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-300"
            )}
            title="Toggle word highlighting"
          >
            <HighlighterCircle size={17} />
          </button>

          <div className="mx-1.5 h-5 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-0.5 rounded-md bg-white/[0.04] p-0.5 text-[11px] font-medium">
            {RATE_PRESETS.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => onPlaybackRateChange(rate)}
                disabled={!src}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-colors",
                  playbackRate === rate
                    ? "bg-white/[0.14] text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                )}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
