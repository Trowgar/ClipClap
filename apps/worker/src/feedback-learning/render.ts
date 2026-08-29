import { types as utilTypes } from "node:util";

import { canonicalJson, jsonLine, parseUtcMillisecond, sha256 } from "./canonical";
import { canonicalLedgerState, type EffectiveLedger } from "./ledger";
import { selectCandidates, type SelectionInput, type SelectionResult } from "./select";
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
const CAPACITY_KEYS = ["eval", "holdout"] as const;
const SET_CAPACITY_KEYS = [
  "jobCounts",
  "userCounts",
  "freshApprovals",
  "staleReservations",
] as const;
const STALE_RESERVATION_KEYS = ["approval", "reason"] as const;
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
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;

function invalidInput(): never {
  throw new TypeError("render_input_invalid");
}
function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function appendData<T>(array: T[], value: T): void {
  Object.defineProperty(array, String(array.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
function setData<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
function insertionSort<T>(array: T[], compare: (left: T, right: T) => number): void {
  for (let index = 1; index < array.length; index += 1) {
    const value = dataAt(array, index);
    let insertion = index;
    while (insertion > 0 && compare(dataAt(array, insertion - 1), value) > 0) {
      setData(array, insertion, dataAt(array, insertion - 1));
      insertion -= 1;
    }
    setData(array, insertion, value);
  }
}
function keyPresent(expected: readonly string[], key: string): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (dataAt(expected, index) === key) return true;
  }
  return false;
}
function captureOwnData(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length) return undefined;
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index);
      if (typeof key !== "string" || !keyPresent(expected, key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      Object.defineProperty(captured, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return captured;
  } catch {
    return undefined;
  }
}
function captureDenseArray(value: unknown): unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return undefined;
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (dataAt(keys, index) !== String(index)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      appendData(captured, descriptor.value);
    }
    if (dataAt(keys, length) !== "length") return undefined;
    return captured;
  } catch {
    return undefined;
  }
}
function captureClosedRoot(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  return captureOwnData(value, expected);
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
      setHas.call(seen, item.feedbackId)
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
    setAdd.call(seen, item.feedbackId);
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
function inputProjection(results: unknown): unknown[] {
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

type CapturedSetCapacity = Readonly<{
  freshApprovals: readonly ApprovalEvent[];
  staleReservations: readonly { approval: ApprovalEvent; reason: StaleReason }[];
}>;
type CapturedCapacity = Readonly<{
  eval: CapturedSetCapacity;
  holdout: CapturedSetCapacity;
}>;

function captureCapacity(raw: unknown, ledger: EffectiveLedger): CapturedCapacity {
  const activeByVersion = new Map<Sha256, { approval: ApprovalEvent; canonical: string }>();
  for (let index = 0; index < ledger.activeDecisions.length; index += 1) {
    const decision = dataAt(ledger.activeDecisions, index);
    if (decision.action === "approve") {
      mapSet.call(activeByVersion, decision.candidateVersion, {
        approval: decision,
        canonical: canonicalJson(decision),
      });
    }
  }
  const root = captureOwnData(raw, CAPACITY_KEYS);
  if (root === undefined) return invalidInput();
  const capturedSets: Partial<Record<TargetSet, CapturedSetCapacity>> = Object.create(null);
  const seen = new Set<Sha256>();
  for (let setIndex = 0; setIndex < CAPACITY_KEYS.length; setIndex += 1) {
    const set = dataAt(CAPACITY_KEYS, setIndex);
    const rawSet = captureOwnData(root[set], SET_CAPACITY_KEYS);
    if (rawSet === undefined) return invalidInput();
    const rawFresh = captureDenseArray(rawSet.freshApprovals);
    const rawStale = captureDenseArray(rawSet.staleReservations);
    if (rawFresh === undefined || rawStale === undefined) return invalidInput();
    const freshApprovals: ApprovalEvent[] = [];
    const staleReservations: { approval: ApprovalEvent; reason: StaleReason }[] = [];
    const captureApproval = (value: unknown): ApprovalEvent => {
      if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
        return invalidInput();
      }
      let canonical: string;
      let captured: unknown;
      try {
        canonical = canonicalJson(value);
        captured = JSON.parse(canonical) as unknown;
      } catch {
        return invalidInput();
      }
      const descriptor =
        captured !== null && typeof captured === "object"
          ? Object.getOwnPropertyDescriptor(captured, "candidateVersion")
          : undefined;
      const candidateVersion =
        descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (!isSha256(candidateVersion)) return invalidInput();
      const expected = mapGet.call(activeByVersion, candidateVersion) as
        | { approval: ApprovalEvent; canonical: string }
        | undefined;
      if (
        expected === undefined ||
        expected.canonical !== canonical ||
        expected.approval.set !== set ||
        setHas.call(seen, candidateVersion)
      ) {
        return invalidInput();
      }
      setAdd.call(seen, candidateVersion);
      return expected.approval;
    };
    for (let index = 0; index < rawFresh.length; index += 1) {
      appendData(freshApprovals, captureApproval(dataAt(rawFresh, index)));
    }
    for (let index = 0; index < rawStale.length; index += 1) {
      const reservation = captureOwnData(dataAt(rawStale, index), STALE_RESERVATION_KEYS);
      if (reservation === undefined || !enumContains(STALE_REASONS, reservation.reason)) {
        return invalidInput();
      }
      appendData(staleReservations, {
        approval: captureApproval(reservation.approval),
        reason: reservation.reason as StaleReason,
      });
    }
    capturedSets[set] = { freshApprovals, staleReservations };
  }
  if (
    setSizeGetter === undefined ||
    mapSizeGetter === undefined ||
    setSizeGetter.call(seen) !== mapSizeGetter.call(activeByVersion)
  )
    return invalidInput();
  return {
    eval: capturedSets.eval as CapturedSetCapacity,
    holdout: capturedSets.holdout as CapturedSetCapacity,
  };
}

function validateFreshness(
  ledger: EffectiveLedger,
  capacity: CapturedCapacity,
  freshness: readonly ApprovalFreshnessProjection[],
): ApprovalEvent[] {
  const approvals: ApprovalEvent[] = [];
  const freshnessByFeedback = new Map<string, ApprovalFreshnessProjection>();
  for (let index = 0; index < freshness.length; index += 1) {
    const projection = dataAt(freshness, index);
    mapSet.call(freshnessByFeedback, projection.feedbackId, projection);
  }
  for (let index = 0; index < ledger.activeDecisions.length; index += 1) {
    const decision = dataAt(ledger.activeDecisions, index);
    if (decision.action !== "approve") continue;
    const projection = mapGet.call(freshnessByFeedback, decision.feedbackId) as
      | ApprovalFreshnessProjection
      | undefined;
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
  if (mapSizeGetter === undefined || mapSizeGetter.call(freshnessByFeedback) !== approvals.length)
    return invalidInput();
  const targetSets = ["eval", "holdout"] as const;
  for (let setIndex = 0; setIndex < targetSets.length; setIndex += 1) {
    const set = dataAt(targetSets, setIndex);
    const setCapacity = set === "eval" ? capacity.eval : capacity.holdout;
    for (let index = 0; index < setCapacity.freshApprovals.length; index += 1) {
      const approval = dataAt(setCapacity.freshApprovals, index);
      const projection = mapGet.call(freshnessByFeedback, approval.feedbackId) as
        | ApprovalFreshnessProjection
        | undefined;
      if (projection?.staleReason !== null) return invalidInput();
    }
    for (let index = 0; index < setCapacity.staleReservations.length; index += 1) {
      const reservation = dataAt(setCapacity.staleReservations, index);
      if (
        (
          mapGet.call(freshnessByFeedback, reservation.approval.feedbackId) as
            | ApprovalFreshnessProjection
            | undefined
        )?.staleReason !== reservation.reason
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
    mapSet.call(
      exclusionCounts,
      reason,
      ((mapGet.call(exclusionCounts, reason) as number | undefined) ?? 0) + 1,
    );
  }
  for (let index = 0; index < EXCLUSION_REASONS.length; index += 1) {
    const reason = dataAt(EXCLUSION_REASONS, index);
    appendData(
      lines,
      `- Exclusion ${reason}: ${(mapGet.call(exclusionCounts, reason) as number | undefined) ?? 0}`,
    );
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
  let lastLine = lines.length - 1;
  while (lastLine >= 0 && dataAt(lines, lastLine) === "") lastLine -= 1;
  let rendered = "";
  for (let index = 0; index <= lastLine; index += 1) {
    if (index > 0) rendered += "\n";
    rendered += dataAt(lines, index);
  }
  return Buffer.from(`${rendered}\n`, "utf8");
}

export function buildRunArtifacts(rawInput: RenderInput): RunArtifacts {
  try {
    const root = captureClosedRoot(rawInput, ROOT_KEYS);
    if (root === undefined) return invalidInput();
    const selectionInput: SelectionInput = {
      results: root.results as SelectionInput["results"],
      targetSet: root.targetSet as SelectionInput["targetSet"],
      limit: root.limit as number,
      ledger: root.ledger as SelectionInput["ledger"],
      capacity: root.capacity as SelectionInput["capacity"],
    };
    const selection = selectCandidates(selectionInput);
    if (!isUtc(root.updatedFrom) || !isUtc(root.updatedTo) || root.updatedFrom >= root.updatedTo)
      return invalidInput();
    const effectiveLedger = JSON.parse(
      canonicalLedgerState(root.ledger as EffectiveLedger),
    ) as EffectiveLedger;
    const capacity = captureCapacity(root.capacity, effectiveLedger);
    const freshness = captureFreshness(root.approvalFreshness);
    validateFreshness(effectiveLedger, capacity, freshness);
    const optionsSha256 = sha256(
      canonicalJson({
        schemaVersion: 1,
        targetSet: selectionInput.targetSet,
        updatedFrom: root.updatedFrom,
        updatedTo: root.updatedTo,
        limit: selectionInput.limit,
      }),
    );
    const inputSha256 = sha256(canonicalJson(inputProjection(root.results)));
    const ledgerSha256 = sha256(canonicalJson({ effectiveLedger, approvalFreshness: freshness }));
    const runDigest = sha256(canonicalJson({ optionsSha256, inputSha256, ledgerSha256 }));
    const runId = `${selectionInput.targetSet}-${runDigest.slice("sha256:".length, "sha256:".length + 16)}`;
    const requestedCapacity =
      selectionInput.targetSet === "eval" ? capacity.eval : capacity.holdout;
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
      targetSet: selectionInput.targetSet,
      updatedFrom: root.updatedFrom,
      updatedTo: root.updatedTo,
      limit: selectionInput.limit,
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
    return { files, status: { runId, targetSet: selectionInput.targetSet, counts } };
  } catch {
    return invalidInput();
  }
}
