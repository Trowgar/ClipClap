import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    getRepeatableJobs = mocks.getRepeatableJobs;
    removeRepeatableByKey = mocks.removeRepeatableByKey;
  },
}));

vi.mock("../redis", () => ({ getRedis: () => ({}) }));

import { registerReferralSchedules, RETENTION_SWEEP_JOB } from "../referral-queue";

describe("registerReferralSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRepeatableJobs.mockResolvedValue([]);
  });

  it("registers the retention sweep hourly, keyed so re-registration is a no-op", async () => {
    await registerReferralSchedules();

    expect(mocks.add).toHaveBeenCalledWith(
      RETENTION_SWEEP_JOB,
      {},
      { repeat: { pattern: "0 * * * *" }, jobId: RETENTION_SWEEP_JOB }
    );
  });
});
