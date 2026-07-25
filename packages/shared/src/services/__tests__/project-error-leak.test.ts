import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: { job: { findMany: mocks.jobFindMany } },
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
}));

import { getProjectDetail, getUserProjects } from "../project.service";

/**
 * The leak this guards is not "a component prints job.error" - it is that the
 * dashboard, the projects list and the project page each do
 * JSON.parse(JSON.stringify(project)) and hand the whole DTO to a client
 * component, so every field on these objects lands in the RSC payload whether
 * or not anything renders it. The fix removed `error` from both DTOs; without a
 * test, re-adding it is a one-line regression that no component review would
 * catch, because no component has to change.
 *
 * Both entry points are exercised on purpose - getUserProjects for the summary
 * mapper and getProjectDetail for the project page - because either one can
 * regain the field on its own.
 */
const RAW = "critic produced 0 usable verdicts for 12 candidates - nothing was judged";

const failedJob = (error: string | null) => ({
  id: "job1",
  userId: "u1",
  sourceUrl: null,
  sourceKey: "uploads/u1/job1.mp4",
  thumbnailKey: null,
  originalFilename: "video.mp4",
  status: "FAILED",
  error,
  sourceDurationSec: 120,
  clipsGenerated: 0,
  noClipsReason: null,
  transcriptPartial: false,
  createdAt: new Date("2026-07-24T00:00:00.000Z"),
  clips: [],
});

describe("project DTOs never carry raw engine prose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockImplementation(async (k: string) => `signed:${k}`);
  });

  it("exposes errorCode and no raw error field on a summary", async () => {
    mocks.jobFindMany.mockResolvedValue([failedJob(`[ANALYSIS_UNAVAILABLE] ${RAW}`)]);

    const [summary] = await getUserProjects("u1");

    expect(summary.errorCode).toBe("ANALYSIS_UNAVAILABLE");
    expect(summary).not.toHaveProperty("error");
    // the whole serialized payload, not just the fields we remembered to check
    expect(JSON.stringify(summary)).not.toContain("critic");
    expect(JSON.stringify(summary)).not.toContain(RAW);
  });

  it("exposes errorCode and no raw error field on the project detail", async () => {
    mocks.jobFindMany.mockResolvedValue([failedJob(`[SOURCE_UNAVAILABLE] ${RAW}`)]);

    const detail = await getProjectDetail("job1", "u1");

    expect(detail?.errorCode).toBe("SOURCE_UNAVAILABLE");
    expect(detail).not.toHaveProperty("error");
    expect(JSON.stringify(detail)).not.toContain("critic");
    expect(JSON.stringify(detail)).not.toContain(RAW);
  });

  it("reports an untagged failure as no code rather than leaking the text", async () => {
    mocks.jobFindMany.mockResolvedValue([failedJob(RAW)]);

    const [summary] = await getUserProjects("u1");
    expect(summary.errorCode).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("verdicts");

    mocks.jobFindMany.mockResolvedValue([failedJob(RAW)]);
    const detail = await getProjectDetail("job1", "u1");
    expect(detail?.errorCode).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("verdicts");
  });

  it("leaves errorCode null for a job that never failed", async () => {
    mocks.jobFindMany.mockResolvedValue([{ ...failedJob(null), status: "DONE" }]);

    const [summary] = await getUserProjects("u1");
    expect(summary.errorCode).toBeNull();
  });
});
