import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { UnsupportedInputError } from "./errors";

const execFileAsync = promisify(execFile);

const START_TOLERANCE_SEC = 0.05;
const SKEW_TOLERANCE_SEC = 0.04;

export interface TimelineProbe {
  formatStart: number | null;
  videoStart: number | null;
  audioStart: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export function parseTimelineProbe(json: string): TimelineProbe {
  const parsed = JSON.parse(json) as {
    format?: { start_time?: string };
    streams?: Array<{ codec_type?: string; start_time?: string }>;
  };
  const toNum = (v: string | undefined): number | null => {
    if (v === undefined || v === "N/A") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  return {
    formatStart: toNum(parsed.format?.start_time),
    videoStart: video ? toNum(video.start_time) : null,
    audioStart: audio ? toNum(audio.start_time) : null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

export function needsNormalization(probe: TimelineProbe): boolean {
  const starts = [probe.formatStart, probe.videoStart];
  if (probe.hasAudio) starts.push(probe.audioStart);
  // unknown (N/A) start -> cannot trust the timeline, normalize + verify
  if (starts.some((s) => s === null)) return true;
  return starts.some((s) => Math.abs(s as number) > START_TOLERANCE_SEC);
}

export interface NormalizeOutcome {
  path: string;
  action: "none" | "remux" | "reencode";
}

/** Probe -> conditional remux -> verify -> re-encode fallback (spec §10). */
export async function normalizeSource(localPath: string): Promise<NormalizeOutcome> {
  const probe = await probeTimeline(localPath);
  if (!probe.hasVideo) {
    // clear user-facing outcome instead of a confusing downstream failure;
    // a video WITHOUT audio proceeds and ends at the degenerate 0-clip guard
    throw new UnsupportedInputError(
      "Audio-only input is not supported - please upload a video file"
    );
  }
  if (!needsNormalization(probe)) {
    return { path: localPath, action: "none" };
  }

  const remuxPath = join(tmpdir(), `clipclap-norm-${randomUUID()}.mp4`);
  try {
    await execFileAsync("ffmpeg", [
      "-ignore_editlist", "1", "-i", localPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero", "-muxpreload", "0", "-muxdelay", "0",
      "-movflags", "+faststart", remuxPath, "-y",
    ]);
    if (await verifyNormalized(remuxPath)) {
      return { path: remuxPath, action: "remux" };
    }
  } catch (error) {
    console.warn("[normalize] remux failed, falling back to re-encode:", error);
  }

  const reencodePath = join(tmpdir(), `clipclap-norm-${randomUUID()}.mp4`);
  await execFileAsync("ffmpeg", [
    "-ignore_editlist", "1", "-i", localPath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "160k", "-af", "aresample=async=1",
    "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
    reencodePath, "-y",
  ]);
  return { path: reencodePath, action: "reencode" };
}

export async function probeTimeline(path: string): Promise<TimelineProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=start_time",
    "-show_entries", "stream=index,codec_type,start_time",
    "-of", "json", path,
  ]);
  return parseTimelineProbe(stdout);
}

async function verifyNormalized(path: string): Promise<boolean> {
  const probe = await probeTimeline(path);
  const near0 = (v: number | null) => v !== null && Math.abs(v) <= START_TOLERANCE_SEC;
  if (!near0(probe.videoStart)) return false;
  if (probe.hasAudio) {
    if (!near0(probe.audioStart)) return false;
    if (
      probe.videoStart !== null &&
      probe.audioStart !== null &&
      Math.abs(probe.videoStart - probe.audioStart) > SKEW_TOLERANCE_SEC
    ) {
      return false;
    }
  }
  return true;
}
