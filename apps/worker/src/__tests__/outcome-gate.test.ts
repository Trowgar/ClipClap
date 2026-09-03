import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { decideOutcomeRecoveryGate, outcomeDecisionReport, type OutcomeGateDependencies } from "../feedback-quality/outcome-gate";
import type { OutcomeObservation, OutcomeObservationResult } from "../feedback-quality/outcome-observe";
import type { OutcomeLabel } from "../feedback-quality/outcome-types";
import type { GateDecision } from "../feedback-quality/gate";

const hash = (seed: string) => sha256(seed);
const commit = "a".repeat(40);
const now = new Date("2026-09-02T12:00:00.000Z");

function result(index: number, disposition: "recoverable_false_negative" | "valid_empty", recovered = false): OutcomeObservationResult {
  return { caseVersion: hash(`case-${index}`), disposition, shippedWindows: recovered ? [{ start: 1, end: 2 }] : [], approvedHits: recovered ? 1 : 0,
    forbiddenHits: 0, keepFalseShipped: 0, explicitGateResurrections: 0, candidateCap: 6, criticBatches: recovered ? 1 : 0, noClipsReason: recovered ? null : "NO_VIABLE_MOMENTS" };
}

function observation(mode: "baseline" | "candidate", results: readonly OutcomeObservationResult[]): OutcomeObservation {
  const body = { schemaVersion: 1 as const, mode, commitSha: commit, engineFingerprint: hash(mode === "baseline" ? "off" : "on"), corpusDigest: hash("corpus"), runnerVersion: "outcome-observe-v1" as const, recordedResponsesDigest: hash("responses"), results };
  return { ...body, observationId: sha256(canonicalJson(body)) };
}

function fixture() {
  const baselineResults = [...Array.from({ length: 4 }, (_, i) => result(i, "recoverable_false_negative")), ...Array.from({ length: 4 }, (_, i) => result(i + 4, "valid_empty"))];
  const candidateResults = baselineResults.map((entry, index) => index < 2 ? result(index, "recoverable_false_negative", true) : entry);
  const baseline = observation("baseline", baselineResults); const candidate = observation("candidate", candidateResults);
  const labels = baselineResults.map((entry, index) => ({ schemaVersion: 1, action: "label", eventId: `event-${index}`, occurredAt: "2026-09-02T10:00:00.000Z", caseVersion: entry.caseVersion, disposition: entry.disposition, confidence: "high", set: index === 0 || index === 4 ? "holdout" : "eval", expected: { approvedWindows: entry.disposition === "recoverable_false_negative" ? [{ start: 1, end: 2 }] : [], forbiddenWindows: [] } })) as OutcomeLabel[];
  const clipDecision = { decisionId: `decision:${hash("clip")}`, candidateCommitSha: commit, configSha256: hash("config"), verdict: "pass", createdAt: "2026-09-02T10:00:00.000Z", expiresAt: "2026-09-03T10:00:00.000Z" } as GateDecision;
  return { baseline, candidate, labels, clipDecision };
}

function dependencies(overrides: Partial<OutcomeGateDependencies> = {}): OutcomeGateDependencies {
  const value = fixture();
  return {
    now: () => now,
    loadObservation: vi.fn(async (id) => ({ observation: id === value.baseline.observationId ? value.baseline : value.candidate, observedAt: new Date("2026-09-02T11:00:00.000Z") })),
    loadLabels: vi.fn(async () => value.labels),
    loadClipDecision: vi.fn(async () => value.clipDecision),
    loadClipEvidence: vi.fn(async () => ({ positiveCases: 5, confirmedNegativeCases: 8, selectionNegativeCases: 3, positiveLosses: 0, confirmedNegativeWorsening: 0 })),
    publishDecision: vi.fn(async () => ({ status: "committed" as const })),
    ...overrides,
  };
}

describe("composite outcome recovery gate", () => {
  it("publishes a content-addressed 24-hour aggregate-only pass", async () => {
    const value = fixture(); const publishDecision = vi.fn(async () => ({ status: "committed" as const }));
    const decision = await decideOutcomeRecoveryGate({ baselineObservationId: value.baseline.observationId, candidateObservationId: value.candidate.observationId, clipDecisionId: value.clipDecision.decisionId, expectedCandidateEngineFingerprint: hash("on"), customerOutputsMatch: true }, dependencies({ publishDecision }));
    expect(decision).toMatchObject({ verdict: "pass", clipDecisionId: value.clipDecision.decisionId, candidateCommitSha: commit, configSha256: hash("config"), metrics: { recoverableCases: 4, validEmptyCases: 4, recoveredCases: 2 } });
    expect(decision.decisionId).toBe(`outcome-decision:${sha256(canonicalJson(Object.fromEntries(Object.entries(decision).filter(([key]) => key !== "decisionId"))))}`);
    expect(new Date(decision.expiresAt).getTime() - new Date(decision.createdAt).getTime()).toBe(24 * 60 * 60 * 1000);
    const report = (publishDecision.mock.calls as unknown as Array<[unknown, string, string]>)[0][1];
    expect(report).toBe(outcomeDecisionReport(decision));
    for (const label of value.labels) expect(report).not.toContain(label.caseVersion);
  });

  it("fails closed when observations are stale or do not bind the clip commit", async () => {
    const value = fixture();
    const stale = await decideOutcomeRecoveryGate({ baselineObservationId: value.baseline.observationId, candidateObservationId: value.candidate.observationId, clipDecisionId: value.clipDecision.decisionId, expectedCandidateEngineFingerprint: hash("on"), customerOutputsMatch: true }, dependencies({ loadObservation: async (id) => ({ observation: id === value.baseline.observationId ? value.baseline : value.candidate, observedAt: new Date("2026-09-01T11:59:59.999Z") }) }));
    expect(stale.reasons).toContain("stale_input");
    const wrongClip = { ...value.clipDecision, candidateCommitSha: "b".repeat(40) };
    const mismatched = await decideOutcomeRecoveryGate({ baselineObservationId: value.baseline.observationId, candidateObservationId: value.candidate.observationId, clipDecisionId: value.clipDecision.decisionId, expectedCandidateEngineFingerprint: hash("on"), customerOutputsMatch: true }, dependencies({ loadClipDecision: async () => wrongClip }));
    expect(mismatched.reasons).toContain("fingerprint_mismatch");
  });

  it("does not let a render-only confirmed-negative population authorize V4", async () => {
    const value = fixture();
    const decision = await decideOutcomeRecoveryGate({ baselineObservationId: value.baseline.observationId, candidateObservationId: value.candidate.observationId, clipDecisionId: value.clipDecision.decisionId, expectedCandidateEngineFingerprint: hash("on"), customerOutputsMatch: true }, dependencies({ loadClipEvidence: async () => ({ positiveCases: 5, confirmedNegativeCases: 8, selectionNegativeCases: 0, positiveLosses: 0, confirmedNegativeWorsening: 0 }) }));
    expect(decision.reasons).toContain("insufficient_selection_negatives");
  });
});
