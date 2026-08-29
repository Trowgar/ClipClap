import { canonicalJson, jsonLine, parseUtcMillisecond, sha256 } from "./canonical";
import { canonicalLedgerState } from "./ledger";
import {
  appendData,
  byteCompare,
  captureClosedRoot,
  captureDenseArray,
  captureOwnData,
  insertionSort,
  selectValidatedCandidates,
  validateSelectionFields,
  type SelectionInput,
  type SelectionResult,
  type ValidatedSelectionInput,
} from "./select";
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
const ROOT_KEYS = [
  "results",
  "targetSet",
  "limit",
  "ledger",
  "capacity",
  "updatedFrom",
  "updatedTo",
  "approvalFreshness",
] as const;
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
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
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
function enumContains<T>(values: readonly T[], value: unknown): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (descriptor !== undefined && "value" in descriptor && descriptor.value === value)
      return true;
  }
  return false;
}
function dataAt<T>(values: readonly T[], index: number): T {
  const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return invalidInput();
  return descriptor.value as T;
}

function captureFreshness(raw: unknown): ApprovalFreshnessProjection[] {
  const values = captureDenseArray(raw);
  if (values === undefined) return invalidInput();
  const projections: ApprovalFreshnessProjection[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = captureOwnData(dataAt(values, index), FRESHNESS_KEYS);
    if (
      item === undefined ||
      !isNonEmptyString(item.feedbackId) ||
      typeof item.present !== "boolean" ||
      (item.verdict !== null && !isString(item.verdict)) ||
      (item.updatedAt !== null && !isUtc(item.updatedAt)) ||
      (item.snapshotCanonical !== null && !isString(item.snapshotCanonical)) ||
      (item.snapshotSha256 !== null && !isSha256(item.snapshotSha256)) ||
      (item.staleReason !== null && !enumContains(STALE_REASONS, item.staleReason)) ||
      seen.has(item.feedbackId)
    )
      return invalidInput();
    if (
      !item.present &&
      (item.verdict !== null ||
        item.updatedAt !== null ||
        item.snapshotCanonical !== null ||
        item.snapshotSha256 !== null ||
        item.staleReason !== "missing")
    )
      return invalidInput();
    if (
      item.present &&
      (item.verdict === null ||
        item.updatedAt === null ||
        item.snapshotCanonical === null ||
        item.snapshotSha256 === null ||
        sha256(item.snapshotCanonical) !== item.snapshotSha256)
    )
      return invalidInput();
    seen.add(item.feedbackId);
    appendData(projections, {
      feedbackId: item.feedbackId,
      present: item.present,
      verdict: item.verdict as string | null,
      updatedAt: item.updatedAt as string | null,
      snapshotCanonical: item.snapshotCanonical as string | null,
      snapshotSha256: item.snapshotSha256 as Sha256 | null,
      staleReason: item.staleReason as StaleReason | null,
    });
  }
  insertionSort(projections, (left, right) => byteCompare(left.feedbackId, right.feedbackId));
  return projections;
}

function compareInputProjection(left: unknown, right: unknown): number {
  const leftRecord = left as {
    status: string;
    record?: { feedbackId?: string };
    invalid?: { feedbackId?: string | null };
  };
  const rightRecord = right as typeof leftRecord;
  const leftId =
    leftRecord.status === "valid"
      ? (leftRecord.record?.feedbackId ?? "")
      : (leftRecord.invalid?.feedbackId ?? "");
  const rightId =
    rightRecord.status === "valid"
      ? (rightRecord.record?.feedbackId ?? "")
      : (rightRecord.invalid?.feedbackId ?? "");
  const id = byteCompare(leftId, rightId);
  return id !== 0 ? id : byteCompare(canonicalJson(left), canonicalJson(right));
}
function inputProjection(results: ValidatedSelectionInput["results"]): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson(results)) as unknown;
  } catch {
    return invalidInput();
  }
  const captured = captureDenseArray(parsed);
  if (captured === undefined) return invalidInput();
  insertionSort(captured, compareInputProjection);
  return captured;
}

function validateFreshness(
  input: ValidatedSelectionInput,
  freshness: readonly ApprovalFreshnessProjection[],
): ApprovalEvent[] {
  const approvals: ApprovalEvent[] = [];
  const freshnessByFeedback = new Map<string, ApprovalFreshnessProjection>();
  for (let index = 0; index < freshness.length; index += 1) {
    const projection = dataAt(freshness, index);
    freshnessByFeedback.set(projection.feedbackId, projection);
  }
  for (let index = 0; index < input.ledger.activeDecisions.length; index += 1) {
    const decision = dataAt(input.ledger.activeDecisions, index);
    if (decision.action !== "approve") continue;
    const projection = freshnessByFeedback.get(decision.feedbackId);
    if (projection === undefined) return invalidInput();
    const expectedReason: StaleReason | null = !projection.present
      ? "missing"
      : projection.verdict !== "AS_IS"
        ? "verdict_changed"
        : projection.updatedAt !== decision.feedbackUpdatedAt
          ? "updated_at_changed"
          : projection.snapshotSha256 !== decision.snapshotSha256
            ? "snapshot_changed"
            : null;
    if (projection.staleReason !== expectedReason) return invalidInput();
    appendData(approvals, decision);
  }
  if (freshnessByFeedback.size !== approvals.length) return invalidInput();
  for (const set of ["eval", "holdout"] as const) {
    const capacity = set === "eval" ? input.capacity.eval : input.capacity.holdout;
    for (let index = 0; index < capacity.freshApprovals.length; index += 1) {
      const approval = dataAt(capacity.freshApprovals, index);
      if (freshnessByFeedback.get(approval.feedbackId)?.staleReason !== null) return invalidInput();
    }
    for (let index = 0; index < capacity.staleReservations.length; index += 1) {
      const reservation = dataAt(capacity.staleReservations, index);
      if (
        freshnessByFeedback.get(reservation.approval.feedbackId)?.staleReason !== reservation.reason
      )
        return invalidInput();
    }
  }
  return approvals;
}

function jsonl(values: readonly unknown[]): Buffer {
  if (values.length === 0) return Buffer.alloc(0);
  const buffers: Buffer[] = [];
  for (let index = 0; index < values.length; index += 1)
    appendData(buffers, jsonLine(dataAt(values, index)));
  return Buffer.concat(buffers);
}
function display(value: unknown): string {
  return canonicalJson(value);
}
function warningText(warnings: readonly string[]): string {
  if (warnings.length === 0) return "none";
  let result = "";
  for (let index = 0; index < warnings.length; index += 1) {
    if (index > 0) result += ", ";
    result += dataAt(warnings, index);
  }
  return result;
}
function markdown(
  manifest: RunManifest,
  candidates: SelectionResult["candidates"],
  exclusions: SelectionResult["exclusions"],
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
  for (let index = 0; index < exclusions.length; index += 1) {
    const reason = dataAt(exclusions, index).reason;
    exclusionCounts.set(reason, (exclusionCounts.get(reason) ?? 0) + 1);
  }
  for (let index = 0; index < EXCLUSION_REASONS.length; index += 1) {
    const reason = dataAt(EXCLUSION_REASONS, index);
    appendData(lines, `- Exclusion ${reason}: ${exclusionCounts.get(reason) ?? 0}`);
  }
  appendData(lines, "");
  appendData(lines, `## Stale assignments (${manifest.staleAssignments.length})`);
  appendData(lines, "");
  for (let index = 0; index < manifest.staleAssignments.length; index += 1) {
    const assignment = dataAt(manifest.staleAssignments, index);
    appendData(
      lines,
      `- ${display(assignment.feedbackId)} - ${assignment.set} - ${assignment.reason} - ${assignment.candidateVersion}`,
    );
  }
  if (manifest.staleAssignments.length > 0) appendData(lines, "");
  appendData(lines, `## Candidates (${candidates.length})`);
  appendData(lines, "");
  for (let index = 0; index < candidates.length; index += 1) {
    const item = dataAt(candidates, index);
    appendData(lines, `### Candidate ${index + 1}`);
    appendData(lines, "");
    appendData(lines, `- Feedback ID: ${display(item.feedbackId)}`);
    appendData(lines, `- Candidate version: ${item.candidateVersion}`);
    appendData(lines, `- Tier: ${item.tier}`);
    appendData(lines, `- Warnings: ${warningText(item.warnings)}`);
    appendData(lines, `- Language: ${display(item.language)}`);
    appendData(lines, `- Clip kind: ${display(item.clipKind)}`);
    appendData(lines, `- Review: ${display(item.review)}`);
    appendData(lines, "");
  }
  appendData(lines, `## Exclusions (${exclusions.length})`);
  appendData(lines, "");
  for (let index = 0; index < exclusions.length; index += 1) {
    const item = dataAt(exclusions, index);
    const suffix =
      item.reason === "invalid_row"
        ? ` - ${item.detailCode}`
        : item.reason === "job_cap" || item.reason === "user_cap"
          ? ` - occupied ${item.cap.occupied} of ${item.cap.limit}`
          : "";
    appendData(
      lines,
      `- ${display(item.feedbackId)} - ${display(item.candidateVersion)} - ${item.reason}${suffix}`,
    );
  }
  return Buffer.from(`${lines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

export function buildRunArtifacts(rawInput: RenderInput): RunArtifacts {
  try {
    const root = captureClosedRoot(rawInput, ROOT_KEYS);
    if (root === undefined) return invalidInput();
    const input = validateSelectionFields({
      results: root.results,
      targetSet: root.targetSet,
      limit: root.limit,
      ledger: root.ledger,
      capacity: root.capacity,
    });
    if (!isUtc(root.updatedFrom) || !isUtc(root.updatedTo) || root.updatedFrom >= root.updatedTo)
      return invalidInput();
    const freshness = captureFreshness(root.approvalFreshness);
    validateFreshness(input, freshness);
    const selection = selectValidatedCandidates(input);
    const effectiveLedger = JSON.parse(canonicalLedgerState(input.ledger)) as unknown;
    const optionsSha256 = sha256(
      canonicalJson({
        schemaVersion: 1,
        targetSet: input.targetSet,
        updatedFrom: root.updatedFrom,
        updatedTo: root.updatedTo,
        limit: input.limit,
      }),
    );
    const inputSha256 = sha256(canonicalJson(inputProjection(input.results)));
    const ledgerSha256 = sha256(canonicalJson({ effectiveLedger, approvalFreshness: freshness }));
    const runDigest = sha256(canonicalJson({ optionsSha256, inputSha256, ledgerSha256 }));
    const runId = `${input.targetSet}-${runDigest.slice("sha256:".length, "sha256:".length + 16)}`;
    const requestedCapacity =
      input.targetSet === "eval" ? input.capacity.eval : input.capacity.holdout;
    const staleAssignments: StaleAssignment[] = [];
    for (let index = 0; index < requestedCapacity.staleReservations.length; index += 1) {
      const reservation = dataAt(requestedCapacity.staleReservations, index);
      appendData(staleAssignments, {
        feedbackId: reservation.approval.feedbackId,
        candidateVersion: reservation.approval.candidateVersion,
        set: reservation.approval.set,
        reason: reservation.reason,
      });
    }
    insertionSort(staleAssignments, (left, right) =>
      byteCompare(left.feedbackId, right.feedbackId),
    );
    let selectedReplayReady = 0;
    for (let index = 0; index < selection.candidates.length; index += 1)
      if (dataAt(selection.candidates, index).tier === "replay-ready") selectedReplayReady += 1;
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
    )
      return invalidInput();
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      targetSet: input.targetSet,
      updatedFrom: root.updatedFrom,
      updatedTo: root.updatedTo,
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
    return { files, status: { runId, targetSet: input.targetSet, counts } };
  } catch {
    return invalidInput();
  }
}
