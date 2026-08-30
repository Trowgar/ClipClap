import type { ShotSafetyVerdict } from "./safety";
import type { CropPlan, SafeFitReason, ShotLayout } from "./types";

export interface SafetyPlannerInput {
  verdicts: ShotSafetyVerdict[];
  mandatoryEvidenceShots: ReadonlySet<number>;
  invalidEvidenceShots: ReadonlySet<number>;
  invalidAlignment: boolean;
}

export interface SafetyPlannerTelemetry {
  mode: "active";
  evaluatedShots: number;
  safeFitShots: number;
  coverageFallbacks: number;
  invalidEvidenceFallbacks: number;
  minimumCoverage: number | null;
}

const emptyTelemetry = (input: SafetyPlannerInput): SafetyPlannerTelemetry => ({
  mode: "active",
  evaluatedShots: input.verdicts.filter(
    (verdict) => verdict.evaluatedSamples > 0
  ).length,
  safeFitShots: 0,
  coverageFallbacks: 0,
  invalidEvidenceFallbacks: 0,
  minimumCoverage: null,
});

function replacementReason(
  shotIndex: number,
  planShot: ShotLayout,
  input: SafetyPlannerInput,
  verdicts: ReadonlyMap<number, ShotSafetyVerdict>
): SafeFitReason | null {
  // A safe-fit shot is already the fail-safe composition. Keeping it intact
  // is what makes repeated planner application idempotent.
  if (planShot.layout === "safe-fit") return null;

  if (input.invalidAlignment || input.invalidEvidenceShots.has(shotIndex)) {
    return "invalid_evidence";
  }
  if (!input.mandatoryEvidenceShots.has(shotIndex)) return null;

  const verdict = verdicts.get(shotIndex);
  // Missing evidence for a shot which was declared mandatory is not evidence
  // that the crop is safe. Fail closed, and keep that reason distinct from a
  // measured coverage failure.
  if (!verdict) return "invalid_evidence";
  return verdict.status === "fail" || verdict.status === "not_evaluable"
    ? "coverage"
    : null;
}

function mergeAdjacentSafeFit(
  shots: ShotLayout[]
): { shots: ShotLayout[]; merged: boolean } {
  const merged: ShotLayout[] = [];
  let didMerge = false;
  for (const shot of shots) {
    const previous = merged[merged.length - 1];
    if (
      previous?.layout === "safe-fit" &&
      shot.layout === "safe-fit" &&
      previous.reason === shot.reason &&
      previous.end === shot.start
    ) {
      // Never mutate an original plan shot: the previous item may still be a
      // reference into the caller's plan when it was already safe-fit.
      merged[merged.length - 1] = {
        start: previous.start,
        end: shot.end,
        layout: "safe-fit",
        reason: previous.reason,
      };
      didMerge = true;
      continue;
    }
    merged.push(shot);
  }
  return { shots: merged, merged: didMerge };
}

export function applySafetyPlanner(
  plan: CropPlan,
  input: SafetyPlannerInput
): { plan: CropPlan; telemetry: SafetyPlannerTelemetry } {
  const telemetry = emptyTelemetry(input);
  const verdicts = new Map<number, ShotSafetyVerdict>();
  for (const verdict of input.verdicts) {
    const inPlan =
      Number.isInteger(verdict.shotIndex) &&
      verdict.shotIndex >= 0 &&
      verdict.shotIndex < plan.shots.length;
    if (inPlan) {
      verdicts.set(verdict.shotIndex, verdict);
    }
    if (
      inPlan &&
      input.mandatoryEvidenceShots.has(verdict.shotIndex) &&
      Number.isFinite(verdict.minimumCoverage)
    ) {
      telemetry.minimumCoverage =
        telemetry.minimumCoverage === null
          ? verdict.minimumCoverage
          : Math.min(telemetry.minimumCoverage, verdict.minimumCoverage as number);
    }
  }

  const plannedShots: ShotLayout[] = [];
  for (let shotIndex = 0; shotIndex < plan.shots.length; shotIndex++) {
    const originalShot = plan.shots[shotIndex];
    const reason = replacementReason(shotIndex, originalShot, input, verdicts);
    if (!reason) {
      plannedShots.push(originalShot);
      continue;
    }

    plannedShots.push({
      start: originalShot.start,
      end: originalShot.end,
      layout: "safe-fit",
      reason,
    });
    telemetry.safeFitShots++;
    if (reason === "coverage") telemetry.coverageFallbacks++;
    else telemetry.invalidEvidenceFallbacks++;
  }

  const merged = mergeAdjacentSafeFit(plannedShots);
  if (
    telemetry.safeFitShots === 0 &&
    !merged.merged
  ) {
    return { plan, telemetry };
  }

  return {
    plan: {
      ...plan,
      version: 4,
      shots: merged.shots,
    },
    telemetry,
  };
}
