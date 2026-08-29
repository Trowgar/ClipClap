import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  createPrismaFeedbackLearningRepository,
  type SnapshotRequest,
} from "../feedback-learning/repository";

const UPDATED_FROM = new Date("2026-08-26T00:00:00.000Z");
const UPDATED_TO = new Date("2026-08-29T00:00:00.000Z");

function feedback(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    clipId: `clip-${id}`,
    jobId: `job-${id}`,
    userId: `user-${id}`,
    verdict: "AS_IS",
    note: null,
    snapshot: { title: id },
    evidenceKey: null,
    updatedAt: new Date("2026-08-28T12:00:00.000Z"),
    ...overrides,
  };
}

function fakeClient(input: {
  cohort?: unknown[];
  jobs?: unknown[];
  current?: unknown[];
  candidate?: unknown | null;
  failAt?: "readonly" | "cohort";
}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  let feedbackReads = 0;
  const tx = {
    $executeRawUnsafe: vi.fn(async (statement: string) => {
      calls.push({ name: "readonly", args: statement });
      if (input.failAt === "readonly") throw new Error("database-private-detail");
      return 0;
    }),
    clipFeedback: {
      findMany: vi.fn(async (args: unknown) => {
        feedbackReads += 1;
        calls.push({
          name: input.candidate !== undefined || feedbackReads > 1 ? "current" : "cohort",
          args,
        });
        if (input.failAt === "cohort") throw new Error("database-private-detail");
        return input.candidate !== undefined || feedbackReads > 1
          ? input.current ?? []
          : input.cohort ?? [];
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ name: "candidate", args });
        return input.candidate ?? null;
      }),
    },
    job: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ name: "jobs", args });
        return input.jobs ?? [];
      }),
    },
  };
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
      calls.push({ name: "transaction", args: options });
      return callback(tx);
    }),
  };
  return { client, tx, calls };
}

const request: SnapshotRequest = {
  updatedFrom: UPDATED_FROM,
  updatedTo: UPDATED_TO,
  activeApprovalFeedbackIds: ["outside-cohort", "feedback-1", "outside-cohort"],
};

describe("createPrismaFeedbackLearningRepository", () => {
  it("captures the exact export projection in one read-only repeatable-read transaction", async () => {
    const cohort = [feedback("feedback-1")];
    const jobs = [{ id: "job-feedback-1", transcriptJson: { segments: [] }, transcriptPartial: false }];
    const current = [feedback("outside-cohort", { verdict: "NO" })];
    const fake = fakeClient({ cohort, jobs, current });
    const repository = createPrismaFeedbackLearningRepository(fake.client as never);

    const snapshot = await repository.captureExportSnapshot(request);

    expect(fake.client.$transaction).toHaveBeenCalledTimes(1);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "transaction",
      "readonly",
      "cohort",
      "jobs",
      "current",
    ]);
    expect(fake.calls[0].args).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: expect.any(Number),
    });
    expect(fake.calls[1].args).toBe("SET TRANSACTION READ ONLY");
    expect(fake.calls[2].args).toEqual({
      where: {
        verdict: "AS_IS",
        updatedAt: { gte: UPDATED_FROM, lt: UPDATED_TO },
      },
      select: {
        id: true,
        clipId: true,
        jobId: true,
        userId: true,
        verdict: true,
        note: true,
        snapshot: true,
        evidenceKey: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });
    expect(fake.calls[3].args).toEqual({
      where: { id: { in: ["job-feedback-1"] } },
      select: { id: true, transcriptJson: true, transcriptPartial: true },
      orderBy: { id: "asc" },
    });
    expect(fake.calls[4].args).toEqual({
      where: { id: { in: ["feedback-1", "outside-cohort"] } },
      select: {
        id: true,
        clipId: true,
        jobId: true,
        userId: true,
        verdict: true,
        note: true,
        snapshot: true,
        evidenceKey: true,
        updatedAt: true,
      },
      orderBy: { id: "asc" },
    });
    expect(JSON.stringify(fake.calls)).not.toContain("take");
    expect(snapshot).toEqual({ feedback: cohort, jobs, currentApprovals: current });
    expect(snapshot.feedback).not.toBe(cohort);
    expect(snapshot.feedback[0]).not.toBe(cohort[0]);
  });

  it("handles empty IDs inside the same three-query snapshot without later reads", async () => {
    const fake = fakeClient({});
    const repository = createPrismaFeedbackLearningRepository(fake.client as never);

    const snapshot = await repository.captureExportSnapshot({
      updatedFrom: UPDATED_FROM,
      updatedTo: UPDATED_TO,
      activeApprovalFeedbackIds: [],
    });

    expect(fake.calls.map((call) => call.name)).toEqual([
      "transaction",
      "readonly",
      "cohort",
      "jobs",
      "current",
    ]);
    expect(fake.calls[3].args).toMatchObject({ where: { id: { in: [] } } });
    expect(fake.calls[4].args).toMatchObject({ where: { id: { in: [] } } });
    expect(snapshot).toEqual({ feedback: [], jobs: [], currentApprovals: [] });
    expect(fake.tx.clipFeedback.findMany).toHaveBeenCalledTimes(2);
  });

  it("captures the candidate and every active approval in one consistent review snapshot", async () => {
    const candidate = feedback("candidate");
    const current = [feedback("outside-cohort")];
    const fake = fakeClient({ candidate, current });
    const repository = createPrismaFeedbackLearningRepository(fake.client as never);

    const snapshot = await repository.captureReviewSnapshot({
      candidateFeedbackId: "candidate",
      activeApprovalFeedbackIds: ["outside-cohort"],
    });

    expect(fake.calls.map((call) => call.name)).toEqual([
      "transaction",
      "readonly",
      "candidate",
      "current",
    ]);
    expect(fake.calls[2].args).toEqual({
      where: { id: "candidate" },
      select: {
        id: true,
        clipId: true,
        jobId: true,
        userId: true,
        verdict: true,
        note: true,
        snapshot: true,
        evidenceKey: true,
        updatedAt: true,
      },
    });
    expect(fake.calls[3].args).toMatchObject({
      where: { id: { in: ["outside-cohort"] } },
    });
    expect(snapshot).toEqual({ candidate, currentApprovals: current });
    expect(snapshot.candidate).not.toBe(candidate);
  });

  it("rejects malformed requests before opening a transaction and propagates failures", async () => {
    const invalid = fakeClient({});
    const repository = createPrismaFeedbackLearningRepository(invalid.client as never);
    await expect(
      repository.captureExportSnapshot({
        updatedFrom: UPDATED_TO,
        updatedTo: UPDATED_FROM,
        activeApprovalFeedbackIds: [],
      }),
    ).rejects.toThrow("snapshot_request_invalid");
    expect(invalid.client.$transaction).not.toHaveBeenCalled();

    const failed = fakeClient({ failAt: "cohort" });
    await expect(
      createPrismaFeedbackLearningRepository(failed.client as never).captureExportSnapshot(request),
    ).rejects.toThrow("database-private-detail");
    expect(failed.client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects request proxies, accessors, sparse IDs, and malformed Unicode without invocation", async () => {
    const fake = fakeClient({});
    const repository = createPrismaFeedbackLearningRepository(fake.client as never);
    let invoked = 0;
    const accessor = {
      get updatedFrom() {
        invoked += 1;
        throw new Error("PRIVATE_REQUEST_GETTER");
      },
      updatedTo: UPDATED_TO,
      activeApprovalFeedbackIds: [],
    };
    const idAccessor: unknown[] = [];
    Object.defineProperty(idAccessor, "0", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("PRIVATE_ID_GETTER");
      },
    });
    Object.defineProperty(idAccessor, "length", { value: 1 });
    const requests = [
      accessor,
      new Proxy(request, { get() { throw new Error("PRIVATE_PROXY"); } }),
      { ...request, activeApprovalFeedbackIds: idAccessor },
      { ...request, activeApprovalFeedbackIds: ["bad-\ud800"] },
    ];
    for (const value of requests) {
      let failure: unknown;
      try {
        await repository.captureExportSnapshot(value as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "snapshot_request_invalid" });
      expect(String(failure)).not.toContain("PRIVATE");
    }
    expect(invoked).toBe(0);
    expect(fake.client.$transaction).not.toHaveBeenCalled();
  });

  it("rejects accessor, proxy, extra-key, and duplicate projections stably", async () => {
    const valid = feedback("feedback-1");
    let invoked = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("PRIVATE_ROW_GETTER");
      },
    });
    const cases = [
      { cohort: [accessor] },
      { cohort: [new Proxy(valid, { ownKeys() { throw new Error("PRIVATE_ROW_PROXY"); } })] },
      { cohort: [{ ...valid, extra: "no" }] },
      { cohort: [valid, { ...valid }] },
      {
        cohort: [valid],
        jobs: [
          { id: valid.jobId, transcriptJson: null, transcriptPartial: false },
          { id: valid.jobId, transcriptJson: null, transcriptPartial: false },
        ],
      },
      { cohort: [valid], current: [valid, { ...valid }] },
    ];
    for (const value of cases) {
      const fake = fakeClient(value);
      let failure: unknown;
      try {
        await createPrismaFeedbackLearningRepository(fake.client as never).captureExportSnapshot({
          ...request,
          activeApprovalFeedbackIds: value.current ? [valid.id] : [],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "snapshot_projection_invalid" });
      expect(String(failure)).not.toContain("PRIVATE");
    }
    expect(invoked).toBe(0);
  });

  it("safely preserves semantic-invalid cohort values for row-level normalization", async () => {
    const invalid = {
      ...feedback("invalid"),
      id: "",
      clipId: 42,
      jobId: null,
      userId: undefined,
      verdict: false,
      note: { not: "a string" },
      evidenceKey: 7,
      updatedAt: new Date(Number.NaN),
      snapshot: { invalid: BigInt(1) },
    };
    const valid = feedback("valid");
    const fake = fakeClient({ cohort: [invalid, valid] });

    const snapshot = await createPrismaFeedbackLearningRepository(fake.client as never)
      .captureExportSnapshot({ ...request, activeApprovalFeedbackIds: [] });

    expect(snapshot.feedback).toHaveLength(2);
    expect(snapshot.feedback[0]).toMatchObject({
      id: "",
      clipId: 42,
      jobId: null,
      userId: undefined,
      verdict: false,
      evidenceKey: 7,
    });
    expect(snapshot.feedback[0].snapshot).not.toBe(invalid.snapshot);
    expect(fake.calls[3].args).toMatchObject({ where: { id: { in: ["job-valid"] } } });
  });
});
