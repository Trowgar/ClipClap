"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { VideoPreview } from "@/components/editor/video-preview";
import { SubtitleList } from "@/components/editor/subtitle-list";
import { TrimBar } from "@/components/editor/trim-bar";
import { api, type ClipData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ArrowLeft, CircleNotch, FloppyDisk } from "@phosphor-icons/react";
import type { SubtitleCue } from "@clipclap/shared";

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
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load clip + track + presigned video URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clipData = await api.clips.get(clipId);
        if (cancelled) return;
        setClip(clipData);
        // A swept clip has no object behind it - the editor cannot work on
        // it, so there is nothing left to fetch (no download, no subtitles).
        if (clipData.expired) return;

        const [track, download] = await Promise.all([
          api.clips.subtitles(clipId),
          api.clips.download(clipId),
        ]);
        if (cancelled) return;
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

  if (clip.expired) {
    // Editing an expired clip cannot work at all - there is no object left
    // to re-render from - so say that plainly instead of showing a preview,
    // trim bar, and subtitle list that can never save.
    return (
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <h1 className="truncate text-base font-semibold">{clip.title}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Storage period ended - this clip can no longer be edited.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-3rem)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <h1 className="truncate text-base font-semibold">{clip.title}</h1>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
            saving || !dirty
              ? "cursor-not-allowed bg-white/[0.06] text-neutral-500"
              : "bg-white text-black hover:bg-neutral-200 active:scale-[0.97]"
          )}
        >
          {saving ? (
            <>
              <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />
              Re-rendering…
            </>
          ) : (
            <>
              <FloppyDisk className="h-3.5 w-3.5" />
              Save and re-render
            </>
          )}
        </button>
      </div>

      {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="sticky top-0 z-20 flex flex-col gap-3 bg-background pb-1 lg:static lg:z-auto lg:min-h-0 lg:pb-0">
          <div className="h-[40dvh] lg:h-auto lg:min-h-0 lg:flex-1">
            <VideoPreview
              src={videoUrl}
              currentTime={currentTime}
              duration={duration}
              playing={playing}
              playbackRate={playbackRate}
              onTimeUpdate={setCurrentTime}
              onPlayingChange={setPlaying}
              onDuration={handleDuration}
              onPlaybackRateChange={setPlaybackRate}
            />
          </div>
          <div className="shrink-0">
            <TrimBar
              duration={duration}
              start={trim.start}
              end={trim.end}
              currentTime={currentTime}
              onChange={handleTrimChange}
              onSeek={seek}
            />
          </div>
        </div>

        <SubtitleList
          cues={cues}
          currentTime={currentTime}
          playing={playing}
          onChange={handleCuesChange}
          onSeek={seek}
        />
      </div>
    </div>
  );
}
