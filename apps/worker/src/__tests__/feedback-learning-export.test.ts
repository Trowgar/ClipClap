import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, jsonLine, sha256 } from "../feedback-learning/canonical";
import { exportFeedbackLearning, type ExportDependencies } from "../feedback-learning/export";
import {
  PersistenceIntegrityError,
  type CommitResult,
  type PrivatePaths,
  type RunWrite,
} from "../feedback-learning/persistence";
import type { FeedbackLearningRepository } from "../feedback-learning/repository";
import type { ApprovalEvent, FeedbackProjection, JobProjection } from "../feedback-learning/types";

const UPDATED_FROM = "2026-08-26T00:00:00.000Z";
const UPDATED_TO = "2026-08-29T00:00:00.000Z";
const UPDATED_AT = "2026-08-28T12:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function paths(root = "/private/corpus"): PrivatePaths {
  return {
    root,
    exportsDir: join(root, "exports"),
    ledgerDir: join(root, "ledger"),
    reviewsFile: join(root, "ledger", "reviews.jsonl"),
    lockFile: join(root, "ledger", "reviews.lock"),
  };
}

function feedback(id: string, overrides: Partial<FeedbackProjection> = {}): FeedbackProjection {
  return {
    id,
    clipId: `clip-${id}`,
    jobId: `job-${id}`,
    userId: `user-${id}`,
    verdict: "AS_IS",
    note: null,
    snapshot: {
      title: `Title ${id}`,
      startTime: 1,
      endTime: 2,
      score: 0.8,
      transcript: `Transcript ${id}`,
      language: "en",
      clipKind: "insight",
    },
    evidenceKey: `evidence/${id}`,
    updatedAt: new Date(UPDATED_AT),
    ...overrides,
  };
}

function job(id: string): JobProjection {
  return { id, transcriptJson: { segments: [] }, transcriptPartial: false };
}

function approval(row: FeedbackProjection): ApprovalEvent {
  const snapshotHash = sha256(canonicalJson(row.snapshot));
  return {
    schemaVersion: 1,
    eventId: `event-${row.id}`,
    action: "approve",
    occurredAt: "2026-08-29T10:00:00.000Z",
    candidateVersion: sha256(`${row.id}\n${UPDATED_AT}\n${snapshotHash}`),
    feedbackId: row.id,
    feedbackUpdatedAt: UPDATED_AT,
    snapshotSha256: snapshotHash,
    clipId: row.clipId,
    jobId: row.jobId,
    userId: row.userId,
    set: "eval",
  };
}

function dependencies(input: {
  ledger?: Buffer;
  cohort?: FeedbackProjection[];
  jobs?: JobProjection[];
  current?: FeedbackProjection[];
  commit?: CommitResult;
  databaseError?: Error;
  publishError?: Error;
}) {
  const order: string[] = [];
  const captureExportSnapshot = vi.fn(async (request: unknown) => {
    order.push("database");
    if (input.databaseError) throw input.databaseError;
    return {
      feedback: input.cohort ?? [],
      jobs: input.jobs ?? [],
      currentApprovals: input.current ?? [],
    };
  });
  const repository: FeedbackLearningRepository = {
    captureExportSnapshot,
    captureReviewSnapshot: vi.fn(async () => ({ candidate: null, currentApprovals: [] })),
  };
  const publishRunAtomically = vi.fn(async (_publication: RunWrite) => {
    order.push("publish");
    if (input.publishError) throw input.publishError;
    return input.commit ?? { status: "committed" as const };
  });
  const injected: ExportDependencies = {
    repository,
    root: "/private/corpus",
    ensurePrivateTree: vi.fn(async () => {
      order.push("ensure");
      return paths();
    }),
    withCorpusLock: vi.fn(async (_lockPath, operation) => {
      order.push("lock-enter");
      const result = await operation();
      order.push("lock-exit");
      return result;
    }),
    readLedger: vi.fn(async () => {
      order.push("ledger-read");
      return Buffer.from(input.ledger ?? Buffer.alloc(0));
    }),
    publishRunAtomically,
  };
  return { injected, order, captureExportSnapshot, publishRunAtomically };
}

describe("exportFeedbackLearning", () => {
  it("captures ledger under lock, releases it, snapshots DB once, and publishes four files", async () => {
    const old = feedback("outside-cohort");
    const fresh = feedback("feedback-1");
    const setup = dependencies({
      ledger: jsonLine(approval(old)),
      cohort: [fresh],
      jobs: [job(fresh.jobId)],
      current: [old],
    });

    const result = await exportFeedbackLearning(
      { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
      setup.injected,
    );

    expect(setup.order).toEqual([
      "ensure",
      "lock-enter",
      "ledger-read",
      "lock-exit",
      "database",
      "publish",
    ]);
    expect(setup.captureExportSnapshot).toHaveBeenCalledTimes(1);
    expect(setup.captureExportSnapshot).toHaveBeenCalledWith({
      updatedFrom: new Date(UPDATED_FROM),
      updatedTo: new Date(UPDATED_TO),
      activeApprovalFeedbackIds: ["outside-cohort"],
    });
    expect(setup.publishRunAtomically).toHaveBeenCalledTimes(1);
    const publication = setup.publishRunAtomically.mock.calls[0][0];
    expect(Object.keys(publication.files).sort()).toEqual([
      "candidates.jsonl",
      "candidates.md",
      "exclusions.jsonl",
      "run.json",
    ]);
    const manifest = JSON.parse(Buffer.from(publication.files["run.json"]).toString("utf8"));
    expect(publication).toMatchObject({
      paths: paths(),
      runId: manifest.runId,
      runDigest: manifest.runDigest,
    });
    expect(manifest.counts).toMatchObject({ queried: 1, selected: 1, freshApprovals: 1 });
    expect(result).toEqual({
      operation: "export",
      runId: manifest.runId,
      status: "committed",
      counts: manifest.counts,
    });
    expect(JSON.stringify(result)).not.toContain("feedback-1");
    expect(JSON.stringify(result)).not.toContain("Transcript");
  });

  for (const status of [
    "committed",
    "noop",
    "committed_durability_uncertain",
    "indeterminate",
  ] as const) {
    it(`returns the safe ${status} publication status`, async () => {
      const setup = dependencies({ commit: { status } });
      const result = await exportFeedbackLearning(
        { targetSet: "holdout", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO, limit: 7 },
        setup.injected,
      );
      expect(result.status).toBe(status);
      expect(result.operation).toBe("export");
      expect(Object.keys(result).sort()).toEqual(["counts", "operation", "runId", "status"]);
    });
  }

  it("freezes the first ledger read even if the source changes after unlock", async () => {
    const source: { ledger: Buffer } = { ledger: Buffer.alloc(0) };
    const setup = dependencies(source);
    setup.captureExportSnapshot.mockImplementationOnce(async (request) => {
      source.ledger = jsonLine(approval(feedback("late")));
      return { feedback: [], jobs: [], currentApprovals: [] };
    });

    await exportFeedbackLearning(
      { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
      setup.injected,
    );

    expect(setup.injected.readLedger).toHaveBeenCalledTimes(1);
    expect(setup.captureExportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ activeApprovalFeedbackIds: [] }),
    );
  });

  it("stops invalid options and invalid ledger before database or publication", async () => {
    const invalidOptions = dependencies({});
    await expect(
      exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_TO, updatedTo: UPDATED_FROM },
        invalidOptions.injected,
      ),
    ).rejects.toThrow("export_request_invalid");
    expect(invalidOptions.injected.ensurePrivateTree).not.toHaveBeenCalled();

    const invalidLedger = dependencies({ ledger: Buffer.from("not-json\n") });
    await expect(
      exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        invalidLedger.injected,
      ),
    ).rejects.toThrow("invalid_json");
    expect(invalidLedger.captureExportSnapshot).not.toHaveBeenCalled();
    expect(invalidLedger.publishRunAtomically).not.toHaveBeenCalled();
  });

  it("publishes nothing on database failure and propagates stable integrity failure", async () => {
    const databaseFailure = dependencies({ databaseError: new Error("db-failed") });
    await expect(
      exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        databaseFailure.injected,
      ),
    ).rejects.toThrow("db-failed");
    expect(databaseFailure.publishRunAtomically).not.toHaveBeenCalled();

    const integrity = dependencies({ publishError: new PersistenceIntegrityError() });
    await expect(
      exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        integrity.injected,
      ),
    ).rejects.toMatchObject({ code: "run_integrity", message: "run_integrity" });
  });

  it("uses no-follow regular-file ledger reads and returns a path-free error", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-learning-export-"));
    roots.push(root);
    const privatePaths = paths(root);
    await mkdir(privatePaths.ledgerDir, { recursive: true });
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, "");
    await symlink(outside, privatePaths.reviewsFile);
    const setup = dependencies({});
    setup.injected.root = root;
    setup.injected.ensurePrivateTree = vi.fn(async () => privatePaths);
    delete setup.injected.readLedger;

    let failure: unknown;
    try {
      await exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        setup.injected,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ledger_read_failed", message: "ledger_read_failed" });
    expect(String(failure)).not.toContain(root);
    expect(setup.captureExportSnapshot).not.toHaveBeenCalled();
  });
});
