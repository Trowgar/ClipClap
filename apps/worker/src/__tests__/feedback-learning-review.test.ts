import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, jsonLine, sha256 } from "../feedback-learning/canonical";
import { ensurePrivateTree, type LedgerWrite, type PrivatePaths } from "../feedback-learning/persistence";
import { reviewFeedback, type ReviewDependencies } from "../feedback-learning/review";
import type { ApprovalEvent, Candidate, FeedbackProjection, ReviewEvent, Sha256 } from "../feedback-learning/types";

const UPDATED_AT = "2026-08-28T12:00:00.000Z";
const OCCURRED_AT = "2026-08-29T10:00:00.000Z";
const RUN_ID = "eval-0123456789abcdef";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function row(id: string, overrides: Partial<FeedbackProjection> = {}): FeedbackProjection {
  return { id, clipId: `clip-${id}`, jobId: `job-${id}`, userId: `user-${id}`, verdict: "AS_IS", note: null,
    snapshot: { title: `Title ${id}`, startTime: 1, endTime: 2, score: 0.9 }, evidenceKey: null,
    updatedAt: new Date(UPDATED_AT), ...overrides };
}

function candidate(current: FeedbackProjection, targetSet: "eval" | "holdout" = "eval"): Candidate {
  const snapshotSha256 = sha256(canonicalJson(current.snapshot));
  return { schemaVersion: 1, candidateVersion: sha256(`${current.id}\n${UPDATED_AT}\n${snapshotSha256}`), targetSet,
    feedbackId: current.id, clipId: current.clipId, jobId: current.jobId, userId: current.userId,
    updatedAt: UPDATED_AT, snapshotSha256, language: "en", clipKind: "insight", tier: "replay-ready", warnings: [],
    review: { title: `Title ${current.id}`, startTime: 1, endTime: 2, score: 0.9,
      transcript: "private transcript", note: null, evidenceKey: null } };
}

function approval(eventId: string, current: FeedbackProjection, set: "eval" | "holdout" = "eval"): ApprovalEvent {
  const selected = candidate(current, set);
  return { schemaVersion: 1, eventId, action: "approve", occurredAt: OCCURRED_AT,
    candidateVersion: selected.candidateVersion, feedbackId: current.id, feedbackUpdatedAt: UPDATED_AT,
    snapshotSha256: selected.snapshotSha256, clipId: current.clipId, jobId: current.jobId, userId: current.userId, set };
}

function paths(root = "/private/corpus"): PrivatePaths {
  return { root, exportsDir: join(root, "exports"), ledgerDir: join(root, "ledger"),
    reviewsFile: join(root, "ledger", "reviews.jsonl"), lockFile: join(root, "ledger", "reviews.lock") };
}

function setup(input: { candidates?: Candidate[]; rows?: FeedbackProjection[]; ledger?: ReviewEvent[];
  status?: "committed" | "noop" | "committed_durability_uncertain" | "indeterminate" } = {}) {
  let ledger = Buffer.concat((input.ledger ?? []).map((event) => jsonLine(event)));
  const candidates = input.candidates ?? [];
  const rows = input.rows ?? [];
  const writes: LedgerWrite[] = [];
  const order: string[] = [];
  const repository = {
    captureExportSnapshot: vi.fn(async () => ({ feedback: [], jobs: [], currentApprovals: [] })),
    captureReviewSnapshot: vi.fn(async ({ candidateFeedbackId, activeApprovalFeedbackIds }: { candidateFeedbackId: string; activeApprovalFeedbackIds: readonly string[] }) => {
      order.push("database");
      return { candidate: rows.find((value) => value.id === candidateFeedbackId) ?? null,
        currentApprovals: rows.filter((value) => activeApprovalFeedbackIds.includes(value.id)) };
    }),
  };
  const dependencies: ReviewDependencies = {
    repository, root: "/private/corpus",
    ensurePrivateTree: vi.fn(async () => { order.push("ensure"); return paths(); }),
    readCandidate: vi.fn(async () => { order.push("candidate-read"); return Buffer.concat(candidates.map((value) => jsonLine(value))); }),
    withCorpusLock: vi.fn(async (_path, operation) => { order.push("lock-enter"); const result = await operation(); order.push("lock-exit"); return result; }),
    readLedger: vi.fn(async () => { order.push("ledger-read"); return new Uint8Array(ledger); }),
    replaceLedger: vi.fn(async (write) => { order.push("ledger-write"); writes.push(write); ledger = Buffer.from(write.bytes); return { status: input.status ?? "committed" }; }),
    eventId: vi.fn(() => `event-${writes.length + 1}`), now: vi.fn(() => new Date(OCCURRED_AT)),
  };
  return { dependencies, repository, writes, order };
}

describe("reviewFeedback", () => {
  it("approves with authoritative DB fields under one lock and appends one exact line", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    const test = setup({ candidates: [selected], rows: [current] });
    const result = await reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies);
    expect(result).toEqual({ operation: "review", eventId: "event-1", status: "committed" });
    expect(test.order).toEqual(["ensure", "candidate-read", "lock-enter", "ledger-read", "database", "ledger-write", "lock-exit"]);
    expect(test.repository.captureReviewSnapshot).toHaveBeenCalledWith({ candidateFeedbackId: current.id, activeApprovalFeedbackIds: [] });
    expect(Buffer.from(test.writes[0].bytes)).toEqual(jsonLine(approval("event-1", current)));
    expect(test.writes[0].expectedEventId).toBe("event-1");
    expect(JSON.stringify(result)).not.toContain(current.id);
    expect(JSON.stringify(result)).not.toContain(selected.candidateVersion);
  });

  it("rejects without consuming capacity and writes the exact private reason", async () => {
    const current = row("feedback-1", { jobId: "full-job", userId: "full-user" });
    const selected = candidate(current);
    const occupied = [approval("old-1", row("old-1", { jobId: "full-job", userId: "full-user" })),
      approval("old-2", row("old-2", { jobId: "full-job", userId: "full-user" }))];
    const test = setup({ candidates: [selected], rows: [current], ledger: occupied });
    await expect(reviewFeedback({ action: "reject", runId: RUN_ID, candidateVersion: selected.candidateVersion, reason: "Not representative" }, test.dependencies)).resolves.toMatchObject({ status: "committed" });
    const prior = Buffer.concat(occupied.map((event) => jsonLine(event)));
    const appended = JSON.parse(Buffer.from(test.writes[0].bytes).subarray(prior.length).toString("utf8"));
    expect(appended).toEqual({ schemaVersion: 1, eventId: "event-1", action: "reject", occurredAt: OCCURRED_AT,
      candidateVersion: selected.candidateVersion, feedbackId: current.id, feedbackUpdatedAt: UPDATED_AT,
      snapshotSha256: selected.snapshotSha256, clipId: current.clipId, jobId: current.jobId, userId: current.userId,
      reason: "Not representative" });
  });

  it("retires only an active prior decision without candidate or database access", async () => {
    const current = row("feedback-1");
    const prior = approval("approve-1", current);
    const test = setup({ ledger: [prior] });
    await expect(reviewFeedback({ action: "correct", targetEventId: prior.eventId, operation: "retire", reason: "Wrong assignment" }, test.dependencies)).resolves.toEqual({ operation: "review", eventId: "event-1", status: "committed" });
    expect(test.dependencies.readCandidate).not.toHaveBeenCalled();
    expect(test.repository.captureReviewSnapshot).not.toHaveBeenCalled();
    expect(Buffer.from(test.writes[0].bytes).subarray(jsonLine(prior).length)).toEqual(jsonLine({ schemaVersion: 1, eventId: "event-1", action: "correct", occurredAt: OCCURRED_AT, operation: "retire", targetEventId: "approve-1", reason: "Wrong assignment" }));
  });

  it.each([
    ["malformed run", { action: "approve", runId: "../escape", candidateVersion: `sha256:${"a".repeat(64)}` }],
    ["absolute run", { action: "approve", runId: "/tmp/escape", candidateVersion: `sha256:${"a".repeat(64)}` }],
    ["uppercase hash", { action: "approve", runId: RUN_ID, candidateVersion: `sha256:${"A".repeat(64)}` }],
    ["approve reason", { action: "approve", runId: RUN_ID, candidateVersion: `sha256:${"a".repeat(64)}`, reason: "forbidden" }],
    ["missing rejection reason", { action: "reject", runId: RUN_ID, candidateVersion: `sha256:${"a".repeat(64)}` }],
    ["malformed correction target", { action: "correct", targetEventId: "bad-\ud800", operation: "retire", reason: "reason" }],
  ])("rejects %s before any path operation", async (_label, request) => {
    const test = setup();
    await expect(reviewFeedback(request as never, test.dependencies)).rejects.toMatchObject({ code: "review_request_invalid" });
    expect(test.dependencies.ensurePrivateTree).not.toHaveBeenCalled();
  });

  it("rejects candidate tampering and current DB changes without writing", async () => {
    const current = row("feedback-1");
    const valid = candidate(current);
    const tampered: Candidate[] = [{ ...valid, feedbackId: "other" }, { ...valid, clipId: "other" },
      { ...valid, jobId: "other" }, { ...valid, userId: "other" },
      { ...valid, updatedAt: "2026-08-28T12:00:01.000Z" },
      { ...valid, snapshotSha256: `sha256:${"a".repeat(64)}` as Sha256 }, { ...valid, targetSet: "holdout" }];
    for (const selected of tampered) {
      const test = setup({ candidates: [selected], rows: [current] });
      await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: valid.candidateVersion }, test.dependencies)).rejects.toMatchObject({ code: expect.stringMatching(/candidate/) });
      expect(test.writes).toHaveLength(0);
    }
    for (const changed of [null, row("feedback-1", { verdict: "NO" }), row("feedback-1", { snapshot: { changed: true } }), row("feedback-1", { updatedAt: new Date("2026-08-28T12:00:01.000Z") })]) {
      const test = setup({ candidates: [valid], rows: changed === null ? [] : [changed] });
      await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: valid.candidateVersion }, test.dependencies)).rejects.toMatchObject({ code: expect.stringMatching(/candidate/) });
      expect(test.writes).toHaveLength(0);
    }
  });

  it("enforces permanent destination locks and job-before-user caps", async () => {
    const current = row("candidate", { jobId: "full-job", userId: "full-user" });
    const selected = candidate(current);
    const occupied = [approval("old-1", row("old-1", { jobId: "full-job", userId: "full-user" })), approval("old-2", row("old-2", { jobId: "full-job", userId: "full-user" }))];
    const cap = setup({ candidates: [selected], rows: [current, row("old-1", { jobId: "full-job", userId: "full-user" }), row("old-2", { jobId: "full-job", userId: "full-user" })], ledger: occupied });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, cap.dependencies)).rejects.toMatchObject({ code: "job_cap" });
    expect(cap.writes).toHaveLength(0);

    const lockedRow = row("locked");
    const prior = approval("holdout-prior", lockedRow, "holdout");
    const retired = { schemaVersion: 1, eventId: "retire-prior", action: "correct", occurredAt: OCCURRED_AT, operation: "retire", targetEventId: prior.eventId, reason: "retire" } as const;
    const locked = setup({ candidates: [candidate(lockedRow)], rows: [lockedRow], ledger: [prior, retired] });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: candidate(lockedRow).candidateVersion }, locked.dependencies)).rejects.toMatchObject({ code: "destination_locked" });
  });

  it("allows rejection from an export opposite a retained destination lock", async () => {
    const current = row("locked");
    const prior = approval("holdout-prior", current, "holdout");
    const retired = { schemaVersion: 1, eventId: "retire-prior", action: "correct", occurredAt: OCCURRED_AT,
      operation: "retire", targetEventId: prior.eventId, reason: "retire" } as const;
    const selected = candidate(current);
    const test = setup({ candidates: [selected], rows: [current], ledger: [prior, retired] });

    await expect(reviewFeedback({ action: "reject", runId: RUN_ID, candidateVersion: selected.candidateVersion,
      reason: "Not suitable" }, test.dependencies)).resolves.toMatchObject({ status: "committed" });

    const appended = JSON.parse(Buffer.from(test.writes[0].bytes).subarray(jsonLine(prior).length + jsonLine(retired).length).toString("utf8"));
    expect(appended.action).toBe("reject");
    expect(appended).not.toHaveProperty("set");
  });

  it.each(["committed", "noop", "committed_durability_uncertain", "indeterminate"] as const)("returns only the safe %s persistence outcome", async (status) => {
    const current = row("feedback-1"); const selected = candidate(current);
    const test = setup({ candidates: [selected], rows: [current], status });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies)).resolves.toEqual({ operation: "review", eventId: "event-1", status });
  });

  it("serializes concurrent approvals so a job cannot exceed two", async () => {
    const first = row("first", { jobId: "shared-job" }); const second = row("second", { jobId: "shared-job" }); const occupied = row("occupied", { jobId: "shared-job" });
    const test = setup({ candidates: [candidate(first), candidate(second)], rows: [first, second, occupied], ledger: [approval("occupied", occupied)] });
    let tail = Promise.resolve();
    test.dependencies.withCorpusLock = vi.fn(async (_path, operation) => { const prior = tail; let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await operation(); } finally { release(); } });
    const results = await Promise.allSettled([
      reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: candidate(first).candidateVersion }, test.dependencies),
      reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: candidate(second).candidateVersion }, test.dependencies),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(test.writes).toHaveLength(1);
  });

  it("refuses exact and stale active decisions plus invalid corrections without writing", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    for (const action of ["approve", "reject"] as const) {
      const prior = action === "approve" ? approval("prior", current) : {
        ...approval("prior", current), action: "reject" as const, reason: "prior rejection", set: undefined,
      };
      const normalizedPrior = action === "approve" ? prior : JSON.parse(JSON.stringify(prior, (_key, value) => value === undefined ? undefined : value));
      const test = setup({ candidates: [selected], rows: [current], ledger: [normalizedPrior] });
      await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies)).rejects.toMatchObject({ code: action === "approve" ? "already_approved" : "already_rejected" });
      expect(test.writes).toHaveLength(0);
    }

    const staleCurrent = row("feedback-1", { snapshot: { newer: true } });
    const staleSelected = candidate(staleCurrent);
    const stale = setup({ candidates: [staleSelected], rows: [staleCurrent], ledger: [approval("old-version", current)] });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: staleSelected.candidateVersion }, stale.dependencies)).rejects.toMatchObject({ code: "stale_review_requires_retirement" });

    const correction = setup({ ledger: [approval("prior", current)] });
    await expect(reviewFeedback({ action: "correct", targetEventId: "missing", operation: "retire", reason: "invalid" }, correction.dependencies)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(correction.writes).toHaveLength(0);
  });

  it("applies the user cap only after the job cap check", async () => {
    const current = row("candidate", { jobId: "free-job", userId: "full-user" });
    const priorRows = [row("old-1", { userId: "full-user" }), row("old-2", { userId: "full-user" }), row("old-3", { userId: "full-user" })];
    const test = setup({ candidates: [candidate(current)], rows: [current, ...priorRows], ledger: priorRows.map((value, index) => approval(`old-${index}`, value)) });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: candidate(current).candidateVersion }, test.dependencies)).rejects.toMatchObject({ code: "user_cap" });
    expect(test.writes).toHaveLength(0);
  });

  it("rejects invalid injected identities and strict candidate JSONL without appending", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    const duplicate = setup({ candidates: [selected, selected], rows: [current] });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, duplicate.dependencies)).rejects.toMatchObject({ code: "candidate_file_invalid" });
    expect(duplicate.writes).toHaveLength(0);

    for (const invalid of ["", "bad-\ud800"] as const) {
      const test = setup({ candidates: [selected], rows: [current] });
      test.dependencies.eventId = vi.fn(() => invalid);
      await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies)).rejects.toMatchObject({ code: "event_identity_invalid" });
      expect(test.writes).toHaveLength(0);
    }
  });

  it("rejects inconsistent private paths before candidate reads and treats an empty run as not found", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    const escaped = setup({ candidates: [selected], rows: [current] });
    escaped.dependencies.ensurePrivateTree = vi.fn(async () => ({ ...paths(), exportsDir: "/external/private" }));
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, escaped.dependencies)).rejects.toMatchObject({ code: "private_tree_failed" });
    expect(escaped.dependencies.readCandidate).not.toHaveBeenCalled();

    const empty = setup({ rows: [current] });
    await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, empty.dependencies)).rejects.toMatchObject({ code: "candidate_missing" });
    expect(empty.writes).toHaveLength(0);
  });

  it("does not depend on inherited Array.prototype.sort while reviewing active approvals", async () => {
    const current = row("feedback-1");
    const occupied = row("occupied");
    const selected = candidate(current);
    const test = setup({ candidates: [selected], rows: [current, occupied], ledger: [approval("occupied", occupied)] });
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
    let invoked = 0;
    Object.defineProperty(Array.prototype, "sort", { configurable: true, writable: true, value() { invoked += 1; throw new Error("PRIVATE_ARRAY_SORT"); } });
    try {
      await expect(reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies)).resolves.toMatchObject({ status: "committed" });
    } finally {
      if (descriptor) Object.defineProperty(Array.prototype, "sort", descriptor);
    }
    expect(invoked).toBe(0);
  });

  it("does not invoke polluted String prototype methods", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    const test = setup({ candidates: [selected], rows: [current] });
    const startsWith = Object.getOwnPropertyDescriptor(String.prototype, "startsWith");
    let invoked = 0;
    Object.defineProperty(String.prototype, "startsWith", { configurable: true, writable: true, value() { invoked += 1; throw new Error("PRIVATE_STRING"); } });
    let result: unknown;
    try {
      result = await reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion }, test.dependencies);
    } finally {
      if (startsWith) Object.defineProperty(String.prototype, "startsWith", startsWith);
    }
    expect(result).toMatchObject({ status: "committed" });
    expect(invoked).toBe(0);
  });

  it("rejects accessors and proxies without invocation or private error leakage", async () => {
    let invoked = 0;
    const accessor = Object.defineProperty({ action: "approve", runId: RUN_ID }, "candidateVersion", { enumerable: true, get() { invoked += 1; throw new Error("PRIVATE_GETTER"); } });
    const test = setup();
    for (const request of [accessor, new Proxy({ action: "approve", runId: RUN_ID, candidateVersion: `sha256:${"a".repeat(64)}` }, { ownKeys() { throw new Error("PRIVATE_PROXY"); } })]) {
      let failure: unknown; try { await reviewFeedback(request as never, test.dependencies); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "review_request_invalid" }); expect(String(failure)).not.toContain("PRIVATE");
    }
    expect(invoked).toBe(0);
  });

  it("closes dependency boundaries and translates private dependency failures", async () => {
    const current = row("feedback-1");
    const selected = candidate(current);
    const request = { action: "approve", runId: RUN_ID, candidateVersion: selected.candidateVersion } as const;
    const base = setup({ candidates: [selected], rows: [current] });
    let invoked = 0;
    const accessor = { ...base.dependencies };
    Object.defineProperty(accessor, "readLedger", { enumerable: true, get() { invoked += 1; throw new Error("PRIVATE_DEP_GETTER"); } });
    for (const dependencies of [accessor, new Proxy(base.dependencies, { ownKeys() { throw new Error("PRIVATE_DEP_PROXY"); } })]) {
      let failure: unknown;
      try { await reviewFeedback(request, dependencies); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "review_request_invalid" });
      expect(String(failure)).not.toContain("PRIVATE");
    }
    expect(invoked).toBe(0);

    const database = setup({ candidates: [selected], rows: [current] });
    database.repository.captureReviewSnapshot.mockRejectedValueOnce(new Error("PRIVATE_DATABASE"));
    let databaseFailure: unknown;
    try { await reviewFeedback(request, database.dependencies); } catch (error) { databaseFailure = error; }
    expect(databaseFailure).toMatchObject({ code: "database_snapshot_failed" });
    expect(String(databaseFailure)).not.toContain("PRIVATE_DATABASE");
    expect(database.writes).toHaveLength(0);

    const persistence = setup({ candidates: [selected], rows: [current] });
    persistence.dependencies.replaceLedger = vi.fn(async () => { throw new Error("PRIVATE_WRITE"); });
    let persistenceFailure: unknown;
    try { await reviewFeedback(request, persistence.dependencies); } catch (error) { persistenceFailure = error; }
    expect(persistenceFailure).toMatchObject({ code: "ledger_write_failed" });
    expect(String(persistenceFailure)).not.toContain("PRIVATE_WRITE");
    expect(persistence.writes).toHaveLength(0);
  });

  it("default candidate reader rejects symlink runs without returning external bytes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-review-")); roots.push(parent);
    const root = join(parent, "corpus"); const privatePaths = await ensurePrivateTree(root);
    const external = join(parent, "external-run"); await mkdir(external, 0o700);
    await writeFile(join(external, "candidates.jsonl"), "PRIVATE_EXTERNAL\n"); await symlink(external, join(privatePaths.exportsDir, RUN_ID));
    const test = setup(); test.dependencies.root = root; delete test.dependencies.ensurePrivateTree; delete test.dependencies.readCandidate;
    let failure: unknown; try { await reviewFeedback({ action: "approve", runId: RUN_ID, candidateVersion: `sha256:${"a".repeat(64)}` }, test.dependencies); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "unsafe_path" }); expect(String(failure)).not.toContain("PRIVATE_EXTERNAL");
  });
});
