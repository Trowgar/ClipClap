"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Film, Loader2, Scissors, Trash2 } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { api } from "@/lib/api";
import Link from "next/link";

const CLIP_URL_TTL_MS = 50 * 60 * 1000;
const clipUrlCache = new Map<string, { url: string; expiresAt: number }>();

export interface ClipCardClip {
  id: string;
  title: string;
  duration: number;
  subtitles?: boolean;
  subtitlePreset?: string | null;
  previewUrl?: string | null;
}

interface ClipCardProps {
  clip: ClipCardClip;
  previewUrl?: string | null;
  onDelete?: () => void;
}

export function ClipCard({
  clip,
  previewUrl: previewUrlProp,
  onDelete,
}: ClipCardProps) {
  const initialPreviewUrl = previewUrlProp ?? clip.previewUrl ?? null;
  const [previewUrl, setPreviewUrl] = useState<string | null>(() =>
    initialPreviewUrl ?? getCachedClipUrl(clip.id)
  );
  const [previewLoading, setPreviewLoading] = useState(
    () => !initialPreviewUrl && !getCachedClipUrl(clip.id)
  );
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const readyUrl = initialPreviewUrl ?? getCachedClipUrl(clip.id);
    if (readyUrl) {
      rememberClipUrl(clip.id, readyUrl);
      setPreviewUrl(readyUrl);
      setPreviewLoading(false);
      return;
    }

    let active = true;
    setPreviewLoading(true);
    api.clips
      .download(clip.id)
      .then(({ url }) => {
        rememberClipUrl(clip.id, url);
        if (active) setPreviewUrl(url);
      })
      .catch((err) => {
        console.error("Preview failed:", err);
        if (active) setPreviewUrl(null);
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clip.id, initialPreviewUrl]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const url = await getClipUrl(clip.id);
      window.open(url, "_blank");
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this clip?")) return;
    setDeleting(true);
    try {
      await api.clips.delete(clip.id);
      onDelete?.();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article className="group overflow-hidden rounded-lg border border-border bg-card/70 transition-colors hover:border-white/20">
      <div className="relative aspect-[9/16] overflow-hidden bg-black">
        {previewLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : previewUrl ? (
          <video
            src={previewUrl}
            controls
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Film className="h-6 w-6" />
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 via-black/35 to-transparent" />
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2">
          <span className="rounded bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {formatDuration(clip.duration)}
          </span>
          {clip.subtitles && clip.subtitlePreset && (
            <Badge
              variant="outline"
              className="border-white/25 bg-black/50 px-1.5 py-0 text-[10px] text-white"
            >
              {clip.subtitlePreset}
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-5">
            {clip.title}
          </p>
        </div>

        <div className="grid grid-cols-[1fr_1fr_36px] gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={handleDownload}
            disabled={downloading}
            title="Download"
            aria-label={`Download ${clip.title}`}
          >
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span className="text-xs">Download</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-8 px-2"
            title="Trim"
          >
            <Link href={`/dashboard/clips/${clip.id}`} aria-label={`Trim ${clip.title}`}>
              <Scissors className="h-3.5 w-3.5" />
              <span className="text-xs">Trim</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={handleDelete}
            disabled={deleting}
            className="h-8 w-9 text-destructive hover:text-destructive"
            title="Delete"
            aria-label={`Delete ${clip.title}`}
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </article>
  );
}

function getCachedClipUrl(clipId: string) {
  const cached = clipUrlCache.get(clipId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    clipUrlCache.delete(clipId);
    return null;
  }
  return cached.url;
}

function rememberClipUrl(clipId: string, url: string) {
  clipUrlCache.set(clipId, {
    url,
    expiresAt: Date.now() + CLIP_URL_TTL_MS,
  });
}

async function getClipUrl(clipId: string) {
  const cachedUrl = getCachedClipUrl(clipId);
  if (cachedUrl) {
    return cachedUrl;
  }

  const { url } = await api.clips.download(clipId);
  rememberClipUrl(clipId, url);
  return url;
}
