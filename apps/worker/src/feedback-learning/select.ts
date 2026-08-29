import { canonicalJson, parseUtcMillisecond, sha256 } from "./canonical";
import type { CapacityState, EffectiveLedger, SetCapacity } from "./ledger";
import type {
  Candidate,
  Exclusion,
  InvalidDetailCode,
  NormalizedFeedbackRecord,
  NormalizedFeedbackResult,
  ReviewRecord,
  Sha256,
  TargetSet,
  Tier,
  Warning,
} from "./types";

export type SelectionInput = Readonly<{
  results: readonly NormalizedFeedbackResult[];
  targetSet: TargetSet;
  limit: number;
  ledger: EffectiveLedger;
  capacity: CapacityState;
}>;

export type SelectionResult = Readonly<{
  queried: number;
  candidates: readonly Candidate[];
  exclusions: readonly Exclusion[];
}>;

const JOB_LIMIT = 2;
const USER_LIMIT = 3;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RECORD_KEYS = [
  "feedbackId",
  "clipId",
  "jobId",
  "userId",
  "verdict",
  "note",
  "evidenceKey",
  "updatedAt",
  "snapshotCanonical",
  "snapshotSha256",
  "jobProjectionId",
  "jobPresent",
  "transcriptPresent",
  "segmentsIsArray",
  "transcriptPartial",
  "language",
  "clipKind",
  "tier",
  "warnings",
  "review",
] as const;
const REVIEW_KEYS = [
  "title",
  "startTime",
  "endTime",
  "score",
  "transcript",
  "note",
  "evidenceKey",
] as const;
const VALID_RESULT_KEYS = ["status", "candidateVersion", "record"] as const;
const INVALID_RESULT_KEYS = ["status", "invalid"] as const;
const INVALID_KEYS = [
  "feedbackId",
  "candidateVersion",
  "reason",
  "detailCode",
] as const;
const WARNING_ORDER: readonly Warning[] = [
  "job_missing",
  "transcript_missing",
  "transcript_segments_invalid",
  "transcript_partial",
  "snapshot_missing",
  "snapshot_sparse",
  "transcript_slice_missing",
  "evidence_missing",
];
const INVALID_DETAILS: readonly InvalidDetailCode[] = [
  "identity_unavailable",
  "snapshot_not_json",
  "projection_invalid",
];

function invalidInput(): never {
  throw new TypeError("selection_input_invalid");
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && isWellFormedUnicode(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function hasKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isUtc(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    parseUtcMillisecond(value);
    return true;
  } catch {
    return false;
  }
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validateReview(value: unknown): ReviewRecord {
  if (
    !hasKeys(value, REVIEW_KEYS) ||
    !isNullableString(value.title) ||
    !isNullableFinite(value.startTime) ||
    !isNullableFinite(value.endTime) ||
    !isNullableFinite(value.score) ||
    !isNullableString(value.transcript) ||
    !isNullableString(value.note) ||
    !isNullableString(value.evidenceKey)
  ) {
    return invalidInput();
  }
  return value as unknown as ReviewRecord;
}

function validateWarnings(value: unknown): readonly Warning[] {
  if (!Array.isArray(value)) return invalidInput();
  let prior = -1;
  for (const item of value) {
    const index = WARNING_ORDER.indexOf(item as Warning);
    if (index <= prior) return invalidInput();
    prior = index;
  }
  return value as readonly Warning[];
}

function validateRecord(value: unknown): NormalizedFeedbackRecord {
  if (!hasKeys(value, RECORD_KEYS)) return invalidInput();
  if (
    !isNonEmptyString(value.feedbackId) ||
    !isNonEmptyString(value.clipId) ||
    !isNonEmptyString(value.jobId) ||
    !isNonEmptyString(value.userId) ||
    value.verdict !== "AS_IS" ||
    !isNullableString(value.note) ||
    !isNullableString(value.evidenceKey) ||
    !isUtc(value.updatedAt) ||
    !isString(value.snapshotCanonical) ||
    !isSha256(value.snapshotSha256) ||
    (value.jobProjectionId !== null && !isNonEmptyString(value.jobProjectionId)) ||
    typeof value.jobPresent !== "boolean" ||
    !isNullableBoolean(value.transcriptPresent) ||
    !isNullableBoolean(value.segmentsIsArray) ||
    !isNullableBoolean(value.transcriptPartial) ||
    !isNonEmptyString(value.language) ||
    !isNonEmptyString(value.clipKind) ||
    (value.tier !== "replay-ready" && value.tier !== "reference-only") ||
    sha256(value.snapshotCanonical) !== value.snapshotSha256
  ) {
    return invalidInput();
  }
  validateWarnings(value.warnings);
  validateReview(value.review);
  return value as unknown as NormalizedFeedbackRecord;
}

function captureResults(value: unknown): NormalizedFeedbackResult[] {
  let captured: unknown;
  try {
    captured = JSON.parse(canonicalJson(value)) as unknown;
  } catch {
    return invalidInput();
  }
  if (!Array.isArray(captured)) return invalidInput();

  const results = captured.map((item): NormalizedFeedbackResult => {
    if (hasKeys(item, VALID_RESULT_KEYS) && item.status === "valid") {
      const record = validateRecord(item.record);
      if (
        !isSha256(item.candidateVersion) ||
        item.candidateVersion !==
          sha256(`${record.feedbackId}\n${record.updatedAt}\n${record.snapshotSha256}`)
      ) {
        return invalidInput();
      }
      return {
        status: "valid",
        candidateVersion: item.candidateVersion,
        record,
      };
    }

    if (
      hasKeys(item, INVALID_RESULT_KEYS) &&
      item.status === "invalid" &&
      hasKeys(item.invalid, INVALID_KEYS) &&
      (item.invalid.feedbackId === null || isNonEmptyString(item.invalid.feedbackId)) &&
      item.invalid.candidateVersion === null &&
      item.invalid.reason === "invalid_row" &&
      INVALID_DETAILS.includes(item.invalid.detailCode as InvalidDetailCode)
    ) {
      return item as unknown as NormalizedFeedbackResult;
    }
    return invalidInput();
  });
  results.sort((left, right) => {
    const leftId = left.status === "valid"
      ? left.record.feedbackId
      : left.invalid.feedbackId ?? "";
    const rightId = right.status === "valid"
      ? right.record.feedbackId
      : right.invalid.feedbackId ?? "";
    const id = byteCompare(leftId, rightId);
    if (id !== 0) return id;
    return byteCompare(canonicalJson(left), canonicalJson(right));
  });
  return results;
}

function cloneCounts(source: ReadonlyMap<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  try {
    for (const [key, count] of source) {
      if (!isNonEmptyString(key) || !Number.isSafeInteger(count) || count < 0) {
        return invalidInput();
      }
      result.set(key, count);
    }
  } catch {
    return invalidInput();
  }
  return result;
}

function requestedCapacity(capacity: CapacityState, set: TargetSet): SetCapacity {
  try {
    const requested = capacity[set];
    if (requested === null || typeof requested !== "object") return invalidInput();
    return requested;
  } catch {
    return invalidInput();
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function capExclusion(
  result: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  reason: "job_cap" | "user_cap",
  limit: number,
  occupied: number
): Exclusion {
  return {
    schemaVersion: 1,
    feedbackId: result.record.feedbackId,
    candidateVersion: result.candidateVersion,
    reason,
    cap: { limit, occupied },
  };
}

function simpleExclusion(
  result: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  reason:
    | "stale_review_requires_retirement"
    | "already_approved"
    | "already_rejected"
    | "limit_reached"
): Exclusion {
  return {
    schemaVersion: 1,
    feedbackId: result.record.feedbackId,
    candidateVersion: result.candidateVersion,
    reason,
  };
}

function candidate(result: Extract<NormalizedFeedbackResult, { status: "valid" }>, targetSet: TargetSet): Candidate {
  const record = result.record;
  return {
    schemaVersion: 1,
    candidateVersion: result.candidateVersion,
    targetSet,
    feedbackId: record.feedbackId,
    clipId: record.clipId,
    jobId: record.jobId,
    userId: record.userId,
    updatedAt: record.updatedAt,
    snapshotSha256: record.snapshotSha256,
    language: record.language,
    clipKind: record.clipKind,
    tier: record.tier as Tier,
    warnings: record.warnings,
    review: {
      title: record.review.title,
      startTime: record.review.startTime,
      endTime: record.review.endTime,
      score: record.review.score,
      transcript: record.review.transcript,
      note: record.review.note,
      evidenceKey: record.review.evidenceKey,
    },
  };
}

function rowCompare(
  left: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  right: Extract<NormalizedFeedbackResult, { status: "valid" }>
): number {
  const time = byteCompare(right.record.updatedAt, left.record.updatedAt);
  if (time !== 0) return time;
  const feedback = byteCompare(left.record.feedbackId, right.record.feedbackId);
  return feedback !== 0
    ? feedback
    : byteCompare(left.candidateVersion, right.candidateVersion);
}

type Stratum = {
  language: string;
  clipKind: string;
  rows: Extract<NormalizedFeedbackResult, { status: "valid" }>[];
  cursor: number;
};

export function selectCandidates(rawInput: SelectionInput): SelectionResult {
  let targetSet: TargetSet;
  let limit: number;
  let state: EffectiveLedger;
  let capacityState: CapacityState;
  let rawResults: unknown;
  try {
    targetSet = rawInput.targetSet;
    limit = rawInput.limit;
    state = rawInput.ledger;
    capacityState = rawInput.capacity;
    rawResults = rawInput.results;
  } catch {
    return invalidInput();
  }
  if (
    (targetSet !== "eval" && targetSet !== "holdout") ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    return invalidInput();
  }
  const results = captureResults(rawResults);
  const exclusions: Exclusion[] = [];
  const undecided: Extract<NormalizedFeedbackResult, { status: "valid" }>[] = [];
  const decisions = new Map<Sha256, "approve" | "reject">();
  const staleByFeedback = new Map<string, Sha256>();

  try {
    for (const decision of state.activeDecisions) {
      if (!isSha256(decision.candidateVersion) || !isNonEmptyString(decision.feedbackId)) {
        return invalidInput();
      }
      decisions.set(decision.candidateVersion, decision.action);
    }
    for (const set of ["eval", "holdout"] as const) {
      for (const reservation of capacityState[set].staleReservations) {
        if (
          !isNonEmptyString(reservation.approval.feedbackId) ||
          !isSha256(reservation.approval.candidateVersion)
        ) {
          return invalidInput();
        }
        staleByFeedback.set(
          reservation.approval.feedbackId,
          reservation.approval.candidateVersion
        );
      }
    }
  } catch {
    return invalidInput();
  }

  for (const result of results) {
    if (result.status === "invalid") {
      exclusions.push({
        schemaVersion: 1,
        feedbackId: result.invalid.feedbackId,
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: result.invalid.detailCode,
      });
      continue;
    }
    const staleVersion = staleByFeedback.get(result.record.feedbackId);
    if (staleVersion !== undefined && staleVersion !== result.candidateVersion) {
      exclusions.push(simpleExclusion(result, "stale_review_requires_retirement"));
      continue;
    }
    const decision = decisions.get(result.candidateVersion);
    if (decision === "approve") {
      exclusions.push(simpleExclusion(result, "already_approved"));
      continue;
    }
    if (decision === "reject") {
      exclusions.push(simpleExclusion(result, "already_rejected"));
      continue;
    }
    undecided.push(result);
  }

  const strataByKey = new Map<string, Stratum>();
  for (const result of undecided) {
    const key = `${Buffer.from(result.record.language, "utf8").toString("hex")}:${Buffer.from(result.record.clipKind, "utf8").toString("hex")}`;
    let stratum = strataByKey.get(key);
    if (stratum === undefined) {
      stratum = {
        language: result.record.language,
        clipKind: result.record.clipKind,
        rows: [],
        cursor: 0,
      };
      strataByKey.set(key, stratum);
    }
    stratum.rows.push(result);
  }
  const strata = [...strataByKey.values()].sort((left, right) => {
    const language = byteCompare(left.language, right.language);
    return language !== 0 ? language : byteCompare(left.clipKind, right.clipKind);
  });
  for (const stratum of strata) stratum.rows.sort(rowCompare);

  const starting = requestedCapacity(capacityState, targetSet);
  const startingJobs = cloneCounts(starting.jobCounts);
  const startingUsers = cloneCounts(starting.userCounts);
  for (const stratum of strata) {
    const eligible: typeof stratum.rows = [];
    for (const result of stratum.rows) {
      const jobOccupied = startingJobs.get(result.record.jobId) ?? 0;
      const userOccupied = startingUsers.get(result.record.userId) ?? 0;
      if (jobOccupied >= JOB_LIMIT) {
        exclusions.push(capExclusion(result, "job_cap", JOB_LIMIT, jobOccupied));
      } else if (userOccupied >= USER_LIMIT) {
        exclusions.push(capExclusion(result, "user_cap", USER_LIMIT, userOccupied));
      } else {
        eligible.push(result);
      }
    }
    stratum.rows = eligible;
  }

  const provisionalJobs = new Map(startingJobs);
  const provisionalUsers = new Map(startingUsers);
  const candidates: Candidate[] = [];
  let remaining = strata.reduce((sum, stratum) => sum + stratum.rows.length, 0);
  while (remaining > 0) {
    for (const stratum of strata) {
      if (stratum.cursor >= stratum.rows.length) continue;
      const result = stratum.rows[stratum.cursor];
      stratum.cursor += 1;
      remaining -= 1;

      if (candidates.length >= limit) {
        exclusions.push(simpleExclusion(result, "limit_reached"));
        continue;
      }
      const jobOccupied = provisionalJobs.get(result.record.jobId) ?? 0;
      if (jobOccupied >= JOB_LIMIT) {
        exclusions.push(capExclusion(result, "job_cap", JOB_LIMIT, jobOccupied));
        continue;
      }
      const userOccupied = provisionalUsers.get(result.record.userId) ?? 0;
      if (userOccupied >= USER_LIMIT) {
        exclusions.push(capExclusion(result, "user_cap", USER_LIMIT, userOccupied));
        continue;
      }
      candidates.push(candidate(result, targetSet));
      increment(provisionalJobs, result.record.jobId);
      increment(provisionalUsers, result.record.userId);
    }
  }

  return { queried: results.length, candidates, exclusions };
}
