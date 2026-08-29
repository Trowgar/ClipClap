import { canonicalJson, sha256 } from "./canonical";
import type {
  FeedbackProjection,
  InvalidDetailCode,
  JobProjection,
  NormalizedFeedbackResult,
  ReviewRecord,
  Warning,
} from "./types";

type OwnData =
  | { status: "data"; value: unknown }
  | { status: "invalid" };

function invalid(
  feedbackId: string | null,
  detailCode: InvalidDetailCode
): NormalizedFeedbackResult {
  return {
    status: "invalid",
    invalid: {
      feedbackId,
      candidateVersion: null,
      reason: "invalid_row",
      detailCode,
    },
  };
}

function ownData(value: unknown, key: string): OwnData {
  if (value === null || typeof value !== "object") return { status: "invalid" };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return { status: "invalid" };
    }
    return { status: "data", value: descriptor.value };
  } catch {
    return { status: "invalid" };
  }
}

function hasPlainObjectPrototype(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasPlainArrayPrototype(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalOwnData(value: unknown, key: string): unknown {
  const field = ownData(value, key);
  return field.status === "data" ? field.value : undefined;
}

function normalizedLabel(value: unknown): string {
  return isNonEmpty(value) ? value.trim().toLowerCase() : "unknown";
}

function capturedDate(value: unknown): { milliseconds: number; iso: string } | null {
  if (!(value instanceof Date)) return null;
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) return null;
    return { milliseconds, iso: new Date(milliseconds).toISOString() };
  } catch {
    return null;
  }
}

function transcriptSegments(value: unknown): { valid: boolean; isArray: boolean } {
  if (value === null || value === undefined || typeof value !== "object") {
    return { valid: true, isArray: false };
  }
  if (Array.isArray(value)) {
    return { valid: hasPlainArrayPrototype(value), isArray: false };
  }
  if (!hasPlainObjectPrototype(value)) return { valid: false, isArray: false };

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "segments");
  } catch {
    return { valid: false, isArray: false };
  }
  if (descriptor === undefined) return { valid: true, isArray: false };
  if (
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    return { valid: false, isArray: false };
  }
  if (!Array.isArray(descriptor.value)) return { valid: true, isArray: false };
  const plainArray = hasPlainArrayPrototype(descriptor.value);
  return { valid: plainArray, isArray: plainArray };
}

export function normalizeFeedback(
  row: FeedbackProjection,
  job: JobProjection | null
): NormalizedFeedbackResult {
  const idField = ownData(row, "id");
  const updatedAtField = ownData(row, "updatedAt");
  const feedbackId = idField.status === "data" && isNonEmpty(idField.value)
    ? idField.value
    : null;
  const date = updatedAtField.status === "data"
    ? capturedDate(updatedAtField.value)
    : null;
  if (feedbackId === null || date === null) {
    return invalid(feedbackId, "identity_unavailable");
  }

  if (!hasPlainObjectPrototype(row)) return invalid(feedbackId, "projection_invalid");

  const snapshotField = ownData(row, "snapshot");
  if (snapshotField.status !== "data") return invalid(feedbackId, "snapshot_not_json");

  let snapshotCanonical: string;
  let capturedSnapshot: unknown;
  try {
    snapshotCanonical = canonicalJson(snapshotField.value);
    capturedSnapshot = JSON.parse(snapshotCanonical) as unknown;
  } catch {
    return invalid(feedbackId, "snapshot_not_json");
  }

  const clipIdField = ownData(row, "clipId");
  const jobIdField = ownData(row, "jobId");
  const userIdField = ownData(row, "userId");
  const verdictField = ownData(row, "verdict");
  const noteField = ownData(row, "note");
  const evidenceKeyField = ownData(row, "evidenceKey");
  if (
    clipIdField.status !== "data" ||
    jobIdField.status !== "data" ||
    userIdField.status !== "data" ||
    verdictField.status !== "data" ||
    noteField.status !== "data" ||
    evidenceKeyField.status !== "data" ||
    !isNonEmpty(clipIdField.value) ||
    !isNonEmpty(jobIdField.value) ||
    !isNonEmpty(userIdField.value) ||
    typeof verdictField.value !== "string" ||
    !isNullableString(noteField.value) ||
    !isNullableString(evidenceKeyField.value)
  ) {
    return invalid(feedbackId, "projection_invalid");
  }

  const clipId = clipIdField.value;
  const jobId = jobIdField.value;
  const userId = userIdField.value;
  const verdict = verdictField.value;
  const note = noteField.value;
  const evidenceKey = evidenceKeyField.value;

  let jobProjectionId: string | null = null;
  let transcriptPresent: boolean | null = null;
  let segmentsIsArray: boolean | null = null;
  let transcriptPartial: boolean | null = null;
  if (job !== null) {
    if (!hasPlainObjectPrototype(job)) return invalid(feedbackId, "projection_invalid");
    const jobProjectionIdField = ownData(job, "id");
    const transcriptJsonField = ownData(job, "transcriptJson");
    const transcriptPartialField = ownData(job, "transcriptPartial");
    if (
      jobProjectionIdField.status !== "data" ||
      transcriptJsonField.status !== "data" ||
      transcriptPartialField.status !== "data" ||
      !isNonEmpty(jobProjectionIdField.value) ||
      jobProjectionIdField.value !== jobId ||
      typeof transcriptPartialField.value !== "boolean"
    ) {
      return invalid(feedbackId, "projection_invalid");
    }

    const segmentState = transcriptSegments(transcriptJsonField.value);
    if (!segmentState.valid) return invalid(feedbackId, "projection_invalid");
    jobProjectionId = jobProjectionIdField.value;
    transcriptPresent =
      transcriptJsonField.value !== null && transcriptJsonField.value !== undefined;
    segmentsIsArray = segmentState.isArray;
    transcriptPartial = transcriptPartialField.value;
  }

  const snapshotSha256 = sha256(snapshotCanonical);
  const candidateVersion = sha256(`${feedbackId}\n${date.iso}\n${snapshotSha256}`);
  const snapshot = snapshotRecord(capturedSnapshot);
  const snapshotTitle = optionalOwnData(snapshot, "title");
  const snapshotStartTime = optionalOwnData(snapshot, "startTime");
  const snapshotEndTime = optionalOwnData(snapshot, "endTime");
  const snapshotScore = optionalOwnData(snapshot, "score");
  const snapshotTranscript = optionalOwnData(snapshot, "transcript");
  const snapshotLanguage = optionalOwnData(snapshot, "language");
  const snapshotClipKind = optionalOwnData(snapshot, "clipKind");
  const snapshotMissing = capturedSnapshot === null;
  const snapshotSparse =
    !snapshotMissing &&
    (snapshot === null ||
      !isNonEmpty(snapshotTitle) ||
      !finiteNumber(snapshotStartTime) ||
      !finiteNumber(snapshotEndTime) ||
      !finiteNumber(snapshotScore));
  const transcriptSliceMissing =
    !snapshotMissing && (snapshot === null || !isNonEmpty(snapshotTranscript));
  const jobPresent = job !== null;
  const warnings: Warning[] = [];

  if (!jobPresent) {
    warnings.push("job_missing");
  } else {
    if (!transcriptPresent) warnings.push("transcript_missing");
    else if (!segmentsIsArray) warnings.push("transcript_segments_invalid");
    if (transcriptPartial) warnings.push("transcript_partial");
  }
  if (snapshotMissing) warnings.push("snapshot_missing");
  else if (snapshotSparse) warnings.push("snapshot_sparse");
  if (jobPresent && transcriptSliceMissing) warnings.push("transcript_slice_missing");
  if (!isNonEmpty(evidenceKey)) warnings.push("evidence_missing");

  const review: ReviewRecord = {
    title: isNonEmpty(snapshotTitle) ? snapshotTitle : null,
    startTime: finiteNumber(snapshotStartTime) ? snapshotStartTime : null,
    endTime: finiteNumber(snapshotEndTime) ? snapshotEndTime : null,
    score: finiteNumber(snapshotScore) ? snapshotScore : null,
    transcript: isNonEmpty(snapshotTranscript) ? snapshotTranscript : null,
    note,
    evidenceKey,
  };

  return {
    status: "valid",
    candidateVersion,
    record: {
      feedbackId,
      clipId,
      jobId,
      userId,
      verdict,
      note,
      evidenceKey,
      updatedAt: date.iso,
      snapshotCanonical,
      snapshotSha256,
      jobProjectionId,
      jobPresent,
      transcriptPresent,
      segmentsIsArray,
      transcriptPartial,
      language: normalizedLabel(snapshotLanguage),
      clipKind: normalizedLabel(snapshotClipKind),
      tier: jobPresent && segmentsIsArray === true && transcriptPartial === false
        ? "replay-ready"
        : "reference-only",
      warnings,
      review,
    },
  };
}
