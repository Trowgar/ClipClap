import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The whole file runs against a worker whose @clipclap/shared resolves
 * `tagJobError` to undefined.
 *
 * That is not a hypothetical: packages/shared/dist is gitignored and the worker
 * runs the built dist, so any deploy that restarts the worker before
 * `npm run build -w @clipclap/shared` boots exactly this state. Calling the
 * symbol raw would throw a TypeError from INSIDE the catch block whose only job
 * is to persist FAILED - masking the real error and skipping the update, which
 * leaves the job parked in DOWNLOADING/ANALYZING forever. usage.service.ts sums
 * every job that is not FAILED, so that job is billed; the bot delivery waits
 * for DONE or FAILED, so it is never delivered.
 *
 * stage-flow.test.ts covers the healthy direction (real tagJobError -> the
 * "[CODE] message" prefix the UI parses). This file covers the degraded one,
 * and the assertion that matters is not the copy: it is that status FAILED is
 * still written at all.
 */

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  downloadVideo: vi.fn(),
  normalizeSource: vi.fn(),
  analyzeHighlightsV1: vi.fn(),
  analyzeHighlightsV2: vi.fn(),
  uploadFile: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  uploadFile: mocks.uploadFile,
  // the stale-dist worker, reproduced: the export exists on the namespace but
  // carries no function
  tagJobError: undefined,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      update: mocks.jobUpdate,
    },
  },
}));

vi.mock("../analyze-v2", () => ({
  analyzeHighlightsV2: mocks.analyzeHighlightsV2,
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/normalize", () => ({
  normalizeSource: mocks.normalizeSource,
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlightsV1: mocks.analyzeHighlightsV1,
}));

import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { SourceUnavailableError, UnsupportedInputError } from "../processors/errors";
import { safeTagJobError } from "../stages/job-error";
import { runAnalyzeStage } from "../stages/analyze";
import { runDownloadStage } from "../stages/download";

describe("safeTagJobError when the shared build is stale", () => {
  it("degrades to the untagged message instead of throwing", () => {
    // raw `tagJobError(...)` here is a TypeError: not a function
    expect(safeTagJobError("SOURCE_UNAVAILABLE", "yt-dlp could not fetch x")).toBe(
      "yt-dlp could not fetch x"
    );
  });

  it("never throws for any code, so no catch block can be broken by it", () => {
    const codes = [
      "SOURCE_UNAVAILABLE",
      "UNSUPPORTED_INPUT",
      "ANALYSIS_UNAVAILABLE",
    ] as const;
    for (const code of codes) {
      expect(() => safeTagJobError(code, "detail")).not.toThrow();
    }
  });
});

describe("stage failure writes survive a stale shared build", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    vi.stubEnv("ANALYZE_ENGINE", "legacy");
    vi.stubEnv("ANALYZE_V2_PCT", "0");
  });

  it("download still marks the job FAILED, with the untagged prose", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://youtube.com/watch?v=private",
      sourceKey: null,
    });
    const raw =
      "yt-dlp could not fetch https://youtube.com/watch?v=private: Private video";
    mocks.downloadVideo.mockRejectedValue(new SourceUnavailableError(raw));

    // the ORIGINAL error propagates - a TypeError from the catch block would
    // mask it and BullMQ would retry on a lie
    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(SourceUnavailableError);

    // no "[SOURCE_UNAVAILABLE] " prefix is possible here; the point is that the
    // row moved to FAILED, which is what stops the billing and releases the bot
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: raw },
    });
  });

  it("download still marks an unsupported input FAILED", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: null,
      sourceKey: "uploads/u1/audio.m4a",
    });
    const raw = "Audio-only input is not supported - please upload a video file";
    mocks.downloadVideo.mockResolvedValue("/tmp/source.m4a");
    mocks.normalizeSource.mockRejectedValue(new UnsupportedInputError(raw));

    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(UnsupportedInputError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: raw },
    });
  });

  it("analyze still marks the job FAILED, with the untagged prose", async () => {
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });
    const raw =
      "scanner failed on all 4 windows (4/4 windows) - analysis models unavailable";
    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeTechnicalError(raw));

    await expect(
      runAnalyzeStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(AnalyzeTechnicalError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: raw },
    });
  });

  it("never leaves the job in a processing status when tagging is unavailable", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://youtube.com/watch?v=private",
      sourceKey: null,
    });
    mocks.downloadVideo.mockRejectedValue(
      new SourceUnavailableError("could not fetch")
    );

    await runDownloadStage({ jobId: "job1", userId: "u1" }).catch(() => {});

    // usage.service.ts sums everything not FAILED - the last word on this job
    // has to be FAILED or the user is billed for nothing
    const statuses = mocks.jobUpdate.mock.calls.map(
      ([arg]) => (arg as { data: { status?: string } }).data.status
    );
    expect(statuses.at(-1)).toBe("FAILED");
  });
});
