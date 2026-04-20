"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useClip } from "@/hooks/use-clips";
import { ClipPlayer } from "@/components/clip-player";
import { TrimEditor } from "@/components/trim-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { api } from "@/lib/api";

export default function ClipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { clip, loading } = useClip(id);
  const [downloading, setDownloading] = useState(false);

  if (loading) return null;
  if (!clip) {
    router.push("/dashboard");
    return null;
  }

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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.back()}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{clip.title}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {formatDuration(clip.duration)}
            </span>
            {clip.subtitles && clip.subtitlePreset && (
              <Badge variant="outline">{clip.subtitlePreset}</Badge>
            )}
          </div>
        </div>
        <Button onClick={handleDownload} disabled={downloading}>
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Video player */}
        <ClipPlayer clipId={clip.id} />

        {/* Trim editor */}
        <TrimEditor
          clipId={clip.id}
          originalStart={clip.startTime}
          originalEnd={clip.endTime}
          originalSubtitles={clip.subtitles}
          originalPreset={clip.subtitlePreset}
          onTrimmed={() => router.push(`/dashboard/jobs/${clip.jobId}`)}
        />
      </div>
    </div>
  );
}
