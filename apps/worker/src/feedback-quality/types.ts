/** The two immutable portions of a promoted feedback corpus. */
export type TargetSet = "eval" | "holdout";

/** The only labels that may participate in a quality comparison. */
export type Disposition = "positive" | "confirmed_negative" | "exclude";

export type Subsystem = "selection" | "boundary" | "framing" | "subtitles" | "render";

/** A case can never be compared while it is not replayable. */
export type CaseStatus = "ok" | "missing" | "stale" | "error";

/** Machine-readable, deliberately closed failure vocabulary for the gate. */
export type MachineReason =
  | "invalid_schema"
  | "invalid_metric"
  | "duplicate_case_version"
  | "missing_case"
  | "stale_case"
  | "error_case"
  | "set_mismatch"
  | "mode_mismatch"
  | "corpus_mismatch"
  | "config_mismatch"
  | "runner_mismatch"
  | "insufficient_corpus"
  | "case_mismatch"
  | "positive_regression"
  | "negative_regression"
  | "hard_invariant_regression"
  | "aggregate_regression"
  | "no_improvement";

export type GateVerdict = "pass" | "fail";

/** Numeric observations are intentionally flat and finite for deterministic comparison. */
export interface QualityMetrics {
  approvedMomentRetained?: number;
  approvedWindowOverlap?: number;
  hardInvariantFailures?: number;
  defectSeverity?: number;
  emptyResult?: number;
  zeroClipFalseNegative?: number;
  boundaryErrors?: number;
  focalFailures?: number;
  subtitleFailures?: number;
  subtitleOverlap?: number;
  requiredTextClipped?: number;
  requiredSubjectClipped?: number;
  outputWidth?: number;
  outputHeight?: number;
  sar?: number;
  durationDrift?: number;
  blackTailSeconds?: number;
  frozenTailSeconds?: number;
  frameCount?: number;
  clipCount?: number;
  positiveRetention?: number;
  negativeDefects?: number;
}

/** One immutable replay result. `caseVersion` is the join key across observations. */
export interface QualityCaseResult {
  schemaVersion: 1;
  caseVersion: string;
  disposition: Disposition;
  subsystem: Subsystem;
  status: CaseStatus;
  metrics: QualityMetrics;
}

export interface QualityObservation {
  schemaVersion: 1;
  observationId: string;
  mode: "baseline" | "candidate";
  set: TargetSet;
  commitSha: string;
  configSha256: string;
  corpusSha256: string;
  runnerVersion: number;
  createdAt: string;
  cases: QualityCaseResult[];
  /** Optional runner summary; policy validates but never trusts it over case metrics. */
  metrics?: QualityMetrics;
}

export type QualityClaim = "improvement" | "non_regression_only";

export interface CorpusMinimum {
  evalPositive: number;
  evalNegative: number;
  holdoutPositive: number;
  holdoutNegative: number;
}

export interface GatePolicy {
  schemaVersion: 1;
  policyVersion: string;
  claim: QualityClaim;
  minimum: CorpusMinimum;
}

export interface GateDecisionInput {
  baseline: QualityObservation;
  candidate: QualityObservation;
  policy: GatePolicy;
}

export interface GateAggregate {
  positiveRetention: number;
  negativeDefects: number;
  zeroClipFalseNegatives: number;
  boundaryErrors: number;
  focalFailures: number;
  subtitleFailures: number;
}

export interface GateComparison {
  verdict: GateVerdict;
  reasons: MachineReason[];
  baseline: GateAggregate;
  candidate: GateAggregate;
}
