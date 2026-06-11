"use client";

import { useEffect, useRef } from "react";
import { Play, Pause } from "@phosphor-icons/react";
import type { SubtitleCue } from "@clipfast/shared";

interface VideoPreviewProps {
  src: string | null;
  cues: SubtitleCue[];
  currentTime: number; // seconds, clip-relative
  playing: boolean;
  onTimeUpdate: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onDuration: (seconds: number) => void;
}

export function VideoPreview({
  src,
  cues,
  currentTime,
  playing,
  onTimeUpdate,
  onPlayingChange,
  onDuration,
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

  const activeCue = cues.find(
    (c) => currentTime >= c.start && currentTime < c.end
  );

  return (
    <div
      className="group relative mx-auto aspect-[9/16] max-h-[70vh] cursor-pointer overflow-hidden rounded-xl border border-white/[0.08] bg-black"
      onClick={() => onPlayingChange(!playing)}
    >
      {src ? (
        <video
          ref={videoRef}
          src={src}
          className="h-full w-full object-contain"
          playsInline
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
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-black shadow-xl">
            <Play size={28} weight="fill" className="ml-1" />
          </div>
        </div>
      )}
      {playing && (
        <div className="absolute right-3 top-3 z-10 opacity-0 transition-opacity group-hover:opacity-100">
          <Pause size={20} weight="fill" className="text-white/80" />
        </div>
      )}

      {/* Subtitle overlay - browser preview of the burn (final look comes from the server re-render) */}
      {activeCue && (
        <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center px-4">
          <span className="inline-block max-w-[90%] rounded-lg bg-black/75 px-4 py-2 text-center text-base font-bold leading-normal text-white shadow-lg">
            {activeCue.words && activeCue.words.length > 0
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
  );
}
