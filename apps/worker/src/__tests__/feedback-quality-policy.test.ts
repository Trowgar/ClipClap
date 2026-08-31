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
    focalFailures: 0,
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

  it("rejects a positive baseline boundary failure even when the candidate repairs it", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, subsystem: "boundary" as const, metrics: { ...entry.metrics, boundaryErrors: 1 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, boundaryErrors: 0 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, policy)).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("counts a lower confirmed-negative boundary error as measurable improvement", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "negative-0"
          ? { ...entry, metrics: { ...entry.metrics, boundaryErrors: 1 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "negative-0"
          ? { ...entry, metrics: { ...entry.metrics, boundaryErrors: 0 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, policy)).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  const laneMetrics: Record<QualityCaseResult["subsystem"], QualityMetrics> = {
    selection: { approvedMomentRetained: 1, approvedWindowOverlap: 1, emptyResult: 0, zeroClipFalseNegative: 0 },
    boundary: { approvedMomentRetained: 1, approvedWindowOverlap: 1, boundaryErrors: 0 },
    framing: { approvedMomentRetained: 1, approvedWindowOverlap: 1, focalFailures: 0, requiredTextClipped: 0, requiredSubjectClipped: 0 },
    subtitles: { approvedMomentRetained: 1, approvedWindowOverlap: 1, subtitleOverlap: 0 },
    render: { approvedMomentRetained: 1, approvedWindowOverlap: 1, hardInvariantFailures: 0, outputWidth: 1080, outputHeight: 1920, sar: 1, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0 },
  };

  const laneObservation = (subsystem: QualityCaseResult["subsystem"], omit?: keyof QualityMetrics): QualityObservation => {
    const positiveMetrics = { ...laneMetrics[subsystem] };
    if (omit !== undefined) delete positiveMetrics[omit];
    return observation({
      cases: [
        ...Array.from({ length: 4 }, (_, i) => result(`positive-${i}`, "positive", subsystem, { metrics: positiveMetrics })),
        ...Array.from({ length: 6 }, (_, i) => result(`negative-${i}`, "confirmed_negative", "selection", { metrics: { defectSeverity: 2 } })),
      ],
    });
  };

  it.each(Object.keys(laneMetrics) as QualityCaseResult["subsystem"][]) ("accepts the minimal %s lane evidence", (subsystem) => {
    const baseline = laneObservation(subsystem);
    const candidate = { ...baseline, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  it.each([
    ["selection", "emptyResult"],
    ["boundary", "boundaryErrors"],
    ["framing", "focalFailures"],
    ["subtitles", "subtitleOverlap"],
    ["render", "outputWidth"],
    ["render", "outputHeight"],
    ["render", "sar"],
    ["render", "hardInvariantFailures"],
    ["render", "blackTailSeconds"],
    ["render", "frozenTailSeconds"],
    ["render", "subtitleOverlap"],
    ["render", "requiredTextClipped"],
    ["render", "requiredSubjectClipped"],
    ["render", "focalFailures"],
  ] as const)("rejects a %s lane case missing its relevant metric", (subsystem, metric) => {
    const baseline = laneObservation(subsystem, metric);
    const candidate = { ...baseline, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
  });

  it("rejects a matched case when candidate metric keys remove baseline focal evidence", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, focalFailures: 1 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) => {
        if (entry.caseVersion !== "positive-0") return entry;
        const { focalFailures: _removed, ...metrics } = entry.metrics;
        return { ...entry, metrics };
      }),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["invalid_metric"],
    });
  });

  it("ignores excluded cases in comparison and improvement claims", () => {
    const excluded = result("excluded", "exclude", "selection", {
      metrics: { approvedMomentRetained: 0, emptyResult: 100 },
    });
    const baseline = observation({ cases: [...observation().cases, excluded] });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: [
        ...observation().cases,
        { ...excluded, metrics: { approvedMomentRetained: 1, emptyResult: 0 } },
        result("new-excluded", "exclude", "render", { metrics: { outputWidth: 1 } }),
      ],
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
    expect(compareObservations(baseline, candidate, policy)).toMatchObject({
      verdict: "fail",
      reasons: ["no_improvement"],
    });
  });

  it("ignores stale excluded cases after validating their schema and metrics", () => {
    const excluded = result("excluded-stale", "exclude", "selection", { status: "stale" });
    const baseline = observation({ cases: [...observation().cases, excluded] });
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "pass",
      reasons: [],
    });
  });

  it("rejects conflicting aliases instead of silently choosing one", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, zeroClipFalseNegatives: 0 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, zeroClipFalseNegatives: 1 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
  });

  it("fails an absolute candidate hard invariant even when baseline is already bad", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, emptyResult: 1 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases,
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("fails instead of passing when the baseline itself has a hard invariant violation", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, emptyResult: 1 } }
          : entry,
      ),
    });
    const candidate = observation({
      mode: "candidate",
      observationId: "sha256:" + "4".repeat(64),
      cases: baseline.cases.map((entry) =>
        entry.caseVersion === "positive-0"
          ? { ...entry, metrics: { ...entry.metrics, emptyResult: 0 } }
          : entry,
      ),
    });

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("requires canonical timestamps and a non-empty policy version", () => {
    const baseline = observation({ createdAt: "2026-08-31T00:00:00Z" });
    const candidate = observation({ mode: "candidate", observationId: "sha256:" + "4".repeat(64) });
    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_schema",
    ]);
    expect(compareObservations(observation(), candidate, { ...policy, policyVersion: "", claim: "non_regression_only" }).reasons).toEqual([
      "invalid_schema",
    ]);
  });

  it("rejects alias-only metrics under the canonical evidence schema", () => {
    const baseline = observation({
      cases: observation().cases.map((entry) => {
        if (entry.caseVersion !== "positive-0") return entry;
        const { emptyResult: _canonical, ...metrics } = entry.metrics;
        return { ...entry, metrics: { ...metrics, empty: 0 } };
      }),
    });
    const candidate = { ...baseline, mode: "candidate" as const, observationId: "sha256:" + "4".repeat(64) };

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_metric",
    ]);
  });

  it("applies absolute render invariants to confirmed-negative render cases", () => {
    const renderNegative = {
      ...result("negative-0", "confirmed_negative", "render"),
      metrics: {
        defectSeverity: 2,
        hardInvariantFailures: 0,
        outputWidth: 1080,
        outputHeight: 1920,
        sar: 1,
        blackTailSeconds: 1,
        frozenTailSeconds: 0,
        subtitleOverlap: 0,
        requiredTextClipped: 0,
        requiredSubjectClipped: 0,
        focalFailures: 0,
      },
    };
    const baseline = observation({
      cases: observation().cases.map((entry) => (entry.caseVersion === "negative-0" ? renderNegative : entry)),
    });
    const candidate = {
      ...baseline,
      mode: "candidate" as const,
      observationId: "sha256:" + "4".repeat(64),
    };

    expect(compareObservations(baseline, candidate, { ...policy, claim: "non_regression_only" })).toMatchObject({
      verdict: "fail",
      reasons: ["hard_invariant_regression"],
    });
  });

  it("rejects an enumerable array index outside the canonical case range", () => {
    const cases = [...observation().cases] as QualityCaseResult[] & Record<string, unknown>;
    cases["4294967295"] = result("out-of-range", "exclude", "selection");
    const malformed = observation({ cases });

    expect(compareObservations(malformed, malformed, { ...policy, claim: "non_regression_only" }).reasons).toEqual([
      "invalid_schema",
    ]);
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
