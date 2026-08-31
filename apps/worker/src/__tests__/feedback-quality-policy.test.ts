import { describe, expect, it } from "vitest";

import {
  compareObservations,
  type GatePolicy,
} from "../feedback-quality/policy";
import type {
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
});
