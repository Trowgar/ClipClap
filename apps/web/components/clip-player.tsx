"use client";

import { useRef, useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { api } from "@/lib/api";

interface ClipPlayerProps {
  clipId: string;
  expired?: boolean;
  onTimeUpdate?: (currentTime: number) => void;
  onDurationChange?: (duration: number) => void;
}

export function ClipPlayer({
  clipId,
  expired,
  onTimeUpdate,
  onDurationChange,
}: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(!expired);

  useEffect(() => {
    // A swept clip has no object behind it - never spend the presign round
    // trip on it.
    if (expired) {
      setSrc(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    api.clips
      .download(clipId)
      .then(({ url }) => {
        if (active) setSrc(url);
      })
      .catch(console.error)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clipId, expired]);

  if (expired) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <p className="text-sm text-muted-foreground">Storage period ended</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <CircleNotch weight="bold" className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <p className="text-sm text-muted-foreground">Failed to load video</p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      className="aspect-[9/16] max-h-[500px] w-full rounded-lg bg-black"
      onTimeUpdate={() => {
        if (videoRef.current) onTimeUpdate?.(videoRef.current.currentTime);
      }}
      onLoadedMetadata={() => {
        if (videoRef.current) onDurationChange?.(videoRef.current.duration);
      }}
    />
  );
}
