import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipclap/shared";
import type { FilterSpec } from "../reframe/types";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

// Black-tail trim (spec 2026-08-25-cjk-subtitles §Black-tail trim, design B).
// Job cmt8155fa: moment selection snapped the exit to a payoff-like line
// ("il vient de mourir") right where the source cuts to black for 3.5s - the
// clip ends on a blank frame with a live caption still on screen. These
// constants are the measured/decided numbers from that section, not knobs.
const BLACK_TAIL_PROBE_SEC = 2;
const BLACK_TAIL_MAX_TRIM_SEC = 1.5;
const BLACK_TAIL_MARGIN_SEC = 0.04;
// analyze.ts's TARGET_MIN_DURATION_SEC (30) is a highlight-selection TARGET,
// not exported and not reachable from here - this is a local, conservative
// hard floor so a trim can never cut a clip down to nothing.
const BLACK_TAIL_MIN_CLIP_SEC = 12;
// Frame-quantization slack for deciding a black interval "runs to the probe
// end": under our exact -ss/-t/-f null command, ffmpeg 8.0.1 (the container's
// build) ALWAYS flushes a final black_end at the probe's true end, measured
// 0.02-0.04s short of the nominal duration (verified against both a
// synthetic lavfi fixture and the real French source, job cmt8155fa). Set to
// 2 frames at 25fps (0.08s) - 2x the measured gap, comfortably below
// BLACK_TAIL_MAX_TRIM_SEC.
const BLACK_TAIL_END_TOLERANCE_SEC = 0.08;
// Mirrors reframe/index.ts's execFile timeout idiom
// ({ timeout: timeoutMs, maxBuffer }) - a probe must never hang a render.
const BLACK_TAIL_PROBE_TIMEOUT_MS = 5000;

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
  /** The end actually cut, source-absolute seconds. Equal to
   *  `highlight.end` unless black-tail trim (RENDER_BLACK_TAIL_TRIM) pulled
   *  it back. Optional so a hand-built mock (every existing render.ts test)
   *  that omits it keeps meaning "use highlight.end", exactly today's
   *  behaviour. */
  effectiveEnd?: number;
}

/** Context threaded from render.ts's highlights loop, for the black-tail
 *  trim's log line only - never used to decide WHETHER the trim runs (that
 *  is env.RENDER_BLACK_TAIL_TRIM alone, checked in resolveBlackTailEnd). */
export interface BlackTailTrimContext {
  jobId: string;
  clipIndex: number;
}

export interface BlackTailProbeResult {
  end: number;
  trimmedSec: number;
}

/**
 * Runs blackdetect over the source's own last `BLACK_TAIL_PROBE_SEC` of the
 * highlight window and, if the clip genuinely ends on black, returns a
 * pulled-back end. Never throws - any probe failure/timeout degrades to the
 * nominal `end` untouched, because a render must never fail over this probe.
 * Inert unless `RENDER_BLACK_TAIL_TRIM` is the exact literal "on".
 */
export async function resolveBlackTailEnd(
  videoPath: string,
  start: number,
  end: number,
  jobId: string,
  clipIndex: number
): Promise<BlackTailProbeResult> {
  const noTrim: BlackTailProbeResult = { end, trimmedSec: 0 };
  // Exact literal, the REFRAME_STREAM rule: a stray truthy value must not
  // start re-timing clips nobody asked to trim.
  if (process.env.RENDER_BLACK_TAIL_TRIM !== "on") return noTrim;

  const probeStart = Math.max(0, end - BLACK_TAIL_PROBE_SEC);
  const probeDuration = end - probeStart;

  let stderr: string;
  try {
    const result = await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-ss", String(probeStart),
        "-t", String(probeDuration),
        "-i", videoPath,
        "-vf", "blackdetect=d=0.1:pix_th=0.10",
        "-an",
        "-f", "null",
        "-",
      ],
      { timeout: BLACK_TAIL_PROBE_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    stderr = result.stderr ?? "";
  } catch (error) {
    console.warn(
      `[cut] black-tail probe failed on job ${jobId} clip ${clipIndex}, cutting at the nominal end:`,
      error
    );
    return noTrim;
  }

  const blackStartRel = lastBlackStartRunningToEnd(stderr, probeDuration);
  if (blackStartRel === null) return noTrim;

  const blackStartAbs = probeStart + blackStartRel;
  // Reject outright when black_start itself is more than MAX_TRIM_SEC before
  // the end: a clip black for that long at its tail is a moment-selection
  // problem, not a tail to shave.
  if (end - blackStartAbs > BLACK_TAIL_MAX_TRIM_SEC) return noTrim;

  // Clamp the APPLIED trim, not just black_start's own distance from `end`:
  // a black_start exactly at the MAX_TRIM_SEC boundary still clears the gate
  // above, but subtracting MARGIN_SEC on top of it would trim
  // MAX_TRIM_SEC + MARGIN_SEC (1.54s). Math.max keeps trimmedEnd no earlier
  // than `end - MAX_TRIM_SEC`, so the applied trim can never exceed the cap.
  // Rounded to milliseconds: floating-point addition of probeStart + relative
  // offset (both parsed from strings) otherwise leaves artifacts like
  // 74.78999999999999 on the ffmpeg command line and in the stored clip row.
  const trimmedEnd =
    Math.round(
      Math.max(
        blackStartAbs - BLACK_TAIL_MARGIN_SEC,
        end - BLACK_TAIL_MAX_TRIM_SEC
      ) * 1000
    ) / 1000;
  if (trimmedEnd - start < BLACK_TAIL_MIN_CLIP_SEC) return noTrim;

  const trimmedSec = end - trimmedEnd;
  console.log(
    `[cut] black-tail trim on job ${jobId} clip ${clipIndex}: trimmedSec=${trimmedSec.toFixed(2)}`
  );
  return { end: trimmedEnd, trimmedSec };
}

/**
 * Parses blackdetect's stderr lines (`black_start:X black_end:Y` on the same
 * line - under our exact -ss/-t/-f null command, ffmpeg 8.0.1 always flushes
 * both together, even when black runs all the way to the probe's own end; see
 * BLACK_TAIL_END_TOLERANCE_SEC) and returns the LAST black period's start
 * (relative to the probe's own start) if - and only if - `black_end` lands
 * within BLACK_TAIL_END_TOLERANCE_SEC of the probe's actual duration. A
 * period that closes well before the probe ends is a mid-window flash, not a
 * genuine black tail.
 */
function lastBlackStartRunningToEnd(
  stderr: string,
  probeDuration: number
): number | null {
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let match: RegExpExecArray | null;
  let lastStart: number | null = null;
  let runsToEnd = false;
  while ((match = re.exec(stderr)) !== null) {
    lastStart = Number(match[1]);
    const blackEnd = Number(match[2]);
    runsToEnd = probeDuration - blackEnd <= BLACK_TAIL_END_TOLERANCE_SEC;
  }
  return lastStart !== null && runsToEnd ? lastStart : null;
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
  musicFades?: boolean,
  blackTailTrim?: BlackTailTrimContext
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const [index, highlight] of highlights.entries()) {
    const clipPath = join(tmpdir(), `clipclap-clip-${randomUUID()}.mp4`);
    let end = highlight.end;
    if (blackTailTrim) {
      const trimmed = await resolveBlackTailEnd(
        videoPath,
        highlight.start,
        highlight.end,
        blackTailTrim.jobId,
        blackTailTrim.clipIndex + index
      );
      end = trimmed.end;
    }
    await execFileAsync(
      "ffmpeg",
      buildCutArgs(
        videoPath,
        highlight.start,
        end,
        clipPath,
        extraFilter,
        filterSpec,
        musicFades
      ),
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    results.push({ highlight, clipPath, effectiveEnd: end });
  }

  return results;
}

export async function trimClipFile(
  videoPath: string,
  start: number,
  end: number,
  destinationPath?: string
): Promise<string> {
  const clipPath = destinationPath ?? join(tmpdir(), `clipclap-trim-${randomUUID()}.mp4`);

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
