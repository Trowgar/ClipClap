/**
 * Read-only private reader for a corpus-baseline capture. It intentionally
 * reports only the aggregate safety result; detector evidence stays on disk.
 *
 *   /app/node_modules/.bin/tsx src/scripts/eval-reframe-safety-shadow.ts \
 *     .corpus/reframe-safety/case-03.plan.json
 */
import { readFile } from "node:fs/promises";
import { faceTracksToRegions } from "../reframe/regions";
import { evaluatePlanCoverage, type SafetyShadowTelemetry } from "../reframe/safety";
import { survivingTracks } from "../reframe/plan";
import type { CropPlan, FaceBox, FaceTrack, Shot, ShotTracks } from "../reframe/types";

export interface SafetyCapture {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

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
    && plan.shots.length > 0 && !!source
    && finite(source.width) && finite(source.height)
    && source.width > 0 && source.height > 0;
}

function validCapture(value: unknown): value is SafetyCapture {
  const capture = record(value);
  const source = record(capture?.source);
  const clip = record(capture?.clip);
  return !!capture && Array.isArray(capture.shots) && capture.shots.length > 0
    && capture.shots.every(validShot)
    && Array.isArray(capture.tracks) && capture.tracks.every(validTrackSet)
    && (capture.plan === null || validPlanEnvelope(capture.plan))
    && !!source && finite(source.width) && finite(source.height)
    && source.width > 0 && source.height > 0
    && !!clip && finite(clip.start) && finite(clip.end) && clip.end >= clip.start;
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

function fail(code: "usage" | "capture_unreadable" | "capture_invalid"): void {
  process.exitCode = 1;
  process.stderr.write(`${code}\n`);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.length !== 3) {
    fail("usage");
    return;
  }
  let raw: string;
  try {
    raw = await readFile(argv[2], "utf8");
  } catch {
    fail("capture_unreadable");
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("capture_invalid");
    return;
  }
  if (!validCapture(value)) {
    fail("capture_invalid");
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify({ safetyShadow: evaluateSafetyCapture(value) })}\n`);
  } catch {
    fail("capture_invalid");
  }
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch(() => fail("capture_invalid"));
}
