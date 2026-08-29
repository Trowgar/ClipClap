import { canonicalJson, jsonLine, parseUtcMillisecond, sha256 } from "./canonical";
import { canonicalLedgerState, type EffectiveLedger } from "./ledger";
import { selectCandidates, type SelectionInput } from "./select";
import type {
  ApprovalEvent,
  ExclusionReason,
  RunCounts,
  RunManifest,
  Sha256,
  StaleAssignment,
  StaleReason,
  TargetSet,
} from "./types";

export type ApprovalFreshnessProjection = Readonly<{
  feedbackId: string;
  present: boolean;
  verdict: string | null;
  updatedAt: string | null;
  snapshotCanonical: string | null;
  snapshotSha256: Sha256 | null;
  staleReason: StaleReason | null;
}>;

export type RenderInput = SelectionInput &
  Readonly<{
    updatedFrom: string;
    updatedTo: string;
    approvalFreshness: readonly ApprovalFreshnessProjection[];
  }>;

export type RunArtifactFiles = Readonly<{
  "run.json": Buffer;
  "candidates.jsonl": Buffer;
  "exclusions.jsonl": Buffer;
  "candidates.md": Buffer;
}>;

export type SafeRunStatus = Readonly<{
  runId: string;
  targetSet: TargetSet;
  counts: RunCounts;
}>;

export type RunArtifacts = Readonly<{
  files: RunArtifactFiles;
  status: SafeRunStatus;
}>;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FRESHNESS_KEYS = [
  "feedbackId",
  "present",
  "verdict",
  "updatedAt",
  "snapshotCanonical",
  "snapshotSha256",
  "staleReason",
] as const;
const STALE_REASONS: readonly StaleReason[] = [
  "missing",
  "verdict_changed",
  "updated_at_changed",
  "snapshot_changed",
];
const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "invalid_row",
  "stale_review_requires_retirement",
  "already_approved",
  "already_rejected",
  "job_cap",
  "user_cap",
  "limit_reached",
];

function invalidInput(): never {
  throw new TypeError("render_input_invalid");
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

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
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

function hasKeySet(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function captureJson(value: unknown): unknown {
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch {
    return invalidInput();
  }
}

function captureFreshness(
  raw: readonly ApprovalFreshnessProjection[]
): ApprovalFreshnessProjection[] {
  const captured = captureJson(raw);
  if (!Array.isArray(captured)) return invalidInput();
  const projections: ApprovalFreshnessProjection[] = [];
  const seen = new Set<string>();
  for (const item of captured) {
    if (
      !hasKeySet(item, FRESHNESS_KEYS) ||
      !isNonEmptyString(item.feedbackId) ||
      typeof item.present !== "boolean" ||
      (item.verdict !== null && !isString(item.verdict)) ||
      (item.updatedAt !== null && !isUtc(item.updatedAt)) ||
      (item.snapshotCanonical !== null && !isString(item.snapshotCanonical)) ||
      (item.snapshotSha256 !== null && !isSha256(item.snapshotSha256)) ||
      (item.staleReason !== null && !STALE_REASONS.includes(item.staleReason as StaleReason)) ||
      seen.has(item.feedbackId)
    ) {
      return invalidInput();
    }
    if (
      !item.present &&
      (item.verdict !== null ||
        item.updatedAt !== null ||
        item.snapshotCanonical !== null ||
        item.snapshotSha256 !== null ||
        item.staleReason !== "missing")
    ) {
      return invalidInput();
    }
    if (
      item.present &&
      (item.verdict === null ||
        item.updatedAt === null ||
        item.snapshotCanonical === null ||
        item.snapshotSha256 === null ||
        sha256(item.snapshotCanonical) !== item.snapshotSha256)
    ) {
      return invalidInput();
    }
    seen.add(item.feedbackId);
    projections.push(item as unknown as ApprovalFreshnessProjection);
  }
  projections.sort((left, right) => byteCompare(left.feedbackId, right.feedbackId));
  return projections;
}

function compareInputProjection(left: unknown, right: unknown): number {
  const leftRecord = left as {
    status: string;
    candidateVersion?: string;
    record?: { feedbackId?: string };
    invalid?: { feedbackId?: string | null; detailCode?: string };
  };
  const rightRecord = right as typeof leftRecord;
  const leftId = leftRecord.status === "valid"
    ? leftRecord.record?.feedbackId ?? ""
    : leftRecord.invalid?.feedbackId ?? "";
  const rightId = rightRecord.status === "valid"
    ? rightRecord.record?.feedbackId ?? ""
    : rightRecord.invalid?.feedbackId ?? "";
  const id = byteCompare(leftId, rightId);
  if (id !== 0) return id;
  return byteCompare(canonicalJson(left), canonicalJson(right));
}

function inputProjection(raw: RenderInput["results"]): unknown[] {
  const captured = captureJson(raw);
  if (!Array.isArray(captured)) return invalidInput();
  captured.sort(compareInputProjection);
  return captured;
}

function mapEqualsExpected(
  actual: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>
): boolean {
  try {
    if (actual.size !== expected.size) return false;
    for (const [key, count] of expected) {
      if (actual.get(key) !== count) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function validateCapacity(
  input: RenderInput,
  approvals: readonly ApprovalEvent[],
  freshness: readonly ApprovalFreshnessProjection[]
): void {
  const approvalByVersion = new Map(approvals.map((approval) => [approval.candidateVersion, approval]));
  const freshnessByFeedback = new Map(freshness.map((item) => [item.feedbackId, item]));
  if (freshnessByFeedback.size !== approvals.length) return invalidInput();
  for (const approval of approvals) {
    const projection = freshnessByFeedback.get(approval.feedbackId);
    if (projection === undefined) return invalidInput();
    const expectedReason: StaleReason | null = !projection.present
      ? "missing"
      : projection.verdict !== "AS_IS"
        ? "verdict_changed"
        : projection.updatedAt !== approval.feedbackUpdatedAt
          ? "updated_at_changed"
          : projection.snapshotSha256 !== approval.snapshotSha256
            ? "snapshot_changed"
            : null;
    if (projection.staleReason !== expectedReason) return invalidInput();
  }

  const classified = new Set<Sha256>();
  for (const set of ["eval", "holdout"] as const) {
    const setCapacity = input.capacity[set];
    const jobs = new Map<string, number>();
    const users = new Map<string, number>();
    const consume = (approval: ApprovalEvent, staleReason: StaleReason | null): void => {
      const active = approvalByVersion.get(approval.candidateVersion);
      const projection = freshnessByFeedback.get(approval.feedbackId);
      if (
        active === undefined ||
        active.eventId !== approval.eventId ||
        active.set !== set ||
        classified.has(approval.candidateVersion) ||
        projection === undefined ||
        projection.staleReason !== staleReason
      ) {
        return invalidInput();
      }
      classified.add(approval.candidateVersion);
      increment(jobs, approval.jobId);
      increment(users, approval.userId);
    };
    try {
      for (const approval of setCapacity.freshApprovals) consume(approval, null);
      for (const reservation of setCapacity.staleReservations) {
        consume(reservation.approval, reservation.reason);
      }
      if (
        !mapEqualsExpected(setCapacity.jobCounts, jobs) ||
        !mapEqualsExpected(setCapacity.userCounts, users)
      ) {
        return invalidInput();
      }
    } catch {
      return invalidInput();
    }
  }
  if (classified.size !== approvals.length) return invalidInput();
}

function jsonl(values: readonly unknown[]): Buffer {
  if (values.length === 0) return Buffer.alloc(0);
  return Buffer.concat(values.map((value) => jsonLine(value)));
}

function display(value: unknown): string {
  return canonicalJson(value);
}

function markdown(
  manifest: RunManifest,
  candidates: ReturnType<typeof selectCandidates>["candidates"],
  exclusions: ReturnType<typeof selectCandidates>["exclusions"]
): Buffer {
  const lines: string[] = [
    `# AS_IS learning corpus - ${manifest.runId}`,
    "",
    "## Summary",
    "",
    `- Queried: ${manifest.counts.queried}`,
    `- Selected: ${manifest.counts.selected}`,
    `- Excluded: ${manifest.counts.excluded}`,
    `- Selected replay-ready: ${manifest.counts.selectedReplayReady}`,
    `- Selected reference-only: ${manifest.counts.selectedReferenceOnly}`,
    `- Fresh approvals: ${manifest.counts.freshApprovals}`,
    `- Stale reservations: ${manifest.counts.staleReservations}`,
  ];
  const exclusionCounts = new Map<ExclusionReason, number>();
  for (const exclusion of exclusions) {
    exclusionCounts.set(exclusion.reason, (exclusionCounts.get(exclusion.reason) ?? 0) + 1);
  }
  for (const reason of EXCLUSION_REASONS) {
    lines.push(`- Exclusion ${reason}: ${exclusionCounts.get(reason) ?? 0}`);
  }

  lines.push("", `## Stale assignments (${manifest.staleAssignments.length})`, "");
  for (const assignment of manifest.staleAssignments) {
    lines.push(
      `- ${display(assignment.feedbackId)} - ${assignment.set} - ${assignment.reason} - ${assignment.candidateVersion}`
    );
  }

  lines.push(`## Candidates (${candidates.length})`, "");
  candidates.forEach((candidate, index) => {
    lines.push(
      `### Candidate ${index + 1}`,
      "",
      `- Feedback ID: ${display(candidate.feedbackId)}`,
      `- Candidate version: ${candidate.candidateVersion}`,
      `- Tier: ${candidate.tier}`,
      `- Warnings: ${candidate.warnings.length === 0 ? "none" : candidate.warnings.join(", ")}`,
      `- Language: ${display(candidate.language)}`,
      `- Clip kind: ${display(candidate.clipKind)}`,
      `- Review: ${display(candidate.review)}`,
      ""
    );
  });

  lines.push(`## Exclusions (${exclusions.length})`, "");
  exclusions.forEach((exclusion) => {
    const suffix = exclusion.reason === "invalid_row"
      ? ` - ${exclusion.detailCode}`
      : exclusion.reason === "job_cap" || exclusion.reason === "user_cap"
        ? ` - occupied ${exclusion.cap.occupied} of ${exclusion.cap.limit}`
        : "";
    lines.push(
      `- ${display(exclusion.feedbackId)} - ${display(exclusion.candidateVersion)} - ${exclusion.reason}${suffix}`
    );
  });
  return Buffer.from(`${lines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

export function buildRunArtifacts(input: RenderInput): RunArtifacts {
  let selection;
  let updatedFrom: string;
  let updatedTo: string;
  try {
    selection = selectCandidates(input);
    updatedFrom = input.updatedFrom;
    updatedTo = input.updatedTo;
  } catch {
    return invalidInput();
  }
  if (!isUtc(updatedFrom) || !isUtc(updatedTo) || updatedFrom >= updatedTo) {
    return invalidInput();
  }

  let effectiveLedger: unknown;
  let approvals: ApprovalEvent[];
  try {
    effectiveLedger = JSON.parse(canonicalLedgerState(input.ledger)) as unknown;
    approvals = (effectiveLedger as EffectiveLedger).activeDecisions.filter(
      (decision): decision is ApprovalEvent => decision.action === "approve"
    );
  } catch {
    return invalidInput();
  }
  const freshness = captureFreshness(input.approvalFreshness);
  validateCapacity(input, approvals, freshness);

  const optionsSha256 = sha256(
    canonicalJson({
      schemaVersion: 1,
      targetSet: input.targetSet,
      updatedFrom,
      updatedTo,
      limit: input.limit,
    })
  );
  const inputSha256 = sha256(canonicalJson(inputProjection(input.results)));
  const ledgerSha256 = sha256(
    canonicalJson({ effectiveLedger, approvalFreshness: freshness })
  );
  const runDigest = sha256(
    canonicalJson({ optionsSha256, inputSha256, ledgerSha256 })
  );
  const runId = `${input.targetSet}-${runDigest.slice("sha256:".length, "sha256:".length + 16)}`;
  const requestedCapacity = input.capacity[input.targetSet];
  const staleAssignments: StaleAssignment[] = requestedCapacity.staleReservations.map(
    ({ approval, reason }) => ({
      feedbackId: approval.feedbackId,
      candidateVersion: approval.candidateVersion,
      set: approval.set,
      reason,
    })
  );
  staleAssignments.sort((left, right) => byteCompare(left.feedbackId, right.feedbackId));

  const selectedReplayReady = selection.candidates.filter(
    (candidate) => candidate.tier === "replay-ready"
  ).length;
  const counts: RunCounts = {
    queried: selection.queried,
    selected: selection.candidates.length,
    excluded: selection.exclusions.length,
    selectedReplayReady,
    selectedReferenceOnly: selection.candidates.length - selectedReplayReady,
    freshApprovals: requestedCapacity.freshApprovals.length,
    staleReservations: requestedCapacity.staleReservations.length,
  };
  if (
    counts.queried !== counts.selected + counts.excluded ||
    counts.selected !== counts.selectedReplayReady + counts.selectedReferenceOnly ||
    counts.staleReservations !== staleAssignments.length
  ) {
    return invalidInput();
  }

  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    targetSet: input.targetSet,
    updatedFrom,
    updatedTo,
    limit: input.limit,
    optionsSha256,
    inputSha256,
    ledgerSha256,
    runDigest,
    counts,
    staleAssignments,
  };
  const files: RunArtifactFiles = {
    "run.json": jsonLine(manifest),
    "candidates.jsonl": jsonl(selection.candidates),
    "exclusions.jsonl": jsonl(selection.exclusions),
    "candidates.md": markdown(manifest, selection.candidates, selection.exclusions),
  };
  return {
    files,
    status: { runId, targetSet: input.targetSet, counts },
  };
}
