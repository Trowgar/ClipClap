import type { OutcomeObservation } from "./outcome-observe";
import type { OutcomeDisposition, OutcomeSet } from "./outcome-types";

export const OUTCOME_POLICY_VERSION = "outcome-recovery-gate-v1" as const;

export const OUTCOME_REASON_ORDER = [
  "invalid_input", "missing_input", "stale_input", "fingerprint_mismatch", "observation_mismatch",
  "insufficient_recoverable_cases", "insufficient_valid_empty_cases", "missing_recoverable_holdout", "missing_valid_empty_holdout",
  "insufficient_recoveries", "insufficient_recovery_rate", "valid_empty_false_positive", "positive_loss",
  "confirmed_negative_worsening", "keep_false_shipped", "explicit_gate_resurrection", "candidate_cap_exceeded",
  "critic_batch_exceeded", "off_shadow_mismatch", "clip_gate_not_pass", "insufficient_clip_positives",
  "insufficient_clip_negatives", "insufficient_selection_negatives",
] as const;

export type OutcomeGateReason = (typeof OUTCOME_REASON_ORDER)[number];

export type OutcomeCaseBinding = Readonly<{
  caseVersion: string;
  disposition: Exclude<OutcomeDisposition, "exclude">;
  set: OutcomeSet;
}>;

export type ClipGateEvidence = Readonly<{
  verdict: "pass" | "fail";
  positiveCases: number;
  confirmedNegativeCases: number;
  selectionNegativeCases: number;
  positiveLosses: number;
  confirmedNegativeWorsening: number;
}>;

export type OutcomePolicyInput = Readonly<{
  baseline: OutcomeObservation;
  candidate: OutcomeObservation;
  cases: readonly OutcomeCaseBinding[];
  expectedCandidateEngineFingerprint: string;
  customerOutputsMatch: boolean;
  clip: ClipGateEvidence;
  inputsPresent?: boolean;
  inputsFresh?: boolean;
}>;

export type OutcomeGateMetrics = Readonly<{
  recoverableCases: number;
  validEmptyCases: number;
  recoverableHoldoutCases: number;
  validEmptyHoldoutCases: number;
  recoveredCases: number;
  recoveryRateBps: number;
  validEmptyFalsePositives: number;
  positiveLosses: number;
  confirmedNegativeWorsening: number;
  keepFalseShipped: number;
  explicitGateResurrections: number;
  maximumCandidateCap: number;
  maximumCriticBatches: number;
  clipPositiveCases: number;
  clipConfirmedNegativeCases: number;
  clipSelectionNegativeCases: number;
}>;

export type OutcomePolicyDecision = Readonly<{
  verdict: "pass" | "fail";
  reasons: readonly OutcomeGateReason[];
  metrics: OutcomeGateMetrics;
}>;

const HASH = /^sha256:[0-9a-f]{64}$/;

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/** Pure fail-closed V4 policy. Persisted-input authenticity and freshness are
 * established by the gate reader and surfaced through the two closed flags. */
export function decideOutcomeGate(input: OutcomePolicyInput): OutcomePolicyDecision {
  const reasons = new Set<OutcomeGateReason>();
  if (!input || !Array.isArray(input.cases) || !input.baseline || !input.candidate || !input.clip) reasons.add("invalid_input");
  if (input.inputsPresent === false) reasons.add("missing_input");
  if (input.inputsFresh === false) reasons.add("stale_input");

  const baselineResults = Array.isArray(input?.baseline?.results) ? input.baseline.results : [];
  const candidateResults = Array.isArray(input?.candidate?.results) ? input.candidate.results : [];
  const bindings = Array.isArray(input?.cases) ? input.cases : [];
  const baselineByCase = new Map(baselineResults.map((entry) => [entry.caseVersion, entry]));
  const candidateByCase = new Map(candidateResults.map((entry) => [entry.caseVersion, entry]));
  const versions = bindings.map((entry) => entry.caseVersion);
  const exactPopulation = versions.length > 0 && new Set(versions).size === versions.length &&
    baselineByCase.size === versions.length && candidateByCase.size === versions.length &&
    versions.every((version) => baselineByCase.has(version) && candidateByCase.has(version));
  if (!exactPopulation || input.baseline.mode !== "baseline" || input.candidate.mode !== "candidate" ||
      input.baseline.commitSha !== input.candidate.commitSha || input.baseline.corpusDigest !== input.candidate.corpusDigest ||
      input.baseline.runnerVersion !== input.candidate.runnerVersion || input.baseline.recordedResponsesDigest !== input.candidate.recordedResponsesDigest) reasons.add("observation_mismatch");
  if (!HASH.test(input.expectedCandidateEngineFingerprint) || input.candidate.engineFingerprint !== input.expectedCandidateEngineFingerprint) reasons.add("fingerprint_mismatch");

  const recoverableCases = bindings.filter((entry) => entry.disposition === "recoverable_false_negative").length;
  const validEmptyCases = bindings.filter((entry) => entry.disposition === "valid_empty").length;
  const recoverableHoldoutCases = bindings.filter((entry) => entry.disposition === "recoverable_false_negative" && entry.set === "holdout").length;
  const validEmptyHoldoutCases = bindings.filter((entry) => entry.disposition === "valid_empty" && entry.set === "holdout").length;
  let recoveredCases = 0;
  let validEmptyFalsePositives = 0;
  let positiveLosses = safeCount(input.clip?.positiveLosses);
  let confirmedNegativeWorsening = safeCount(input.clip?.confirmedNegativeWorsening);
  let keepFalseShipped = 0;
  let explicitGateResurrections = 0;
  let maximumCandidateCap = 0;
  let maximumCriticBatches = 0;
  for (const binding of bindings) {
    const baseline = baselineByCase.get(binding.caseVersion);
    const candidate = candidateByCase.get(binding.caseVersion);
    if (!baseline || !candidate || baseline.disposition !== binding.disposition || candidate.disposition !== binding.disposition) continue;
    if (candidate.approvedHits > 0 && candidate.approvedHits > baseline.approvedHits) recoveredCases += 1;
    if (candidate.approvedHits < baseline.approvedHits) positiveLosses += 1;
    if (candidate.forbiddenHits > baseline.forbiddenHits) confirmedNegativeWorsening += 1;
    if (binding.disposition === "valid_empty" && candidate.shippedWindows.length > 0) validEmptyFalsePositives += 1;
    keepFalseShipped += safeCount(candidate.keepFalseShipped);
    explicitGateResurrections += safeCount(candidate.explicitGateResurrections);
    maximumCandidateCap = Math.max(maximumCandidateCap, safeCount(candidate.candidateCap));
    maximumCriticBatches = Math.max(maximumCriticBatches, safeCount(candidate.criticBatches));
  }
  const recoveryRateBps = recoverableCases === 0 ? 0 : Math.floor(recoveredCases * 10_000 / recoverableCases);
  const clipPositiveCases = safeCount(input.clip?.positiveCases);
  const clipConfirmedNegativeCases = safeCount(input.clip?.confirmedNegativeCases);
  const clipSelectionNegativeCases = safeCount(input.clip?.selectionNegativeCases);

  if (recoverableCases < 4) reasons.add("insufficient_recoverable_cases");
  if (validEmptyCases < 4) reasons.add("insufficient_valid_empty_cases");
  if (recoverableHoldoutCases < 1) reasons.add("missing_recoverable_holdout");
  if (validEmptyHoldoutCases < 1) reasons.add("missing_valid_empty_holdout");
  if (recoveredCases < 2) reasons.add("insufficient_recoveries");
  if (recoveryRateBps < 3_000) reasons.add("insufficient_recovery_rate");
  if (validEmptyFalsePositives > 0) reasons.add("valid_empty_false_positive");
  if (positiveLosses > 0) reasons.add("positive_loss");
  if (confirmedNegativeWorsening > 0) reasons.add("confirmed_negative_worsening");
  if (keepFalseShipped > 0) reasons.add("keep_false_shipped");
  if (explicitGateResurrections > 0) reasons.add("explicit_gate_resurrection");
  if (maximumCandidateCap > 6) reasons.add("candidate_cap_exceeded");
  if (maximumCriticBatches > 1) reasons.add("critic_batch_exceeded");
  if (input.customerOutputsMatch !== true) reasons.add("off_shadow_mismatch");
  if (input.clip?.verdict !== "pass") reasons.add("clip_gate_not_pass");
  if (clipPositiveCases < 5) reasons.add("insufficient_clip_positives");
  if (clipConfirmedNegativeCases < 8) reasons.add("insufficient_clip_negatives");
  if (clipSelectionNegativeCases < 3) reasons.add("insufficient_selection_negatives");

  const ordered = OUTCOME_REASON_ORDER.filter((reason) => reasons.has(reason));
  return Object.freeze({
    verdict: ordered.length === 0 ? "pass" : "fail",
    reasons: Object.freeze(ordered),
    metrics: Object.freeze({ recoverableCases, validEmptyCases, recoverableHoldoutCases, validEmptyHoldoutCases, recoveredCases, recoveryRateBps,
      validEmptyFalsePositives, positiveLosses, confirmedNegativeWorsening, keepFalseShipped, explicitGateResurrections,
      maximumCandidateCap, maximumCriticBatches, clipPositiveCases, clipConfirmedNegativeCases, clipSelectionNegativeCases }),
  });
}
