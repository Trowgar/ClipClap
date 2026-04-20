"use client";

import { useRef, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface ClipPlayerProps {
  clipId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onDurationChange?: (duration: number) => void;
}

export function ClipPlayer({
  clipId,
  onTimeUpdate,
  onDurationChange,
}: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.clips
      .download(clipId)
      .then(({ url }) => setSrc(url))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [clipId]);

  if (loading) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
