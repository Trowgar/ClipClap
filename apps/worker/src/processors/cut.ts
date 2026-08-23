import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipclap/shared";
import type { FilterSpec } from "../reframe/types";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
}

// R4 (spec 2026-08-23-music-shorts): fade-in/out length for a music clip.
const MUSIC_FADE_SEC = 0.25;

/**
 * Pure argv builder so the filter wiring is unit-testable. When a FilterSpec
 * is present it wins outright - its graph already contains the subtitle
 * snippet, so extraFilter is ignored. Complex specs must label their video
 * output [vout].
 *
 * `musicFades` (spec 2026-08-23-music-shorts, task R4) is the same
 * `musicDirection.fades` bit R1/R3 use, threaded down from the render stage's
 * music branch - never an env knob. Undefined/false reproduces every
 * existing call site byte for byte: the fade-out timing is derived from THIS
 * call's own `start`/`end`, the clip window the render stage already knows,
 * not re-probed from the rendered file.
 */
export function buildCutArgs(
  videoPath: string,
  start: number,
  end: number,
  outPath: string,
  extraFilter?: string,
  filterSpec?: FilterSpec | null,
  musicFades?: boolean
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
  const duration = Math.max(0, end - start);
  const fadeOutAt = Math.max(0, duration - MUSIC_FADE_SEC).toFixed(3);
  const videoFade = musicFades
    ? `fade=t=in:st=0:d=${MUSIC_FADE_SEC},fade=t=out:st=${fadeOutAt}:d=${MUSIC_FADE_SEC}`
    : null;
  const audioFade = musicFades
    ? `afade=t=in:st=0:d=${MUSIC_FADE_SEC},afade=t=out:st=${fadeOutAt}:d=${MUSIC_FADE_SEC}`
    : null;

  if (filterSpec?.kind === "complex") {
    // The graph's own convention (see the docstring above) is a final video
    // pad literally named [vout] - appending one more labelled stage after it
    // composes with every existing complex graph (split/stream layouts,
    // and R3's punch-in) without knowing anything about their insides.
    const graph = videoFade
      ? `${filterSpec.graph};[vout]${videoFade}[voutfaded];[0:a]${audioFade}[aoutfaded]`
      : filterSpec.graph;
    return [
      ...head,
      "-filter_complex", graph,
      "-map", videoFade ? "[voutfaded]" : "[vout]",
      "-map", videoFade ? "[aoutfaded]" : "0:a:0?",
      ...encode,
      outPath,
      "-y",
    ];
  }
  const baseVf = filterSpec
    ? filterSpec.graph
    : extraFilter
      ? `${buildCropFilter()},${extraFilter}`
      : buildCropFilter();
  const vf = videoFade ? `${baseVf},${videoFade}` : baseVf;
  const args = [...head, "-vf", vf];
  if (audioFade) args.push("-af", audioFade);
  args.push(...encode, outPath, "-y");
  return args;
}

export async function cutClips(
  videoPath: string,
  highlights: Highlight[],
  extraFilter?: string,
  filterSpec?: FilterSpec | null,
  musicFades?: boolean
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const highlight of highlights) {
    const clipPath = join(tmpdir(), `clipclap-clip-${randomUUID()}.mp4`);
    await execFileAsync(
      "ffmpeg",
      buildCutArgs(
        videoPath,
        highlight.start,
        highlight.end,
        clipPath,
        extraFilter,
        filterSpec,
        musicFades
      ),
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
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
  ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });

  return clipPath;
}

/**
 * Builds an FFmpeg filter to crop video to 9:16 vertical format.
 * Centers the crop on the original video. Legacy fallback path - kept
 * verbatim as the REFRAME_ENGINE=off behavior and the failure fallback.
 */
function buildCropFilter(): string {
  // setsar=1: ih*9/16 is 607.5 on a 1080-tall source and cannot be integral, so
  // `scale` to exactly 1080x1920 would otherwise tag the output SAR 1216:1215
  // and give it a 76:135 display aspect. This path renders real clips whenever
  // detection fails or REFRAME_ENGINE is off, so it needs the same guarantee as
  // the reframe graphs (engine-notes §7h).
  return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,setsar=1";
}
