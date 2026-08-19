import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseNextQueued: vi.fn(async () => []),
}));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clipclap/shared")>();
  return {
    ...actual,
    jobService: { ...actual.jobService, releaseNextQueued: mocks.releaseNextQueued },
    releaseNextQueued: mocks.releaseNextQueued,
  };
});

import { maybeReleaseAfterStageEvent } from "../worker-app";

/**
 * A slot frees in exactly two situations: the pipeline ENDED well (finalize
 * completed) or it ENDED badly (any stage exhausted its BullMQ attempts).
 * Everything else - a mid-pipeline stage completing, a failure that will be
 * retried - must not release, or the queue would overshoot the limit while
 * the pipeline is still alive.
 */
describe("maybeReleaseAfterStageEvent", () => {
  beforeEach(() => {
    mocks.releaseNextQueued.mockClear();
    mocks.releaseNextQueued.mockResolvedValue([]);
  });

  it("releases when finalize completes", async () => {
    await maybeReleaseAfterStageEvent("finalize", "completed", {
      data: { jobId: "j1", userId: "u1" },
    } as never);
    expect(mocks.releaseNextQueued).toHaveBeenCalledWith("u1");
  });

  it("does NOT release when a mid-pipeline stage completes", async () => {
    await maybeReleaseAfterStageEvent("download", "completed", {
      data: { jobId: "j1", userId: "u1" },
    } as never);
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
  });

  it("releases on a TERMINAL failure of any stage", async () => {
    await maybeReleaseAfterStageEvent("download", "failed", {
      data: { jobId: "j1", userId: "u1" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as never);
    expect(mocks.releaseNextQueued).toHaveBeenCalledWith("u1");
  });

  // Mutation: relax the terminal check (>= to >) -> this or the previous test
  // goes red.
  it("does NOT release on a failure that will be retried", async () => {
    await maybeReleaseAfterStageEvent("transcribe", "failed", {
      data: { jobId: "j1", userId: "u1" },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as never);
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
  });

  it("treats missing opts.attempts as 1 - a single-attempt failure is terminal", async () => {
    await maybeReleaseAfterStageEvent("analyze", "failed", {
      data: { jobId: "j1", userId: "u1" },
      attemptsMade: 1,
      opts: {},
    } as never);
    expect(mocks.releaseNextQueued).toHaveBeenCalledWith("u1");
  });

  it("survives a missing job, a missing userId, and a throwing release", async () => {
    await maybeReleaseAfterStageEvent("finalize", "completed", undefined);
    await maybeReleaseAfterStageEvent("finalize", "completed", {
      data: {},
    } as never);
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
    mocks.releaseNextQueued.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      maybeReleaseAfterStageEvent("finalize", "completed", {
        data: { jobId: "j1", userId: "u1" },
      } as never)
    ).resolves.toBeUndefined();
    err.mockRestore();
  });
});
