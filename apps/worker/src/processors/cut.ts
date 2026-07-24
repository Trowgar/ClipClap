import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipclap/shared";
import type { FilterSpec } from "../reframe/types";

const execFileAsync = promisify(execFile);

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
}

/**
 * Pure argv builder so the filter wiring is unit-testable. When a FilterSpec
 * is present it wins outright - its graph already contains the subtitle
 * snippet, so extraFilter is ignored. Complex specs must label their video
 * output [vout].
 */
export function buildCutArgs(
  videoPath: string,
  start: number,
  end: number,
  outPath: string,
  extraFilter?: string,
  filterSpec?: FilterSpec | null
): string[] {
  const head = ["-nostdin", "-ss", String(start), "-to", String(end), "-i", videoPath];
  const encode = [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
  ];
  if (filterSpec?.kind === "complex") {
    return [
      ...head,
      "-filter_complex", filterSpec.graph,
      "-map", "[vout]",
      "-map", "0:a?",
      ...encode,
      outPath,
      "-y",
    ];
  }
  const vf = filterSpec
    ? filterSpec.graph
    : extraFilter
      ? `${buildCropFilter()},${extraFilter}`
      : buildCropFilter();
  return [...head, "-vf", vf, ...encode, outPath, "-y"];
}

export async function cutClips(
  videoPath: string,
  highlights: Highlight[],
  extraFilter?: string,
  filterSpec?: FilterSpec | null
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const highlight of highlights) {
    const clipPath = join(tmpdir(), `clipclap-clip-${randomUUID()}.mp4`);
    await execFileAsync(
      "ffmpeg",
      buildCutArgs(videoPath, highlight.start, highlight.end, clipPath, extraFilter, filterSpec)
    );
    results.push({ highlight, clipPath });
  }

  return results;
}

export async function trimClipFile(
  videoPath: string,
  start: number,
  end: number
): Promise<string> {
  const clipPath = join(tmpdir(), `clipclap-trim-${randomUUID()}.mp4`);

  await execFileAsync("ffmpeg", [
    "-ss", String(start),
    "-to", String(end),
    "-i", videoPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    clipPath,
    "-y",
  ]);

  return clipPath;
}

/**
 * Builds an FFmpeg filter to crop video to 9:16 vertical format.
 * Centers the crop on the original video. Legacy fallback path - kept
 * verbatim as the REFRAME_ENGINE=off behavior and the failure fallback.
 */
function buildCropFilter(): string {
  return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";
}
