import { execFile } from "child_process";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

export interface TimeWindow {
  start: number;
  end: number;
}

export interface LetterboxBars {
  topBar: number;
  bottomBar: number;
}

/**
 * Constant-letterbox-bar detection (spec 2026-08-23-music-shorts, task R1).
 *
 * SAFETY RULE, measured 2026-08-19 in
 * `.corpus/letterbox/measurement-2026-08-19.md`: of 11 director-audit corpus
 * sources, exactly 1 carried a genuine source-constant bar (uniform at three
 * spread samples) and exactly 1 carried a TRANSIENT bar - one dark scene,
 * full frame everywhere else - that a single-sample cropdetect would have
 * wrongly cropped across the whole source. "Only a CONSTANT bar may ever be
 * cropped" is not a nicety here, it is the entire difference between the
 * feature and a defect that silently crops content off a fifth of the
 * sources it touches.
 *
 * `consistentBarHeight` is that rule as a pure function: the tightest cluster
 * of samples within `TOLERANCE_PX` of each other must cover at least
 * `AGREEMENT_FRAC` of all samples before ANY value is trusted; short of that
 * the bar is presumed transient and rejected outright (0), never partially
 * trusted or averaged in.
 */
const AGREEMENT_FRAC = 0.9;
const TOLERANCE_PX = 4;
const MAX_BAR_FRAC = 0.2;
const SAMPLE_COUNT = 8;

/**
 * The tightest within-`TOLERANCE_PX` cluster's median, or 0 when no cluster
 * covers `AGREEMENT_FRAC` of the samples. Ties between equally-sized clusters
 * resolve to whichever reference value is scanned first - deterministic
 * because `samples` is iterated in a fixed order, not chosen for a reason.
 */
export function consistentBarHeight(samples: number[]): number {
  if (samples.length === 0) return 0;
  let bestCluster: number[] = [];
  for (const ref of samples) {
    const cluster = samples.filter((v) => Math.abs(v - ref) <= TOLERANCE_PX);
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }
  if (bestCluster.length / samples.length < AGREEMENT_FRAC) return 0;
  const sorted = [...bestCluster].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Caps a bar at `MAX_BAR_FRAC` of the source height and even-snaps it -
 *  rounding DOWN so the snap can never push a capped value back over the
 *  cap. Negative input (should not happen; defense in depth) floors at 0. */
export function capBarHeight(raw: number, sourceHeight: number): number {
  const cap = Math.floor(sourceHeight * MAX_BAR_FRAC);
  const capped = Math.min(Math.max(0, raw), cap);
  return 2 * Math.floor(capped / 2);
}

/**
 * ~`count` sample timestamps spread across the UNION of `windows`, allocated
 * proportionally to each window's share of the total duration (at least 1 per
 * window, when the count allows it) and placed evenly INSIDE each window
 * rather than on its edges - a scene cut sitting exactly on a highlight
 * boundary is the least representative frame available for judging a bar
 * that is supposed to be constant.
 */
export function sampleTimestamps(
  windows: TimeWindow[],
  count: number = SAMPLE_COUNT
): number[] {
  const durations = windows.map((w) => Math.max(0, w.end - w.start));
  const total = durations.reduce((s, d) => s + d, 0);
  if (total <= 0) return [];
  const times: number[] = [];
  let remaining = count;
  windows.forEach((w, i) => {
    const dur = durations[i];
    if (dur <= 0) return;
    const isLast = i === windows.length - 1;
    const share = isLast
      ? remaining
      : Math.min(remaining, Math.max(1, Math.round((dur / total) * count)));
    for (let k = 0; k < share; k++) {
      const frac = (k + 1) / (share + 1);
      times.push(w.start + dur * frac);
    }
    remaining -= share;
  });
  return times;
}

function parseCropLine(
  stderr: string
): { w: number; h: number; x: number; y: number } | null {
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) return null;
  // cropdetect logs a new suggestion roughly every frame and settles quickly;
  // the LAST line of a short burst is its most-converged reading.
  const last = matches[matches.length - 1];
  return {
    w: Number(last[1]),
    h: Number(last[2]),
    x: Number(last[3]),
    y: Number(last[4]),
  };
}

async function probeSourceHeight(sourcePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=height",
      "-of", "default=noprint_wrappers=1:nokey=1",
      sourcePath,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return Number(stdout.trim()) || 0;
}

/** One cropdetect sample, a 1s burst at `t`. Null on any failure (a bad seek
 *  near the very end of a file, an unreadable frame) - a missing sample just
 *  shrinks the agreement pool the consistency rule checks against, it never
 *  fails the whole detection. */
async function sampleCrop(
  sourcePath: string,
  t: number,
  sourceHeight: number
): Promise<LetterboxBars | null> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "info",
        "-ss", String(t), "-t", "1", "-i", sourcePath,
        "-vf", "cropdetect=24:2:0",
        "-f", "null", "-",
      ],
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    const crop = parseCropLine(stderr);
    if (!crop) return null;
    return { topBar: crop.y, bottomBar: Math.max(0, sourceHeight - crop.h - crop.y) };
  } catch {
    return null;
  }
}

/**
 * Detects a constant letterbox bar pair on `sourcePath`, sampled across the
 * job's own highlight windows (spec R1). Returns `{ topBar: 0, bottomBar: 0 }`
 * - not null - whenever no bar clears the consistency rule; null is reserved
 * for "detection could not run at all" (source unreadable), which the caller
 * treats identically to a zero pair since either way there is nothing safe to
 * crop. Never throws: a music render must not fail because bar detection did.
 */
export async function detectLetterboxBars(
  sourcePath: string,
  windows: TimeWindow[]
): Promise<LetterboxBars | null> {
  try {
    const sourceHeight = await probeSourceHeight(sourcePath);
    if (!sourceHeight) return null;
    const times = sampleTimestamps(windows);
    if (times.length === 0) return { topBar: 0, bottomBar: 0 };
    const samples = await Promise.all(
      times.map((t) => sampleCrop(sourcePath, t, sourceHeight))
    );
    const present = samples.filter((s): s is LetterboxBars => s !== null);
    if (present.length === 0) return { topBar: 0, bottomBar: 0 };
    const topBar = capBarHeight(
      consistentBarHeight(present.map((s) => s.topBar)),
      sourceHeight
    );
    const bottomBar = capBarHeight(
      consistentBarHeight(present.map((s) => s.bottomBar)),
      sourceHeight
    );
    return { topBar, bottomBar };
  } catch (error) {
    console.warn(`[render] letterbox bar detection failed for ${sourcePath}:`, error);
    return null;
  }
}
