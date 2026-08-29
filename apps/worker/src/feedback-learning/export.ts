import { types as utilTypes } from "node:util";
import { resolve } from "node:path";

import { canonicalJson, parseUtcMillisecond, sha256 } from "./canonical";
import {
  buildCapacity,
  canonicalLedgerState,
  classifyApprovalFreshness,
  foldLedger,
  parseLedger,
  type EffectiveLedger,
} from "./ledger";
import { normalizeFeedback } from "./normalize";
import {
  ensurePrivateTree as defaultEnsurePrivateTree,
  publishRunAtomically as defaultPublishRunAtomically,
  readLedgerSnapshot,
  type CommitResult,
  type PrivatePaths,
  type RunWrite,
} from "./persistence";
import {
  buildRunArtifacts,
  type ApprovalFreshnessProjection,
} from "./render";
import type { FeedbackLearningRepository } from "./repository";
import type {
  ApprovalEvent,
  FeedbackProjection,
  RunCounts,
  Sha256,
  TargetSet,
} from "./types";

const DEFAULT_LIMIT = 50;
const DEFAULT_ROOT = resolve(__dirname, "../../.corpus/feedback-learning");
const REQUEST_KEYS = ["targetSet", "updatedFrom", "updatedTo", "limit"] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ExportRequest = Readonly<{
  targetSet: TargetSet;
  updatedFrom: string;
  updatedTo: string;
  limit?: number;
}>;

export type SafeExportResult = Readonly<{
  operation: "export";
  runId: string;
  status: CommitResult["status"];
  counts: RunCounts;
}>;

type LockOperation = <T>(lockPath: string, operation: () => Promise<T>) => Promise<T>;

const defaultWithCorpusLock: LockOperation = async (lockPath, operation) => {
  const lock = await import("./lock");
  return lock.withCorpusLock(lockPath, operation);
};

export interface ExportDependencies {
  repository: FeedbackLearningRepository;
  root?: string;
  ensurePrivateTree?: (root: string) => Promise<PrivatePaths>;
  withCorpusLock?: LockOperation;
  readLedger?: (paths: PrivatePaths) => Promise<Uint8Array>;
  publishRunAtomically?: (input: RunWrite) => Promise<CommitResult>;
}

class ExportBoundaryError extends Error {
  readonly code: "export_request_invalid" | "ledger_read_failed";

  constructor(code: "export_request_invalid" | "ledger_read_failed") {
    super(code);
    this.name = "ExportBoundaryError";
    this.code = code;
  }
}

type ValidatedRequest = Readonly<{
  targetSet: TargetSet;
  updatedFrom: string;
  updatedTo: string;
  updatedFromDate: Date;
  updatedToDate: Date;
  limit: number;
}>;

function invalidRequest(): never {
  throw new ExportBoundaryError("export_request_invalid");
}

function captureRequest(input: unknown): Record<string, unknown> {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      utilTypes.isProxy(input) ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return invalidRequest();
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 && keys.length !== 4) return invalidRequest();
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || !REQUEST_KEYS.includes(key as (typeof REQUEST_KEYS)[number])) {
        return invalidRequest();
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalidRequest();
      captured[key] = descriptor.value;
    }
    if (!("targetSet" in captured) || !("updatedFrom" in captured) || !("updatedTo" in captured)) {
      return invalidRequest();
    }
    return captured;
  } catch (error) {
    if (error instanceof ExportBoundaryError) throw error;
    return invalidRequest();
  }
}

function validateRequest(input: ExportRequest): ValidatedRequest {
  const captured = captureRequest(input);
  if (
    (captured.targetSet !== "eval" && captured.targetSet !== "holdout") ||
    typeof captured.updatedFrom !== "string" ||
    typeof captured.updatedTo !== "string"
  ) {
    return invalidRequest();
  }
  let updatedFromDate: Date;
  let updatedToDate: Date;
  try {
    updatedFromDate = parseUtcMillisecond(captured.updatedFrom);
    updatedToDate = parseUtcMillisecond(captured.updatedTo);
  } catch {
    return invalidRequest();
  }
  if (updatedFromDate.getTime() >= updatedToDate.getTime()) return invalidRequest();
  const limit = captured.limit === undefined ? DEFAULT_LIMIT : captured.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0) return invalidRequest();
  return {
    targetSet: captured.targetSet,
    updatedFrom: captured.updatedFrom,
    updatedTo: captured.updatedTo,
    updatedFromDate,
    updatedToDate,
    limit: limit as number,
  };
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function approvalEvents(ledger: EffectiveLedger): ApprovalEvent[] {
  return ledger.activeDecisions
    .filter((event): event is ApprovalEvent => event.action === "approve")
    .slice()
    .sort((left, right) => byteCompare(left.feedbackId, right.feedbackId));
}

function snapshotLedger(bytes: Uint8Array): EffectiveLedger {
  const folded = foldLedger(parseLedger(Buffer.from(bytes)));
  return JSON.parse(canonicalLedgerState(folded)) as EffectiveLedger;
}

function feedbackById(rows: readonly FeedbackProjection[]): Map<string, FeedbackProjection> {
  const result = new Map<string, FeedbackProjection>();
  for (const row of rows) result.set(row.id, row);
  return result;
}

function approvalFreshness(
  approvals: readonly ApprovalEvent[],
  current: ReadonlyMap<string, FeedbackProjection | null>,
): ApprovalFreshnessProjection[] {
  return approvals.map((approval) => {
    const row = current.get(approval.feedbackId) ?? null;
    if (row === null) {
      return {
        feedbackId: approval.feedbackId,
        present: false,
        verdict: null,
        updatedAt: null,
        snapshotCanonical: null,
        snapshotSha256: null,
        staleReason: "missing",
      };
    }
    const snapshotCanonical = canonicalJson(row.snapshot);
    const snapshotSha256 = sha256(snapshotCanonical);
    const freshness = classifyApprovalFreshness(approval, row);
    return {
      feedbackId: approval.feedbackId,
      present: true,
      verdict: row.verdict,
      updatedAt: row.updatedAt.toISOString(),
      snapshotCanonical,
      snapshotSha256,
      staleReason: freshness.fresh ? null : freshness.reason,
    };
  });
}

function safeCounts(counts: RunCounts): RunCounts {
  return {
    queried: counts.queried,
    selected: counts.selected,
    excluded: counts.excluded,
    selectedReplayReady: counts.selectedReplayReady,
    selectedReferenceOnly: counts.selectedReferenceOnly,
    freshApprovals: counts.freshApprovals,
    staleReservations: counts.staleReservations,
  };
}

async function safeReadLedger(
  reader: (paths: PrivatePaths) => Promise<Uint8Array>,
  paths: PrivatePaths,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await reader(paths));
  } catch {
    throw new ExportBoundaryError("ledger_read_failed");
  }
}

export async function exportFeedbackLearning(
  input: ExportRequest,
  dependencies: ExportDependencies,
): Promise<SafeExportResult> {
  const request = validateRequest(input);
  if (!dependencies || !dependencies.repository) return invalidRequest();
  const root = dependencies.root ?? DEFAULT_ROOT;
  const ensurePrivateTree = dependencies.ensurePrivateTree ?? defaultEnsurePrivateTree;
  const withCorpusLock = dependencies.withCorpusLock ?? defaultWithCorpusLock;
  const readLedger = dependencies.readLedger ?? readLedgerSnapshot;
  const publishRunAtomically =
    dependencies.publishRunAtomically ?? defaultPublishRunAtomically;

  const paths = await ensurePrivateTree(root);
  const ledger = await withCorpusLock(paths.lockFile, async () =>
    snapshotLedger(await safeReadLedger(readLedger, paths)),
  );
  const approvals = approvalEvents(ledger);
  const activeApprovalFeedbackIds = approvals.map((event) => event.feedbackId);
  const database = await dependencies.repository.captureExportSnapshot({
    updatedFrom: request.updatedFromDate,
    updatedTo: request.updatedToDate,
    activeApprovalFeedbackIds,
  });

  const jobs = new Map(database.jobs.map((job) => [job.id, job] as const));
  const results = database.feedback.map((row) => normalizeFeedback(row, jobs.get(row.jobId) ?? null));
  const foundCurrent = feedbackById(database.currentApprovals);
  const currentApprovals = new Map<string, FeedbackProjection | null>();
  for (const approval of approvals) {
    currentApprovals.set(approval.feedbackId, foundCurrent.get(approval.feedbackId) ?? null);
  }
  const capacity = buildCapacity(ledger, currentApprovals);
  const artifacts = buildRunArtifacts({
    results,
    targetSet: request.targetSet,
    limit: request.limit,
    ledger,
    capacity,
    updatedFrom: request.updatedFrom,
    updatedTo: request.updatedTo,
    approvalFreshness: approvalFreshness(approvals, currentApprovals),
  });
  const manifest = JSON.parse(artifacts.files["run.json"].toString("utf8")) as {
    runId?: unknown;
    runDigest?: unknown;
  };
  if (
    manifest.runId !== artifacts.status.runId ||
    typeof manifest.runDigest !== "string" ||
    !SHA256_PATTERN.test(manifest.runDigest)
  ) {
    throw new TypeError("render_output_invalid");
  }
  const commit = await publishRunAtomically({
    paths,
    runId: artifacts.status.runId,
    runDigest: manifest.runDigest as Sha256,
    files: artifacts.files,
  });
  return {
    operation: "export",
    runId: artifacts.status.runId,
    status: commit.status,
    counts: safeCounts(artifacts.status.counts),
  };
}
