import { canonicalJson, sha256 } from "./canonical";
import type {
  FeedbackProjection,
  InvalidDetailCode,
  JobProjection,
  NormalizedFeedbackResult,
  ReviewRecord,
  Warning,
} from "./types";

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

function normalizedLabel(value: unknown): string {
  return isNonEmpty(value) ? value.trim().toLowerCase() : "unknown";
}

export function normalizeFeedback(
  row: FeedbackProjection,
  job: JobProjection | null
): NormalizedFeedbackResult {
  const feedbackId = isNonEmpty(row?.id) ? row.id : null;
  if (
    feedbackId === null ||
    !(row?.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  ) {
    return invalid(feedbackId, "identity_unavailable");
  }

  let snapshotCanonical: string;
  try {
    snapshotCanonical = canonicalJson(row.snapshot);
  } catch {
    return invalid(feedbackId, "snapshot_not_json");
  }

  if (
    !isNonEmpty(row.clipId) ||
    !isNonEmpty(row.jobId) ||
    !isNonEmpty(row.userId) ||
    typeof row.verdict !== "string" ||
    !isNullableString(row.note) ||
    !isNullableString(row.evidenceKey) ||
    (job !== null &&
      (typeof job !== "object" ||
        !isNonEmpty(job.id) ||
        job.id !== row.jobId ||
        typeof job.transcriptPartial !== "boolean"))
  ) {
    return invalid(feedbackId, "projection_invalid");
  }

  const snapshotSha256 = sha256(snapshotCanonical);
  const updatedAt = row.updatedAt.toISOString();
  const candidateVersion = sha256(`${feedbackId}\n${updatedAt}\n${snapshotSha256}`);
  const snapshot = snapshotRecord(row.snapshot);
  const snapshotMissing = row.snapshot === null;
  const snapshotSparse =
    !snapshotMissing &&
    (snapshot === null ||
      !isNonEmpty(snapshot.title) ||
      !finiteNumber(snapshot.startTime) ||
      !finiteNumber(snapshot.endTime) ||
      !finiteNumber(snapshot.score));
  const transcriptSliceMissing =
    !snapshotMissing && (snapshot === null || !isNonEmpty(snapshot.transcript));

  const jobPresent = job !== null;
  const transcriptJson = job?.transcriptJson;
  const transcriptPresent = jobPresent
    ? transcriptJson !== null && transcriptJson !== undefined
    : null;
  const transcriptObject =
    transcriptPresent && typeof transcriptJson === "object"
      ? (transcriptJson as Record<string, unknown>)
      : null;
  const segmentsIsArray = jobPresent
    ? transcriptObject !== null && Array.isArray(transcriptObject.segments)
    : null;
  const transcriptPartial = jobPresent ? job.transcriptPartial : null;
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
  if (!isNonEmpty(row.evidenceKey)) warnings.push("evidence_missing");

  const review: ReviewRecord = {
    title: snapshot !== null && isNonEmpty(snapshot.title) ? snapshot.title : null,
    startTime: snapshot !== null && finiteNumber(snapshot.startTime) ? snapshot.startTime : null,
    endTime: snapshot !== null && finiteNumber(snapshot.endTime) ? snapshot.endTime : null,
    score: snapshot !== null && finiteNumber(snapshot.score) ? snapshot.score : null,
    transcript:
      snapshot !== null && isNonEmpty(snapshot.transcript) ? snapshot.transcript : null,
    note: row.note,
    evidenceKey: row.evidenceKey,
  };

  return {
    status: "valid",
    candidateVersion,
    record: {
      feedbackId,
      clipId: row.clipId,
      jobId: row.jobId,
      userId: row.userId,
      verdict: row.verdict,
      note: row.note,
      evidenceKey: row.evidenceKey,
      updatedAt,
      snapshotCanonical,
      snapshotSha256,
      jobProjectionId: job?.id ?? null,
      jobPresent,
      transcriptPresent,
      segmentsIsArray,
      transcriptPartial,
      language: normalizedLabel(snapshot?.language),
      clipKind: normalizedLabel(snapshot?.clipKind),
      tier: jobPresent && segmentsIsArray === true && transcriptPartial === false
        ? "replay-ready"
        : "reference-only",
      warnings,
      review,
    },
  };
}
