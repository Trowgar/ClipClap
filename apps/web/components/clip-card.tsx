"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Scissors, Trash2, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ClipData } from "@/lib/api";
import Link from "next/link";

interface ClipCardProps {
  clip: ClipData;
  onDelete?: () => void;
}

export function ClipCard({ clip, onDelete }: ClipCardProps) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { url } = await api.clips.download(clip.id);
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
    <Card className="overflow-hidden border-border">
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{clip.title}</p>
            <p className="text-xs text-muted-foreground">
              {formatDuration(clip.duration)}
            </p>
          </div>
          {clip.subtitles && clip.subtitlePreset && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {clip.subtitlePreset}
            </Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Download</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/dashboard/clips/${clip.id}`}>
              <Scissors className="h-3.5 w-3.5" />
              <span className="ml-1.5">Trim</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
