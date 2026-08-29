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
import {
  createPrismaFeedbackLearningRepository,
  type FeedbackLearningRepository,
} from "../feedback-learning/repository";
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

  it("publishes nothing on database failure and preserves stable integrity failure", async () => {
    const databaseFailure = dependencies({ databaseError: new Error("db-failed") });
    await expect(
      exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        databaseFailure.injected,
      ),
    ).rejects.toMatchObject({ code: "database_snapshot_failed" });
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

  it("captures dependency descriptors once and rejects accessors or proxies without invocation", async () => {
    const setup = dependencies({});
    let invoked = 0;
    const accessor = { ...setup.injected };
    Object.defineProperty(accessor, "repository", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("PRIVATE_DEPENDENCY_GETTER");
      },
    });
    const values = [
      accessor,
      new Proxy(setup.injected, { ownKeys() { throw new Error("PRIVATE_DEPENDENCY_PROXY"); } }),
      { ...setup.injected, extra: true },
    ];
    for (const value of values) {
      let failure: unknown;
      try {
        await exportFeedbackLearning(
          { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
          value as never,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "export_request_invalid" });
      expect(String(failure)).not.toContain("PRIVATE");
    }
    expect(invoked).toBe(0);
  });

  it.each([
    ["ensure", "private_tree_failed"],
    ["database", "database_snapshot_failed"],
    ["publish", "publish_failed"],
  ] as const)("masks unknown %s failures with stable code", async (stage, code) => {
    const setup = dependencies({
      databaseError: stage === "database" ? new Error("PRIVATE_DATABASE") : undefined,
      publishError: stage === "publish" ? new Error("PRIVATE_PUBLISH") : undefined,
    });
    if (stage === "ensure") {
      setup.injected.ensurePrivateTree = vi.fn(async () => {
        throw new Error("PRIVATE_TREE_PATH");
      });
    }
    let failure: unknown;
    try {
      await exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        setup.injected,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code, message: code });
    expect(String(failure)).not.toContain("PRIVATE");
  });

  it("rejects accessor/proxy snapshots and duplicate cohort, Job, or current IDs before publish", async () => {
    const valid = feedback("feedback-duplicate");
    const accessor = { ...valid };
    let invoked = 0;
    Object.defineProperty(accessor, "jobId", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("PRIVATE_SNAPSHOT_GETTER");
      },
    });
    const currentApproval = approval(valid);
    const cases = [
      { cohort: [accessor as FeedbackProjection] },
      { cohort: [new Proxy(valid, { ownKeys() { throw new Error("PRIVATE_PROXY"); } })] },
      { cohort: [valid, { ...valid }] },
      { cohort: [valid], jobs: [job(valid.jobId), job(valid.jobId)] },
      {
        ledger: jsonLine(currentApproval),
        current: [valid, { ...valid }],
      },
    ];
    for (const value of cases) {
      const setup = dependencies(value);
      let failure: unknown;
      try {
        await exportFeedbackLearning(
          { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
          setup.injected,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "projection_failed" });
      expect(String(failure)).not.toContain("PRIVATE");
      expect(setup.publishRunAtomically).not.toHaveBeenCalled();
    }
    expect(invoked).toBe(0);
  });

  it("keeps a malformed-Unicode cohort row as invalid_row while publishing the valid row", async () => {
    const good = feedback("feedback-good");
    const bad = feedback("feedback-bad", { note: "bad-\ud800" });
    const setup = dependencies({
      cohort: [bad, good],
      jobs: [job(bad.jobId), job(good.jobId)],
    });

    const result = await exportFeedbackLearning(
      { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
      setup.injected,
    );

    expect(result.counts).toMatchObject({ queried: 2, selected: 1, excluded: 1 });
    const publication = setup.publishRunAtomically.mock.calls[0]?.[0];
    expect(Buffer.from(publication?.files["exclusions.jsonl"] ?? []).toString("utf8")).toContain(
      '"detailCode":"projection_invalid"',
    );
  });

  it.each([
    ["lock", "lock_unavailable"],
    ["read", "ledger_read_failed"],
  ] as const)("masks unknown %s failures without private details", async (stage, code) => {
    const setup = dependencies({});
    if (stage === "lock") {
      setup.injected.withCorpusLock = vi.fn(async () => { throw new Error("PRIVATE_LOCK"); });
    } else {
      setup.injected.readLedger = vi.fn(async () => { throw new Error("PRIVATE_LEDGER_PATH"); });
    }
    let failure: unknown;
    try {
      await exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        setup.injected,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code, message: code });
    expect(String(failure)).not.toContain("PRIVATE");
    expect(setup.captureExportSnapshot).not.toHaveBeenCalled();
  });

  it("does not invoke poisoned Array or Map prototype behavior on private snapshot data", async () => {
    const row = feedback("feedback-poison", { note: "PRIVATE_POISON_NOTE" });
    const baselineSetup = dependencies({ cohort: [row], jobs: [job(row.jobId)] });
    const baseline = await exportFeedbackLearning(
      { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
      baselineSetup.injected,
    );
    let poisonedPublication: RunWrite | undefined;
    const poisonedPaths = paths();
    const poisonedJob = job(row.jobId);
    const ensuredTree = Promise.resolve(poisonedPaths);
    const poisonedDependencies: ExportDependencies = {
      repository: {
        captureExportSnapshot: async () => ({ feedback: [row], jobs: [poisonedJob], currentApprovals: [] }),
        captureReviewSnapshot: async () => ({ candidate: null, currentApprovals: [] }),
      },
      root: "/private/corpus",
      ensurePrivateTree: () => ensuredTree,
      withCorpusLock: async (_path, operation) => operation(),
      readLedger: async () => Buffer.alloc(0),
      publishRunAtomically: async (publication) => {
        poisonedPublication = publication;
        return { status: "committed" };
      },
    };
    const arrayTargets: PropertyKey[] = ["map", "filter", "sort", Symbol.iterator, "0"];
    const arrayOriginals = arrayTargets.map((name) => Object.getOwnPropertyDescriptor(Array.prototype, name));
    const mapTargets = ["get", "set"] as const;
    const mapOriginals = mapTargets.map((name) => Object.getOwnPropertyDescriptor(Map.prototype, name));
    let invoked = 0;
    let observed = "";
    let result: Awaited<ReturnType<typeof exportFeedbackLearning>> | undefined;
    let caught: unknown;
    try {
      for (let index = 0; index < arrayTargets.length - 1; index += 1) {
        const target = arrayTargets[index];
        Object.defineProperty(Array.prototype, target, {
          configurable: true,
          value: function (...args: unknown[]) {
            invoked += 1;
            observed += `array:${String(target)}:${String(args[0] ?? "")}`;
            throw new Error("PRIVATE_ARRAY_POISON");
          },
          writable: true,
        });
      }
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set(value) { invoked += 1; observed += `setter:${String(value)}`; throw new Error("PRIVATE_ARRAY_SETTER"); },
      });
      for (let index = 0; index < mapTargets.length; index += 1) {
        const target = mapTargets[index];
        Object.defineProperty(Map.prototype, target, {
          configurable: true,
          value: function (...args: unknown[]) {
            invoked += 1;
            observed += `map:${target}:${String(args[0] ?? "")}`;
            return target === "get" ? undefined : this;
          },
          writable: true,
        });
      }
      result = await exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        poisonedDependencies,
      );
    } catch (error) {
      caught = error;
    } finally {
      for (let index = 0; index < arrayTargets.length; index += 1) {
        const descriptor = arrayOriginals[index];
        if (descriptor === undefined) Reflect.deleteProperty(Array.prototype, arrayTargets[index]);
        else Object.defineProperty(Array.prototype, arrayTargets[index], descriptor);
      }
      for (let index = 0; index < mapTargets.length; index += 1) {
        const descriptor = mapOriginals[index];
        if (descriptor === undefined) Reflect.deleteProperty(Map.prototype, mapTargets[index]);
        else Object.defineProperty(Map.prototype, mapTargets[index], descriptor);
      }
    }
    expect(observed).toBe("");
    expect(invoked).toBe(0);
    expect(observed).not.toContain("PRIVATE_POISON_NOTE");
    expect(caught).toBeUndefined();
    expect(result).toEqual(baseline);
    const baselinePublication = baselineSetup.publishRunAtomically.mock.calls[0]?.[0];
    expect(poisonedPublication?.files).toEqual(baselinePublication?.files);
  });

  it("publishes one invalid_row when wired to a real repository adapter with malformed cohort JSON", async () => {
    const malformed = feedback("feedback-malformed", { snapshot: { invalid: BigInt(1) } });
    const valid = feedback("feedback-valid");
    let feedbackReads = 0;
    const transaction = {
      $executeRawUnsafe: async () => 0,
      clipFeedback: {
        findMany: async () => {
          feedbackReads += 1;
          return feedbackReads === 1 ? [malformed, valid] : [];
        },
        findUnique: async () => null,
      },
      job: { findMany: async () => [job(malformed.jobId), job(valid.jobId)] },
    };
    const repository = createPrismaFeedbackLearningRepository({
      $transaction: async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    } as never);
    const setup = dependencies({});
    setup.injected.repository = repository;

    const result = await exportFeedbackLearning(
      { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
      setup.injected,
    );

    expect(result.counts).toMatchObject({ queried: 2, selected: 1, excluded: 1 });
    const publication = setup.publishRunAtomically.mock.calls[0]?.[0];
    expect(Buffer.from(publication?.files["exclusions.jsonl"] ?? []).toString("utf8")).toContain(
      '"reason":"invalid_row","detailCode":"snapshot_not_json"',
    );
  });

  it.each([
    ["ensure", "private_tree_failed"],
    ["lock", "lock_unavailable"],
    ["database", "database_snapshot_failed"],
    ["projection", "projection_failed"],
    ["publish", "publish_failed"],
  ] as const)("classifies a thrown hostile Proxy at %s without invoking its traps", async (stage, code) => {
    let invoked = 0;
    const thrownProxy = new Proxy(Object.create(null), {
      getPrototypeOf() { invoked += 1; throw new Error("PRIVATE_PROXY_TRAP"); },
      get() { invoked += 1; throw new Error("PRIVATE_PROXY_GET"); },
    });
    const setup = dependencies({});
    if (stage === "ensure") setup.injected.ensurePrivateTree = vi.fn(async () => { throw thrownProxy; });
    if (stage === "lock") setup.injected.withCorpusLock = vi.fn(async () => { throw thrownProxy; });
    if (stage === "database") setup.captureExportSnapshot.mockImplementationOnce(async () => { throw thrownProxy; });
    if (stage === "projection") {
      const trigger = feedback("feedback-proxy-stage", {
        updatedAt: new Proxy(new Date(UPDATED_AT), {
          getPrototypeOf() { throw thrownProxy; },
        }),
      });
      setup.captureExportSnapshot.mockImplementationOnce(async () => ({ feedback: [trigger], jobs: [], currentApprovals: [] }));
    }
    if (stage === "publish") setup.injected.publishRunAtomically = vi.fn(async () => { throw thrownProxy; });
    let failure: unknown;
    try {
      await exportFeedbackLearning(
        { targetSet: "eval", updatedFrom: UPDATED_FROM, updatedTo: UPDATED_TO },
        setup.injected,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code, message: code });
    expect(String(failure)).not.toContain("PRIVATE");
    expect(invoked).toBe(0);
  });
});
