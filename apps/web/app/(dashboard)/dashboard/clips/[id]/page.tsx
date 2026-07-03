"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useClip } from "@/hooks/use-clips";
import { ClipPlayer } from "@/components/clip-player";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  DownloadSimple,
  CircleNotch,
  PencilSimple,
} from "@phosphor-icons/react";
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

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{clip.title}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {formatDuration(clip.duration)}
            </span>
            {clip.subtitles && <Badge variant="outline">subtitles</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={`/dashboard/editor?clip=${clip.id}`}>
              <PencilSimple className="mr-2 h-4 w-4" />
              Edit
            </Link>
          </Button>
          <Button onClick={handleDownload} disabled={downloading}>
            {downloading ? (
              <CircleNotch weight="bold" className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <DownloadSimple className="mr-2 h-4 w-4" />
            )}
            Download
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-md">
        <ClipPlayer clipId={clip.id} />
      </div>
    </div>
  );
}
