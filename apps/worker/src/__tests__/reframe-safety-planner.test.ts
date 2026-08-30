import { describe, expect, it } from "vitest";
import { applySafetyPlanner, type SafetyPlannerInput } from "../reframe/safety-planner";
import type { CropPlan, ShotLayout } from "../reframe/types";

const shot = (start: number, end: number, x = 0): ShotLayout => ({
  start,
  end,
  layout: "single",
  x,
});

const safe = (
  start: number,
  end: number,
  reason: "coverage" | "invalid_evidence"
): ShotLayout => ({ start, end, layout: "safe-fit", reason });

const plan = (shots: ShotLayout[], version: CropPlan["version"] = 3): CropPlan => ({
  version,
  engine: "faces",
  source: { width: 1920, height: 1080 },
  shots,
});

const verdict = (
  shotIndex: number,
  status: "not_evaluable" | "pass" | "fail",
  minimumCoverage: number | null,
  evaluatedSamples = 1
) => ({
  shotIndex,
  status,
  minimumCoverage,
  evaluatedSamples,
  rejectedSamples: status === "fail" ? 1 : 0,
  unmappedSamples: status === "not_evaluable" ? 1 : 0,
});

const input = (overrides: Partial<SafetyPlannerInput> = {}): SafetyPlannerInput => ({
  verdicts: [],
  mandatoryEvidenceShots: new Set<number>(),
  invalidEvidenceShots: new Set<number>(),
  invalidAlignment: false,
  ...overrides,
});

describe("applySafetyPlanner", () => {
  it("replaces only a mandatory failing shot and reports coverage telemetry", () => {
    const original = plan([shot(0, 1), shot(1, 2)]);
    const result = applySafetyPlanner(
      original,
      input({
        verdicts: [verdict(0, "pass", 1), verdict(1, "fail", 0.5)],
        mandatoryEvidenceShots: new Set([0, 1]),
      })
    );

    expect(result.plan).toEqual({
      ...original,
      version: 4,
      shots: [original.shots[0], safe(1, 2, "coverage")],
    });
    expect(result.telemetry).toEqual({
      mode: "active",
      evaluatedShots: 2,
      safeFitShots: 1,
      coverageFallbacks: 1,
      invalidEvidenceFallbacks: 0,
      minimumCoverage: 0.5,
    });
  });

  it("leaves a faceless shot unchanged when no mandatory evidence exists", () => {
    const original = plan([shot(0, 1)]);
    const result = applySafetyPlanner(
      original,
      input({ verdicts: [verdict(0, "not_evaluable", null, 0)] })
    );

    expect(result.plan).toBe(original);
    expect(result.telemetry.safeFitShots).toBe(0);
    expect(result.telemetry.evaluatedShots).toBe(0);
  });

  it("uses invalid evidence before coverage and fails closed for a missing verdict", () => {
    const original = plan([shot(0, 1), shot(1, 2), shot(2, 3)]);
    const originalSnapshot = structuredClone(original);
    const result = applySafetyPlanner(
      original,
      input({
        verdicts: [verdict(0, "fail", 0.2)],
        mandatoryEvidenceShots: new Set([0, 1]),
        invalidEvidenceShots: new Set([0]),
      })
    );

    expect(result.plan.shots).toEqual([
      safe(0, 2, "invalid_evidence"),
      original.shots[2],
    ]);
    expect(result.telemetry).toMatchObject({
      safeFitShots: 2,
      coverageFallbacks: 0,
      invalidEvidenceFallbacks: 2,
    });
    expect(original).toEqual(originalSnapshot);
  });

  it("converts every current plan shot on invalid alignment", () => {
    const original = plan([shot(0, 1), shot(1, 2), safe(2, 3, "coverage")]);
    const originalSnapshot = structuredClone(original);
    const result = applySafetyPlanner(
      original,
      input({ invalidAlignment: true })
    );

    expect(result.plan.shots).toEqual([
      safe(0, 2, "invalid_evidence"),
      safe(2, 3, "coverage"),
    ]);
    expect(result.telemetry).toMatchObject({
      safeFitShots: 2,
      invalidEvidenceFallbacks: 2,
      coverageFallbacks: 0,
    });
    expect(original).toEqual(originalSnapshot);
  });

  it("merges adjacent safe-fit shots only when spans touch and reasons match", () => {
    const original = plan([
      shot(0, 1),
      shot(1, 2),
      safe(2, 3, "coverage"),
      shot(3.1, 4),
      shot(4, 5),
    ]);
    const result = applySafetyPlanner(
      original,
      input({
        verdicts: [verdict(0, "fail", 0), verdict(1, "fail", 0), verdict(4, "fail", 0)],
        mandatoryEvidenceShots: new Set([0, 1, 4]),
      })
    );

    expect(result.plan.shots).toEqual([
      safe(0, 3, "coverage"),
      shot(3.1, 4),
      safe(4, 5, "coverage"),
    ]);
    expect(result.telemetry.safeFitShots).toBe(3);
  });

  it("preserves references and input objects when no replacement is needed", () => {
    const originalShots = [safe(0, 1, "coverage"), safe(1, 2, "coverage")];
    const original = plan(originalShots, 4);
    const result = applySafetyPlanner(
      original,
      input({
        verdicts: [verdict(0, "pass", 1)],
        mandatoryEvidenceShots: new Set([0]),
      })
    );

    expect(result.plan).toBe(original);
    expect(result.plan.version).toBe(4);
    expect(result.plan.shots).toBe(originalShots);
    expect(result.plan.shots).toHaveLength(2);
    expect(result.plan.shots[0]).toBe(originalShots[0]);
  });

  it("counts only unique valid in-plan evaluated verdict indexes", () => {
    const result = applySafetyPlanner(
      plan([shot(0, 1)]),
      input({
        verdicts: [
          verdict(0, "pass", 1),
          verdict(0, "fail", 0.2),
          verdict(-1, "pass", 1),
          verdict(99, "pass", 1),
        ],
      })
    );

    expect(result.telemetry.evaluatedShots).toBe(1);
  });

  it("ignores out-of-range evidence indexes and is idempotent", () => {
    const original = plan([shot(0, 1), shot(1, 2)]);
    const policy = input({
      verdicts: [verdict(0, "fail", 0.4)],
      mandatoryEvidenceShots: new Set([-1, 0, 99]),
      invalidEvidenceShots: new Set([-2, 99]),
    });
    const first = applySafetyPlanner(original, policy);
    const second = applySafetyPlanner(first.plan, policy);

    expect(first.plan.shots).toEqual([safe(0, 1, "coverage"), original.shots[1]]);
    expect(second.plan).toBe(first.plan);
    expect(second.plan).toEqual(first.plan);
  });

  it("takes the minimum finite coverage from mandatory verdicts only", () => {
    const result = applySafetyPlanner(
      plan([shot(0, 1), shot(1, 2), shot(2, 3)]),
      input({
        verdicts: [
          verdict(0, "pass", 0.8),
          verdict(1, "pass", null),
          verdict(2, "pass", 0.2),
        ],
        mandatoryEvidenceShots: new Set([0, 1]),
      })
    );

    expect(result.telemetry.minimumCoverage).toBe(0.8);
  });
});
