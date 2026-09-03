import { describe, expect, it } from "vitest";

import { decideOutcomeGate, type OutcomePolicyInput } from "../feedback-quality/outcome-policy";
import type { OutcomeObservation, OutcomeObservationResult } from "../feedback-quality/outcome-observe";
import { sha256 } from "../feedback-learning/canonical";

const commit = "a".repeat(40);
const hash = (seed: string) => sha256(seed);

function result(index: number, disposition: "recoverable_false_negative" | "valid_empty", recovered = false): OutcomeObservationResult {
  return {
    caseVersion: hash(`case-${index}`), disposition,
    shippedWindows: recovered ? [{ start: 10, end: 20 }] : [], approvedHits: recovered ? 1 : 0,
    forbiddenHits: 0, keepFalseShipped: 0, explicitGateResurrections: 0,
    candidateCap: 6, criticBatches: recovered ? 1 : 0, noClipsReason: recovered ? null : "NO_VIABLE_MOMENTS",
  };
}

function observation(mode: "baseline" | "candidate", results: readonly OutcomeObservationResult[]): OutcomeObservation {
  return {
    schemaVersion: 1, observationId: hash(`${mode}-${JSON.stringify(results)}`), mode, commitSha: commit,
    engineFingerprint: hash(mode === "baseline" ? "engine-off" : "engine-on"), corpusDigest: hash("corpus"),
    runnerVersion: "outcome-observe-v1", recordedResponsesDigest: hash("responses"), results,
  };
}

function passing(): OutcomePolicyInput {
  const baselineResults = [...Array.from({ length: 4 }, (_, index) => result(index, "recoverable_false_negative")), ...Array.from({ length: 4 }, (_, index) => result(index + 4, "valid_empty"))];
  const candidateResults = baselineResults.map((entry, index) => index < 2 ? result(index, "recoverable_false_negative", true) : entry);
  return {
    baseline: observation("baseline", baselineResults), candidate: observation("candidate", candidateResults),
    cases: baselineResults.map((entry, index) => ({ caseVersion: entry.caseVersion, disposition: entry.disposition, set: index === 0 || index === 4 ? "holdout" : "eval" })),
    expectedCandidateEngineFingerprint: hash("engine-on"), customerOutputsMatch: true,
    clip: { verdict: "pass", positiveCases: 5, confirmedNegativeCases: 8, selectionNegativeCases: 3, positiveLosses: 0, confirmedNegativeWorsening: 0 },
  };
}

describe("outcome recovery policy", () => {
  it("passes the exact minimum safe composite evidence", () => {
    expect(decideOutcomeGate(passing())).toMatchObject({ verdict: "pass", reasons: [], metrics: { recoverableCases: 4, validEmptyCases: 4, recoveredCases: 2, keepFalseShipped: 0, explicitGateResurrections: 0, validEmptyFalsePositives: 0 } });
  });

  const cases: Array<[string, (input: OutcomePolicyInput) => OutcomePolicyInput]> = [
    ["insufficient_recoverable_cases", (input) => ({ ...input, cases: input.cases.filter((item, index) => item.disposition !== "recoverable_false_negative" || index !== 1), baseline: observation("baseline", input.baseline.results.filter((_, index) => index !== 1)), candidate: observation("candidate", input.candidate.results.filter((_, index) => index !== 1)) })],
    ["insufficient_valid_empty_cases", (input) => ({ ...input, cases: input.cases.filter((_, index) => index !== 5), baseline: observation("baseline", input.baseline.results.filter((_, index) => index !== 5)), candidate: observation("candidate", input.candidate.results.filter((_, index) => index !== 5)) })],
    ["missing_recoverable_holdout", (input) => ({ ...input, cases: input.cases.map((item) => item.disposition === "recoverable_false_negative" ? { ...item, set: "eval" as const } : item) })],
    ["missing_valid_empty_holdout", (input) => ({ ...input, cases: input.cases.map((item) => item.disposition === "valid_empty" ? { ...item, set: "eval" as const } : item) })],
    ["insufficient_recoveries", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 1 ? result(1, "recoverable_false_negative") : item)) })],
    ["insufficient_recovery_rate", (input) => { const extra = Array.from({ length: 3 }, (_, offset) => result(8 + offset, "recoverable_false_negative")); return { ...input, baseline: observation("baseline", [...input.baseline.results, ...extra]), candidate: observation("candidate", [...input.candidate.results, ...extra]), cases: [...input.cases, ...extra.map((item) => ({ caseVersion: item.caseVersion, disposition: item.disposition, set: "eval" as const }))] }; }],
    ["valid_empty_false_positive", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 4 ? { ...item, shippedWindows: [{ start: 1, end: 2 }] } : item)) })],
    ["positive_loss", (input) => ({ ...input, clip: { ...input.clip, positiveLosses: 1 } })],
    ["confirmed_negative_worsening", (input) => ({ ...input, clip: { ...input.clip, confirmedNegativeWorsening: 1 } })],
    ["keep_false_shipped", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 0 ? { ...item, keepFalseShipped: 1 } : item)) })],
    ["explicit_gate_resurrection", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 0 ? { ...item, explicitGateResurrections: 1 } : item)) })],
    ["candidate_cap_exceeded", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 0 ? { ...item, candidateCap: 7 } : item)) })],
    ["critic_batch_exceeded", (input) => ({ ...input, candidate: observation("candidate", input.candidate.results.map((item, index) => index === 0 ? { ...item, criticBatches: 2 } : item)) })],
    ["off_shadow_mismatch", (input) => ({ ...input, customerOutputsMatch: false })],
    ["clip_gate_not_pass", (input) => ({ ...input, clip: { ...input.clip, verdict: "fail" } })],
    ["insufficient_clip_positives", (input) => ({ ...input, clip: { ...input.clip, positiveCases: 4 } })],
    ["insufficient_clip_negatives", (input) => ({ ...input, clip: { ...input.clip, confirmedNegativeCases: 7 } })],
    ["insufficient_selection_negatives", (input) => ({ ...input, clip: { ...input.clip, selectionNegativeCases: 2 } })],
  ];

  it.each(cases)("fails with %s", (reason, mutate) => {
    expect(decideOutcomeGate(mutate(passing())).reasons).toContain(reason);
  });

  it("fails closed on missing, stale, and fingerprint-drifted inputs", () => {
    expect(decideOutcomeGate({ ...passing(), inputsPresent: false }).reasons).toContain("missing_input");
    expect(decideOutcomeGate({ ...passing(), inputsFresh: false }).reasons).toContain("stale_input");
    expect(decideOutcomeGate({ ...passing(), expectedCandidateEngineFingerprint: hash("wrong") }).reasons).toContain("fingerprint_mismatch");
  });
});
