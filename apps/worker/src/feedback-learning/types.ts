import type { CommitResult } from "./persistence";

export type { CommitResult };

export type Sha256 = `sha256:${string}`;
export type TargetSet = "eval" | "holdout";
export type Tier = "replay-ready" | "reference-only";
export type Warning =
  | "job_missing"
  | "transcript_missing"
  | "transcript_segments_invalid"
  | "transcript_partial"
  | "snapshot_missing"
  | "snapshot_sparse"
  | "transcript_slice_missing"
  | "evidence_missing";

export type StaleReason =
  | "missing"
  | "verdict_changed"
  | "updated_at_changed"
  | "snapshot_changed";

export type InvalidDetailCode =
  | "identity_unavailable"
  | "snapshot_not_json"
  | "projection_invalid";

export type ExclusionReason =
  | "invalid_row"
  | "stale_review_requires_retirement"
  | "already_approved"
  | "already_rejected"
  | "job_cap"
  | "user_cap"
  | "limit_reached";

export interface FeedbackProjection {
  id: string;
  clipId: string;
  jobId: string;
  userId: string;
  verdict: string;
  note: string | null;
  snapshot: unknown;
  evidenceKey: string | null;
  updatedAt: Date;
}

export interface JobProjection {
  id: string;
  transcriptJson: unknown;
  transcriptPartial: boolean;
}

export interface ReviewRecord {
  title: string | null;
  startTime: number | null;
  endTime: number | null;
  score: number | null;
  transcript: string | null;
  note: string | null;
  evidenceKey: string | null;
}

export interface NormalizedFeedbackRecord {
  feedbackId: string;
  clipId: string;
  jobId: string;
  userId: string;
  verdict: string;
  note: string | null;
  evidenceKey: string | null;
  updatedAt: string;
  snapshotCanonical: string;
  snapshotSha256: Sha256;
  jobProjectionId: string | null;
  jobPresent: boolean;
  transcriptPresent: boolean | null;
  segmentsIsArray: boolean | null;
  transcriptPartial: boolean | null;
  language: string;
  clipKind: string;
  tier: Tier;
  warnings: readonly Warning[];
  review: ReviewRecord;
}

export interface ValidNormalizedFeedback {
  status: "valid";
  candidateVersion: Sha256;
  record: NormalizedFeedbackRecord;
}

export interface InvalidFeedback {
  feedbackId: string | null;
  candidateVersion: null;
  reason: "invalid_row";
  detailCode: InvalidDetailCode;
}

export interface InvalidNormalizedFeedback {
  status: "invalid";
  invalid: InvalidFeedback;
}

export type NormalizedFeedbackResult =
  | ValidNormalizedFeedback
  | InvalidNormalizedFeedback;

interface ExclusionBase {
  schemaVersion: 1;
  feedbackId: string;
}

export interface InvalidRowExclusion {
  schemaVersion: 1;
  feedbackId: string | null;
  candidateVersion: null;
  reason: "invalid_row";
  detailCode: InvalidDetailCode;
  cap?: never;
}

export interface JobCapExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "job_cap";
  cap: { limit: number; occupied: number };
  detailCode?: never;
}

export interface UserCapExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "user_cap";
  cap: { limit: number; occupied: number };
  detailCode?: never;
}

export interface StaleReviewExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "stale_review_requires_retirement";
  detailCode?: never;
  cap?: never;
}

export interface AlreadyApprovedExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "already_approved";
  detailCode?: never;
  cap?: never;
}

export interface AlreadyRejectedExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "already_rejected";
  detailCode?: never;
  cap?: never;
}

export interface LimitReachedExclusion extends ExclusionBase {
  candidateVersion: Sha256;
  reason: "limit_reached";
  detailCode?: never;
  cap?: never;
}

export type Exclusion =
  | InvalidRowExclusion
  | StaleReviewExclusion
  | AlreadyApprovedExclusion
  | AlreadyRejectedExclusion
  | JobCapExclusion
  | UserCapExclusion
  | LimitReachedExclusion;

interface FrozenReviewFields {
  candidateVersion: Sha256;
  feedbackId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: Sha256;
  clipId: string;
  jobId: string;
  userId: string;
}

interface ReviewEventBase {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
}

export interface ApprovalEvent extends ReviewEventBase, FrozenReviewFields {
  action: "approve";
  set: TargetSet;
  reason?: never;
  operation?: never;
  targetEventId?: never;
}

export interface RejectionEvent extends ReviewEventBase, FrozenReviewFields {
  action: "reject";
  reason: string;
  set?: never;
  operation?: never;
  targetEventId?: never;
}

export interface CorrectionEvent extends ReviewEventBase {
  action: "correct";
  operation: "retire";
  targetEventId: string;
  reason: string;
  candidateVersion?: never;
  feedbackId?: never;
  feedbackUpdatedAt?: never;
  snapshotSha256?: never;
  clipId?: never;
  jobId?: never;
  userId?: never;
  set?: never;
}

export type ReviewEvent = ApprovalEvent | RejectionEvent | CorrectionEvent;

export interface Candidate {
  schemaVersion: 1;
  candidateVersion: Sha256;
  targetSet: TargetSet;
  feedbackId: string;
  clipId: string;
  jobId: string;
  userId: string;
  updatedAt: string;
  snapshotSha256: Sha256;
  language: string;
  clipKind: string;
  tier: Tier;
  warnings: readonly Warning[];
  review: ReviewRecord;
}

export interface RunCounts {
  queried: number;
  selected: number;
  excluded: number;
  selectedReplayReady: number;
  selectedReferenceOnly: number;
  freshApprovals: number;
  staleReservations: number;
}

export interface StaleAssignment {
  feedbackId: string;
  candidateVersion: Sha256;
  set: TargetSet;
  reason: StaleReason;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  targetSet: TargetSet;
  updatedFrom: string;
  updatedTo: string;
  limit: number;
  optionsSha256: Sha256;
  inputSha256: Sha256;
  ledgerSha256: Sha256;
  runDigest: Sha256;
  counts: RunCounts;
  staleAssignments: readonly StaleAssignment[];
}
