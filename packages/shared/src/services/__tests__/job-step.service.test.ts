import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    jobStep: {
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
    },
  },
}));

import {
  completeJobStep,
  failJobStep,
  startJobStep,
} from "../job-step.service";

describe("job-step.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a step idempotently by jobId and step", async () => {
    await startJobStep("job1", "DOWNLOAD", { source: "url" });

    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { jobId_step: { jobId: "job1", step: "DOWNLOAD" } },
      create: expect.objectContaining({
        jobId: "job1",
        step: "DOWNLOAD",
        status: "RUNNING",
        attempt: 1,
      }),
      update: expect.objectContaining({
        status: "RUNNING",
        attempt: { increment: 1 },
      }),
    });
  });

  it("marks a step complete with output json", async () => {
    await completeJobStep("job1", "DOWNLOAD", { sourceKey: "work/job1.mp4" });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", step: "DOWNLOAD" },
      data: expect.objectContaining({
        status: "DONE",
        outputJson: { sourceKey: "work/job1.mp4" },
      }),
    });
  });

  it("marks a step failed with safe error text", async () => {
    await failJobStep("job1", "DOWNLOAD", new Error("network failed"));

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", step: "DOWNLOAD" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "network failed",
      }),
    });
  });
});
