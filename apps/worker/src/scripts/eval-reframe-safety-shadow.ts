/**
 * Read-only private reader for a corpus-baseline capture. It intentionally
 * reports only the aggregate safety result; detector evidence stays on disk.
 *
 *   /app/node_modules/.bin/tsx src/scripts/eval-reframe-safety-shadow.ts \
 *     .corpus/reframe-safety/case-03.plan.json
 */
import { readFile, stat as fsStat } from "node:fs/promises";
import { faceTracksToRegions } from "../reframe/regions";
import { evaluatePlanCoverage, type SafetyShadowTelemetry } from "../reframe/safety";
import { MAX_PLAN_SHOTS, survivingTracks } from "../reframe/plan";
import type { CropPlan, FaceBox, FaceTrack, Shot, ShotTracks } from "../reframe/types";

export interface SafetyCapture {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

export interface SafetyShadowIo {
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string): Promise<string | Buffer>;
  stdout?(value: string): void;
  stderr?(value: string): void;
}

export interface SafetyShadowRunResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/** Raw detector captures may contain more cuts than the final planner keeps;
 * 1000 is bounded well above realistic clip detection while remaining small
 * enough to reject pathological JSON before building any regions. */
const MAX_CAPTURE_SHOTS = 1_000;
const MAX_CAPTURE_TRACKS = 100_000;
const MAX_CAPTURE_PATH_SAMPLES = 500_000;
const TIMELINE_EPSILON = 1e-6;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveBox(value: unknown): value is FaceBox {
  const box = record(value);
  return !!box && finite(box.x) && finite(box.y) && finite(box.w) && finite(box.h)
    && box.w > 0 && box.h > 0;
}

function validShot(value: unknown): value is Shot {
  const shot = record(value);
  return !!shot && finite(shot.start) && finite(shot.end) && shot.end > shot.start;
}

function validTimeline(
  shots: unknown[],
  duration: number,
  envelope?: { start: number; end: number }
): boolean {
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const value of shots) {
    if (!validShot(value)) return false;
    const shot = value as Shot;
    if (
      shot.start < -TIMELINE_EPSILON ||
      shot.end > duration + TIMELINE_EPSILON ||
      (previousEnd !== Number.NEGATIVE_INFINITY &&
        Math.abs(shot.start - previousEnd) > TIMELINE_EPSILON)
    ) return false;
    if (
      envelope &&
      (shot.start < envelope.start - TIMELINE_EPSILON ||
        shot.end > envelope.end + TIMELINE_EPSILON)
    ) return false;
    previousEnd = shot.end;
  }
  if (shots.length === 0) return false;
  const first = shots[0] as Shot;
  const last = shots[shots.length - 1] as Shot;
  return Math.abs(first.start) <= TIMELINE_EPSILON
    && Math.abs(last.end - duration) <= TIMELINE_EPSILON;
}

function validFaceTrack(value: unknown): value is FaceTrack {
  const track = record(value);
  if (!track || !Number.isInteger(track.id) || !positiveBox(track.box)) return false;
  if (!finite(track.score) || !finite(track.samples) || track.samples < 0) return false;
  if (!finite(track.mouthActivity)) return false;
  if (track.path === undefined) return true;
  if (!Array.isArray(track.path)) return false;
  return track.path.every((sample) => {
    const point = record(sample);
    return !!point && finite(point.t) && positiveBox(point);
  });
}

function validTrackSet(value: unknown): value is ShotTracks {
  const set = record(value);
  // `shotIndex` is checked by alignedTracks so an absent, duplicate, or
  // out-of-range index becomes an aggregate not_evaluable result rather than
  // changing the CLI's fixed input-error contract.
  return !!set && Array.isArray(set.tracks)
    && set.tracks.every(validFaceTrack)
    && (set.camRect === null || set.camRect === undefined || positiveBox(set.camRect));
}

/** A shallow plan envelope is enough to keep the defensive evaluator total. */
function validPlanEnvelope(value: unknown): value is CropPlan {
  const plan = record(value);
  const source = record(plan?.source);
  return !!plan && plan.engine === "faces" && Array.isArray(plan.shots)
    && plan.shots.length > 0 && plan.shots.length <= MAX_PLAN_SHOTS && !!source
    && finite(source.width) && finite(source.height)
    && source.width > 0 && source.height > 0;
}

function pathsBelongToCaptureShots(capture: SafetyCapture): boolean {
  for (const trackSet of capture.tracks) {
    if (
      !Number.isInteger(trackSet.shotIndex) ||
      trackSet.shotIndex < 0 ||
      trackSet.shotIndex >= capture.shots.length
    ) continue;
    const shot = capture.shots[trackSet.shotIndex];
    for (const track of trackSet.tracks) {
      if (track.path?.some((sample) => sample.t < shot.start || sample.t > shot.end)) {
        return false;
      }
    }
  }
  return true;
}

function validCapture(value: unknown): value is SafetyCapture {
  const capture = record(value);
  const source = record(capture?.source);
  const clip = record(capture?.clip);
  if (
    !capture ||
    !Array.isArray(capture.shots) ||
    capture.shots.length === 0 ||
    capture.shots.length > MAX_CAPTURE_SHOTS ||
    !Array.isArray(capture.tracks) ||
    capture.tracks.length > MAX_CAPTURE_SHOTS ||
    !capture.tracks.every(validTrackSet) ||
    (capture.plan !== null && !validPlanEnvelope(capture.plan)) ||
    !source ||
    !finite(source.width) ||
    !finite(source.height) ||
    source.width <= 0 ||
    source.height <= 0 ||
    !clip ||
    !finite(clip.start) ||
    !finite(clip.end) ||
    clip.end <= clip.start ||
    !validTimeline(capture.shots, clip.end - clip.start)
  ) return false;

  const typedCapture = capture as unknown as SafetyCapture;
  let trackCount = 0;
  let pathSampleCount = 0;
  for (const trackSet of typedCapture.tracks) {
    trackCount += trackSet.tracks.length;
    for (const track of trackSet.tracks) {
      pathSampleCount += track.path?.length ?? 0;
    }
  }
  if (trackCount > MAX_CAPTURE_TRACKS || pathSampleCount > MAX_CAPTURE_PATH_SAMPLES) return false;
  if (!pathsBelongToCaptureShots(typedCapture)) return false;

  if (typedCapture.plan !== null) {
    const planSource = typedCapture.plan.source;
    if (planSource.width !== source.width || planSource.height !== source.height) return false;
    const first = typedCapture.shots[0];
    const last = typedCapture.shots[typedCapture.shots.length - 1];
    if (!validTimeline(typedCapture.plan.shots, clip.end - clip.start, { start: first.start, end: last.end })) {
      return false;
    }
  }
  return true;
}

function notEvaluable(): SafetyShadowTelemetry {
  return {
    status: "not_evaluable",
    threshold: 0.9,
    minimumCoverage: null,
    evaluatedSamples: 0,
    rejectedSamples: 0,
    unmappedSamples: 0,
  };
}

function alignedTracks(capture: SafetyCapture): boolean {
  if (capture.tracks.length !== capture.shots.length) return false;
  const seen = new Set<number>();
  for (const trackSet of capture.tracks) {
    if (
      !Number.isInteger(trackSet.shotIndex) ||
      trackSet.shotIndex < 0 ||
      trackSet.shotIndex >= capture.shots.length ||
      seen.has(trackSet.shotIndex)
    ) return false;
    seen.add(trackSet.shotIndex);
  }
  return seen.size === capture.shots.length;
}

/** Pure replay helper, exported so tests can exercise the reader without a process. */
export function evaluateSafetyCapture(value: unknown): SafetyShadowTelemetry | null {
  if (!validCapture(value)) return null;
  if (!captureHasUsablePlan(value)) return null;
  if (!alignedTracks(value)) return notEvaluable();

  const byIndex = new Map(value.tracks.map((trackSet) => [trackSet.shotIndex, trackSet]));
  const regions = value.shots.flatMap((shot, index) => {
    const trackSet = byIndex.get(index);
    return trackSet
      ? faceTracksToRegions(survivingTracks(trackSet.tracks), shot, `shot-${index}`)
      : [];
  });
  return evaluatePlanCoverage(value.plan, regions);
}

function captureHasUsablePlan(capture: SafetyCapture): capture is SafetyCapture & { plan: CropPlan } {
  return capture.plan !== null;
}

function defaultIo(): SafetyShadowIo {
  return {
    stat: async (path) => fsStat(path),
    readFile: async (path) => readFile(path, "utf8"),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

function errorResult(
  io: SafetyShadowIo,
  code: "usage" | "capture_unreadable" | "capture_invalid"
): 1 {
  io.stderr?.(`${code}\n`);
  return 1;
}

/** Testable CLI runner; diagnostics are data, so a valid fail aggregate exits 0. */
export async function runSafetyShadowCli(
  argv: string[] = process.argv,
  io: SafetyShadowIo = defaultIo()
): Promise<SafetyShadowRunResult> {
  if (argv.length !== 3) {
    return { exitCode: errorResult(io, "usage"), stdout: "", stderr: "usage\n" };
  }
  let fileSize: number;
  try {
    fileSize = (await io.stat(argv[2])).size;
  } catch {
    return { exitCode: errorResult(io, "capture_unreadable"), stdout: "", stderr: "capture_unreadable\n" };
  }
  if (!finite(fileSize) || fileSize < 0 || fileSize > MAX_CAPTURE_BYTES) {
    return { exitCode: errorResult(io, "capture_invalid"), stdout: "", stderr: "capture_invalid\n" };
  }
  let raw: string | Buffer;
  try {
    raw = await io.readFile(argv[2]);
  } catch {
    return { exitCode: errorResult(io, "capture_unreadable"), stdout: "", stderr: "capture_unreadable\n" };
  }
  const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (rawBytes > MAX_CAPTURE_BYTES) {
    return { exitCode: errorResult(io, "capture_invalid"), stdout: "", stderr: "capture_invalid\n" };
  }
  const rawText = typeof raw === "string" ? raw : raw.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { exitCode: errorResult(io, "capture_invalid"), stdout: "", stderr: "capture_invalid\n" };
  }
  if (!validCapture(value)) {
    return { exitCode: errorResult(io, "capture_invalid"), stdout: "", stderr: "capture_invalid\n" };
  }
  try {
    const output = `${JSON.stringify({ safetyShadow: evaluateSafetyCapture(value) })}\n`;
    io.stdout?.(output);
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch {
    return { exitCode: errorResult(io, "capture_invalid"), stdout: "", stderr: "capture_invalid\n" };
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const result = await runSafetyShadowCli(argv);
  process.exitCode = result.exitCode;
}

if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write("capture_invalid\n");
  });
}
