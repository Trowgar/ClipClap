/**
 * Read-only replay of the active safe-fit decision against an immutable
 * safety capture. The capture already contains the detector shots, tracks,
 * and final plan; this script deliberately does not call the planner,
 * detectors, storage, or database.
 *
 *   /app/node_modules/.bin/tsx src/scripts/eval-reframe-safety-planner.ts \
 *     .corpus/reframe-safety/case-03.plan.json
 */
import { readFile, stat as fsStat } from "node:fs/promises";
import { faceTracksToRegionEvidence } from "../reframe/regions";
import { evaluatePlanCoverageDetailed, type SafetyShadowTelemetry } from "../reframe/safety";
import { applySafetyPlanner, type SafetyPlannerTelemetry } from "../reframe/safety-planner";
import { survivingTracks } from "../reframe/plan";
import type { CropPlan, Shot, ShotTracks } from "../reframe/types";
import {
  alignedTracks,
  parseSafetyCapture,
  type SafetyCapture,
  type SafetyShadowIo,
} from "./eval-reframe-safety-shadow";

export interface SafetyPlannerReplayResult {
  before: SafetyShadowTelemetry;
  after: SafetyShadowTelemetry;
  active: SafetyPlannerTelemetry;
  unchangedSafeShots: number;
}

export interface SafetyPlannerRunResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const TIMELINE_EPSILON = 1e-6;

function overlaps(left: Shot, right: { start: number; end: number }): boolean {
  return left.start < right.end - TIMELINE_EPSILON
    && right.start < left.end - TIMELINE_EPSILON;
}

function evidenceForCapture(capture: SafetyCapture, plan: CropPlan): {
  regions: ReturnType<typeof faceTracksToRegionEvidence>["regions"];
  invalidEvidenceShots: Set<number>;
} {
  const byIndex = new Map<number, ShotTracks>();
  for (const trackSet of capture.tracks) {
    if (
      Number.isInteger(trackSet.shotIndex)
      && trackSet.shotIndex >= 0
      && trackSet.shotIndex < capture.shots.length
    ) {
      byIndex.set(trackSet.shotIndex, trackSet);
    }
  }

  const regions: ReturnType<typeof faceTracksToRegionEvidence>["regions"] = [];
  const invalidEvidenceShots = new Set<number>();
  for (let captureIndex = 0; captureIndex < capture.shots.length; captureIndex++) {
    const trackSet = byIndex.get(captureIndex);
    if (!trackSet) continue;
    const span = capture.shots[captureIndex];
    const evidence = faceTracksToRegionEvidence(
      survivingTracks(trackSet.tracks),
      span,
      `shot-${captureIndex}`,
    );
    regions.push(...evidence.regions);
    for (let planIndex = 0; planIndex < plan.shots.length; planIndex++) {
      if (!overlaps(span, plan.shots[planIndex])) continue;
      if (evidence.invalid) invalidEvidenceShots.add(planIndex);
    }
  }
  return { regions, invalidEvidenceShots };
}

function unchangedSafeShots(before: CropPlan, after: CropPlan): number {
  let unchanged = 0;
  for (let index = 0; index < before.shots.length; index++) {
    if (JSON.stringify(before.shots[index]) === JSON.stringify(after.shots[index])) {
      unchanged++;
    }
  }
  return unchanged;
}

/** Pure evaluator for tests and offline private replay. */
export function evaluateSafetyPlannerCapture(
  value: unknown,
): SafetyPlannerReplayResult | null {
  const capture = parseSafetyCapture(value);
  if (!capture || capture.plan === null) return null;

  const plan = capture.plan;
  const evidence = evidenceForCapture(capture, plan);
  const before = evaluatePlanCoverageDetailed(plan, evidence.regions);
  const applied = applySafetyPlanner(plan, {
    verdicts: before.shots,
    mandatoryEvidenceShots: new Set(
      before.shots
        .filter((verdict) => verdict.evaluatedSamples > 0)
        .map((verdict) => verdict.shotIndex),
    ),
    invalidEvidenceShots: evidence.invalidEvidenceShots,
    invalidAlignment: !alignedTracks(capture),
  });
  const after = evaluatePlanCoverageDetailed(applied.plan, evidence.regions);
  return {
    before: before.aggregate,
    after: after.aggregate,
    active: applied.telemetry,
    unchangedSafeShots: unchangedSafeShots(plan, applied.plan),
  };
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
  code: "usage" | "capture_unreadable" | "capture_invalid",
): 1 {
  io.stderr?.(`${code}\n`);
  return 1;
}

/** Testable CLI runner. A measured safety fail is data and exits zero. */
export async function runSafetyPlannerCli(
  argv: string[] = process.argv,
  io: SafetyShadowIo = defaultIo(),
): Promise<SafetyPlannerRunResult> {
  if (argv.length !== 3) {
    return { exitCode: errorResult(io, "usage"), stdout: "", stderr: "usage\n" };
  }
  let fileSize: number;
  try {
    fileSize = (await io.stat(argv[2])).size;
  } catch {
    return {
      exitCode: errorResult(io, "capture_unreadable"),
      stdout: "",
      stderr: "capture_unreadable\n",
    };
  }
  if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_CAPTURE_BYTES) {
    return {
      exitCode: errorResult(io, "capture_invalid"),
      stdout: "",
      stderr: "capture_invalid\n",
    };
  }

  let raw: string | Buffer;
  try {
    raw = await io.readFile(argv[2]);
  } catch {
    return {
      exitCode: errorResult(io, "capture_unreadable"),
      stdout: "",
      stderr: "capture_unreadable\n",
    };
  }
  const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (rawBytes > MAX_CAPTURE_BYTES) {
    return {
      exitCode: errorResult(io, "capture_invalid"),
      stdout: "",
      stderr: "capture_invalid\n",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return {
      exitCode: errorResult(io, "capture_invalid"),
      stdout: "",
      stderr: "capture_invalid\n",
    };
  }
  const result = evaluateSafetyPlannerCapture(value);
  if (!result) {
    return {
      exitCode: errorResult(io, "capture_invalid"),
      stdout: "",
      stderr: "capture_invalid\n",
    };
  }
  const output = `${JSON.stringify(result)}\n`;
  io.stdout?.(output);
  return { exitCode: 0, stdout: output, stderr: "" };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const result = await runSafetyPlannerCli(argv);
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
