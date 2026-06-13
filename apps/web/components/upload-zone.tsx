"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowRight, CircleNotch, Paperclip, X, LinkSimple } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Plan } from "@prisma/client";

interface UploadZoneProps {
  plan: Plan;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  maxSourceDurationMinutes: number;
  maxFileSizeBytes: number;
}

// Best-effort client-side duration probe. The browser only decodes codecs it
// supports (H.264, WebM); HEVC/AV1/MKV may resolve null and bypass the
// submit-time max-source-duration check. Server-side enforcement requires
// ffprobe in the worker post-DOWNLOAD step (TODO in apps/worker, Plan 3 scope).
async function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      const seconds = isFinite(video.duration) ? video.duration : null;
      resolve(seconds);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function UploadZone({
  plan,
  minutesUsed,
  minutesLimit,
  topUpMinutesRemaining,
  maxSourceDurationMinutes,
  maxFileSizeBytes,
}: UploadZoneProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sourceDurationSec, setSourceDurationSec] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const minutesAvailable = Math.max(
    0,
    minutesLimit + topUpMinutesRemaining - minutesUsed
  );
  const durationMinutes = sourceDurationSec
    ? Math.ceil(sourceDurationSec / 60)
    : 0;

  // Submission gates
  const planRequired = plan === "NONE";
  const overDurationCap =
    sourceDurationSec !== null && durationMinutes > maxSourceDurationMinutes;
  const overFileSize = file !== null && file.size > maxFileSizeBytes;
  const overQuota = durationMinutes > 0 && durationMinutes > minutesAvailable;
  const hasInput = file !== null || url.trim().length > 0;

  const canSubmit =
    !loading &&
    !planRequired &&
    !overDurationCap &&
    !overFileSize &&
    !overQuota &&
    hasInput;

  let blockedReason: string | null = null;
  if (planRequired) {
    blockedReason = "Subscribe to a plan to start clipping.";
  } else if (overDurationCap) {
    blockedReason = `Source exceeds ${maxSourceDurationMinutes} min upload cap. Trim before uploading.`;
  } else if (overFileSize) {
    const maxGb = (maxFileSizeBytes / 1024 ** 3).toFixed(1);
    blockedReason = `File is ${formatBytes(file!.size)} - max ${maxGb} GB.`;
  } else if (overQuota) {
    blockedReason = `Job needs ${durationMinutes} min, only ${minutesAvailable} available. Upgrade or top up.`;
  }

  const setFileAndProbe = useCallback(async (next: File | null) => {
    setFile(next);
    setSourceDurationSec(null);
    setError(null);
    if (next && next.type.startsWith("video/")) {
      const duration = await probeVideoDuration(next);
      setSourceDurationSec(duration ?? null);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped?.type.startsWith("video/")) {
        setFileAndProbe(dropped);
        setUrl("");
      }
    },
    [setFileAndProbe]
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setUploadProgress(null);

    try {
      let sourceKey: string | undefined;
      let originalFilename: string | undefined;

      if (file) {
        setUploadProgress("Uploading…");
        const { uploadUrl, key } = await api.uploads.getPresignedUrl(
          file.name,
          file.type || "video/mp4",
          file.size
        );
        sourceKey = key;
        originalFilename = file.name;

        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "video/mp4" },
        });
        if (!uploadRes.ok) throw new Error("Upload failed");
      }

      setUploadProgress("Creating job…");
      const job = await api.jobs.create({
        url: url.trim() || undefined,
        sourceKey,
        originalFilename,
        subtitles,
        sourceDurationSec: sourceDurationSec ?? undefined,
      });

      router.push(`/dashboard/projects/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div
      className="space-y-3"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Input row */}
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-xl border bg-white/[0.02] px-2 py-1.5 transition-colors",
          dragActive
            ? "border-white/40 bg-white/[0.04]"
            : "border-white/[0.08] hover:border-white/[0.16] focus-within:border-white/[0.16]"
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-md p-2 text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          aria-label="Choose video file"
        >
          <Paperclip className="h-4 w-4" />
        </button>

        {file ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm text-white">{file.name}</span>
            <span className="font-mono text-xs tabular-nums text-neutral-500">
              {sourceDurationSec
                ? formatDuration(sourceDurationSec)
                : "probing…"}
              {" · "}
              {formatBytes(file.size)}
            </span>
            <button
              type="button"
              onClick={() => setFileAndProbe(null)}
              disabled={loading}
              className="ml-auto rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
              aria-label="Remove file"
            >
              <X weight="bold" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <LinkSimple className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading || planRequired}
              placeholder={
                dragActive
                  ? "Drop your video to upload…"
                  : "Paste a YouTube / Twitch / TikTok URL - or attach a file"
              }
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const sel = e.target.files?.[0];
            if (sel) {
              setFileAndProbe(sel);
              setUrl("");
            }
            e.target.value = "";
          }}
        />

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
            canSubmit
              ? "bg-white text-black hover:bg-neutral-200 active:scale-[0.97]"
              : "cursor-not-allowed bg-white/[0.06] text-neutral-500"
          )}
        >
          {loading ? (
            <>
              <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />
              {uploadProgress === "Uploading…" ? "Uploading…" : "Creating…"}
            </>
          ) : (
            <>
              Cut
              <ArrowRight className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </div>

      {/* Subtitle chips + meta */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-neutral-500">Subtitles</span>
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              onClick={() => setSubtitles(on)}
              disabled={loading}
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] transition-colors",
                subtitles === on
                  ? "bg-white/[0.12] text-white"
                  : "border border-white/[0.08] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-200"
              )}
            >
              {on ? "On" : "Off"}
            </button>
          ))}
        </div>

        <div className="font-mono text-[11px] tabular-nums text-neutral-500">
          {loading && uploadProgress ? (
            <span className="text-neutral-300">{uploadProgress}</span>
          ) : file && sourceDurationSec ? (
            <>
              ~{durationMinutes} min uses ·{" "}
              <span className="text-neutral-300">{minutesAvailable} min</span>{" "}
              left
            </>
          ) : (
            <>
              {maxSourceDurationMinutes} min/upload cap ·{" "}
              <span className="text-neutral-300">
                {minutesUsed} / {minutesLimit}
              </span>{" "}
              min used
              {topUpMinutesRemaining > 0 && (
                <span className="text-emerald-400">
                  {" "}
                  · +{topUpMinutesRemaining} top-up
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Error / blocked-reason banner */}
      {(error || blockedReason) && (
        <p
          role="alert"
          className={cn(
            "text-xs",
            error ? "text-destructive" : "text-amber-400/80"
          )}
        >
          {error ?? blockedReason}
        </p>
      )}
    </div>
  );
}
