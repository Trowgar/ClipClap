"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { VideoPreview } from "@/components/editor/video-preview";
import { SubtitleList } from "@/components/editor/subtitle-list";
import { TrimBar } from "@/components/editor/trim-bar";
import { api, type ClipData } from "@/lib/api";
import { ArrowLeft, CircleNotch, FloppyDisk } from "@phosphor-icons/react";
import type { SubtitleCue } from "@clipfast/shared";

interface ClipEditorProps {
  clipId: string;
}

const POLL_MS = 2000;
const POLL_MAX = 150; // ~5 min

export function ClipEditor({ clipId }: ClipEditorProps) {
  const router = useRouter();
  const [clip, setClip] = useState<ClipData | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [duration, setDuration] = useState(0);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load clip + track + presigned video URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [clipData, track, download] = await Promise.all([
          api.clips.get(clipId),
          api.clips.subtitles(clipId),
          api.clips.download(clipId),
        ]);
        if (cancelled) return;
        setClip(clipData);
        setCues(track.cues ?? []);
        setVideoUrl(download.url);
        setDuration(clipData.duration);
        setTrim({ start: 0, end: clipData.duration });
        setDirty(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load clip");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [clipId]);

  const handleDuration = useCallback((d: number) => {
    setDuration(d);
    setTrim((t) => ({ start: t.start, end: Math.min(t.end, d) || d }));
  }, []);

  const handleCuesChange = useCallback((next: SubtitleCue[]) => {
    setCues(next);
    setDirty(true);
  }, []);

  const handleTrimChange = useCallback((start: number, end: number) => {
    setTrim({ start, end });
    setDirty(true);
  }, []);

  const seek = useCallback((seconds: number) => {
    setCurrentTime(seconds);
  }, []);

  const handleSave = async () => {
    if (!clip || saving) return;
    setSaving(true);
    setError(null);
    setPlaying(false);
    try {
      // PUT expects source-absolute trim times (same timeline as Clip.startTime)
      const newClip = await api.clips.edit(clip.id, {
        trim: {
          start: clip.startTime + trim.start,
          end: clip.startTime + trim.end,
        },
        subtitles: true,
        subtitleTrack: { cues },
      });

      // Poll the placeholder clip until the worker uploads the re-render
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const fresh = await api.clips.get(newClip.id);
          if (fresh.storageKey) {
            if (pollRef.current) clearInterval(pollRef.current);
            router.push(`/dashboard/editor?clip=${fresh.id}`);
            setSaving(false);
          } else if (attempts >= POLL_MAX) {
            if (pollRef.current) clearInterval(pollRef.current);
            setSaving(false);
            setError("Re-render is taking longer than expected. Check the project page.");
          }
        } catch {
          // transient poll error - keep trying until the cap
        }
      }, POLL_MS);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  if (error && !clip) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!clip) return null;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <h1 className="truncate text-base font-semibold">{clip.title}</h1>
        </div>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? (
            <>
              <CircleNotch weight="bold" className="mr-2 h-4 w-4 animate-spin" />
              Re-rendering…
            </>
          ) : (
            <>
              <FloppyDisk className="mr-2 h-4 w-4" />
              Save and re-render
            </>
          )}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-3">
          <VideoPreview
            src={videoUrl}
            cues={cues}
            currentTime={currentTime}
            playing={playing}
            onTimeUpdate={setCurrentTime}
            onPlayingChange={setPlaying}
            onDuration={handleDuration}
          />
          <TrimBar
            duration={duration}
            start={trim.start}
            end={trim.end}
            currentTime={currentTime}
            onChange={handleTrimChange}
            onSeek={seek}
          />
        </div>

        <SubtitleList
          cues={cues}
          currentTime={currentTime}
          onChange={handleCuesChange}
          onSeek={seek}
        />
      </div>
    </div>
  );
}
