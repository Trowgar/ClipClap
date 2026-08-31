import { describe, expect, it } from "vitest";

import {
  compareObservations,
  type GatePolicy,
} from "../feedback-quality/policy";
import type {
  QualityMetrics,
  QualityCaseResult,
  QualityObservation,
} from "../feedback-quality/types";

const policy: GatePolicy = {
  schemaVersion: 1,
  policyVersion: "v2",
  claim: "improvement",
  minimum: {
    evalPositive: 4,
    evalNegative: 6,
    holdoutPositive: 1,
    holdoutNegative: 2,
  },
};

const result = (
  caseVersion: string,
  disposition: QualityCaseResult["disposition"],
  subsystem: QualityCaseResult["subsystem"],
  overrides: Partial<QualityCaseResult> = {},
): QualityCaseResult => ({
  schemaVersion: 1,
  caseVersion,
  disposition,
  subsystem,
  status: "ok",
  metrics: {
    approvedMomentRetained: 1,
    approvedWindowOverlap: 1,
    emptyResult: 0,
    zeroClipFalseNegative: 0,
    boundaryErrors: 0,
    blackTailSeconds: 0,
    frozenTailSeconds: 0,
    subtitleOverlap: 0,
    requiredTextClipped: 0,
    requiredSubjectClipped: 0,
    outputWidth: 1080,
    outputHeight: 1920,
    sar: 1,
    hardInvariantFailures: 0,
    defectSeverity: disposition === "confirmed_negative" ? 2 : 0,
    ...overrides.metrics,
  },
  ...overrides,
});

const observation = (
  overrides: Partial<QualityObservation> = {},
): QualityObservation => ({
  schemaVersion: 1,
  observationId: "sha256:" + "1".repeat(64),
  mode: "baseline",
  set: "eval",
  commitSha: "a".repeat(40),
  configSha256: "sha256:" + "2".repeat(64),
  corpusSha256: "sha256:" + "3".repeat(64),
  runnerVersion: 1,
  createdAt: "2026-08-31T00:00:00.000Z",
  cases: [
    ...Array.from({ length: 4 }, (_, i) => result(`positive-${i}`, "positive", "selection")),
    ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection")),
  ],
  ...overrides,
});

describe("feedback quality comparison policy", () => {
  it("fails a corpus below the per-set minimum", () => {
    const baseline = observation({ cases: [] });
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64), cases: [] });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["insufficient_corpus"],
    });
  });

  it("passes identical baseline and candidate observations from one commit", () => {
    const baseline = observation();
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  it("fails when a positive case disappears", () => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.filter((entry) => entry.caseVersion !== "positive-0"),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["positive_regression"],
    });
  });

  it("fails when a confirmed negative worsens in its labelled subsystem", () => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "negative-0"
          ? { ...entry, metrics: { ...entry.metrics, defectSeverity: 3 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["negative_regression"],
    });
  });

  it("fails a hard render invariant even when aggregate metrics are unchanged", () => {
    const baseline = observation({
      cases: [
        ...Array.from({ length: 4 }, (_, i) => result(`positive-${i}`, "positive", "render")),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "render")),
      ],
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, outputWidth: 720 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("does not compare eval observations with a holdout observation", () => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      set: "holdout",
      observationId: "sha256:" + "4".repeat(64),
    });

    expect(compareObservations(baseline, candidate, policy)).toMatchObject({
      verdict: "fail",
      reasons: ["set_mismatch"],
    });
  });

  it("allows an unchanged quality result under non_regression_only without an improvement", () => {
    const baseline = observation();
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  it("fails stale cases before looking at their metrics", () => {
    const baseline = observation({
      cases: [
        result("positive-0", "positive", "selection", { status: "stale" }),
        ...Array.from({ length: 3 }, (_, i) => result(`positive-${i + 1}`, "positive", "selection")),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection")),
      ],
    });
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["stale_case"],
    });
  });

  it("rejects duplicate case versions and non-finite metrics", () => {
    const duplicate = observation({
      cases: [
        result("same", "positive", "selection"),
        result("same", "positive", "selection"),
      ],
    });
    const malformed = observation({
      cases: [result("positive-0", "positive", "selection", { metrics: { approvedMomentRetained: Number.NaN } })],
    });

    expect(compareObservations(duplicate, duplicate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "duplicate_case_version",
    ]);
    expect(compareObservations(malformed, malformed, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
  });

  it("requires measurable improvement when the claim is improvement", () => {
    const baseline = observation();
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(baseline, candidate, policy)).toMatchObject({
      verdict: "fail",
      reasons: ["no_improvement"],
    });
  });

  it("passes equivalent observations from different valid commits", () => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      commitSha: "b".repeat(40),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  it("rejects a commit identifier that is not a lowercase SHA-1", () => {
    const malformed = observation({ commitSha: "not-a-commit-sha" });
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(malformed, candidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_schema",
    ]);
  });

  it.each([
    ["approved moment", { approvedMomentRetained: 0 }],
    ["approved window", { approvedWindowOverlap: 0 }],
    ["hard invariant counter", { hardInvariantFailures: 1 }],
    ["emptyResult", { emptyResult: 1 }],
    ["zeroClipFalseNegative", { zeroClipFalseNegative: 1 }],
    ["boundaryErrors", { boundaryErrors: 1 }],
    ["black tail", { blackTailSeconds: 0.1 }],
    ["frozen tail", { frozenTailSeconds: 0.1 }],
    ["subtitle overlap", { subtitleOverlap: 1 }],
    ["required text clipping", { requiredTextClipped: 1 }],
    ["required subject clipping", { requiredSubjectClipped: 1 }],
  ] as const)("fails a positive hard invariant when %s appears", (_name, changed) => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, ...changed } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("does not let supplied aggregate metrics hide a case-level negative metric regression", () => {
    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      metrics: { boundaryErrors: 0 },
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "negative-0"
          ? { ...entry, metrics: { ...entry.metrics, boundaryErrors: 1 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["aggregate_regression"],
    });
  });

  it("keeps QualityMetrics closed at compile time", () => {
    // @ts-expect-error unknown metrics are not part of the closed contract
    const invalid: QualityMetrics = { madeUpMetric: 1 };
    expect(invalid).toEqual({ madeUpMetric: 1 });
  });

  it("requires positive evidence metrics and confirmed-negative severity", () => {
    const missingPositiveProof = observation({
      cases: [
        result("positive-0", "positive", "selection", { metrics: {} }),
        ...Array.from({ length: 3 }, (_, i) => result(`positive-${i + 1}`, "positive", "selection")),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection")),
      ],
    });
    const missingNegativeProof = observation({
      cases: [
        ...Array.from({ length: 4 }, (_, i) => result(`positive-${i}`, "positive", "selection")),
        result("negative-0", "confirmed_negative", "selection", { metrics: {} }),
        ...Array.from({ length: 5 }, (_, i) => result(`negative-${i + 1}`, "confirmed_negative", "selection")),
      ],
    });

    const candidateForPositive = { ...missingPositiveProof, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };
    const candidateForNegative = { ...missingNegativeProof, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };
    expect(compareObservations(missingPositiveProof, candidateForPositive, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
    expect(compareObservations(missingNegativeProof, candidateForNegative, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
  });

  it("rejects non-enumerable and accessor evidence without invoking getters", () => {
    let reads = 0;
    const throwingMetrics = { ...result("seed", "positive", "selection").metrics } as Record<string, unknown>;
    Object.defineProperty(throwingMetrics, "poison", {
      enumerable: false,
      get: () => {
        reads += 1;
        throw new Error("getter invoked");
      },
    });
    const accessorObservation = observation({
      cases: [
        result("positive-0", "positive", "selection", { metrics: throwingMetrics as never }),
        ...Array.from({ length: 3 }, (_, i) => result(`positive-${i + 1}`, "positive", "selection")),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection")),
      ],
    });

    expect(["invalid_schema", "invalid_metric"]).toContain(
      compareObservations(accessorObservation, accessorObservation, { ...policy, claim: "non_regression_only" }).reasons[0],
    );
    expect(reads).toBe(0);

    let topReads = 0;
    const topLevel = observation();
    Object.defineProperty(topLevel, "metrics", {
      enumerable: false,
      get: () => {
        topReads += 1;
        throw new Error("getter invoked");
      },
    });
    expect(compareObservations(topLevel, topLevel, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_schema",
    ]);
    expect(topReads).toBe(0);
  });

  it("requires render positives to prove geometry and SAR", () => {
    const incomplete = observation({
      cases: [
        result("positive-0", "positive", "render", { metrics: {
          approvedMomentRetained: 1,
          approvedWindowOverlap: 1,
          hardInvariantFailures: 0,
          emptyResult: 0,
          zeroClipFalseNegative: 0,
          boundaryErrors: 0,
          blackTailSeconds: 0,
          frozenTailSeconds: 0,
          subtitleOverlap: 0,
          requiredTextClipped: 0,
          requiredSubjectClipped: 0,
        } }),
        ...Array.from({ length: 3 }, (_, i) => result(`positive-${i + 1}`, "positive", "selection")),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection")),
      ],
    });
    const incompleteCandidate = { ...incomplete, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };
    expect(compareObservations(incomplete, incompleteCandidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);

    const baseline = observation();
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, subsystem: "render" as const, metrics: { ...entry.metrics, outputWidth: 720 } }
          : entry,
      ),
    });
    const renderBaseline = { ...baseline, cases: baseline.cases.map((entry) => entry.caseVersion === "positive-0" ? { ...entry, subsystem: "render" as const } : entry) };
    expect(compareObservations(renderBaseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });
});
