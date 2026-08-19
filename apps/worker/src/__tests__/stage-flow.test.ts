import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  downloadVideo: vi.fn(),
  normalizeSource: vi.fn(),
  transcribeVideo: vi.fn(),
  analyzeHighlightsV1: vi.fn(),
  uploadFile: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdate: vi.fn(),
  jobStepFindUnique: vi.fn(),
  analyzeHighlightsV2: vi.fn(),
  probeLocalFile: vi.fn(),
  findFreeCharge: vi.fn(),
  freeBalanceSeconds: vi.fn(),
  reviseFreeChargeSeconds: vi.fn(),
  refundFailedJob: vi.fn(),
  refundZeroClipJob: vi.fn(),
  trueUpFreeCost: vi.fn(),
}));

vi.mock("@clipclap/shared", async () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  uploadFile: mocks.uploadFile,
  // real implementation: the stored prefix IS the contract the bot and the web
  // app parse, so a mock format would test nothing
  tagJobError: (
    await vi.importActual<typeof import("@clipclap/shared/lib/job-error")>(
      "@clipclap/shared/lib/job-error"
    )
  ).tagJobError,
  // real implementation: the download stage's flap-wait gate calls this
  // unconditionally (see isFlapFailure in stages/download.ts), even on the
  // 2-arg calls this suite makes with no BullMQ job handle - a mock module
  // missing the export throws before the gate ever gets to check for one.
  isBotCheckFailure: (
    await vi.importActual<typeof import("@clipclap/shared/lib/ytdlp-proxy")>(
      "@clipclap/shared/lib/ytdlp-proxy"
    )
  ).isBotCheckFailure,
  probeLocalFile: mocks.probeLocalFile,
  // Pricing is not what this suite tests. The two lookups are the real ones -
  // they are pure - but loadModelPrices is stubbed to an empty table, below the
  // spread so it wins, because the real one reads process.env and would make
  // this suite's telemetry depend on whether MODEL_PRICES_JSON happens to be set.
  ...(await vi.importActual<
    typeof import("@clipclap/shared/config/model-prices")
  >("@clipclap/shared/config/model-prices")),
  loadModelPrices: () => ({ tokensPerMillionUsd: {}, audioPerMinuteUsd: {} }),
  findFreeCharge: mocks.findFreeCharge,
  freeBalanceSeconds: mocks.freeBalanceSeconds,
  reviseFreeChargeSeconds: mocks.reviseFreeChargeSeconds,
  refundFailedJob: mocks.refundFailedJob,
  refundZeroClipJob: mocks.refundZeroClipJob,
  trueUpFreeCost: mocks.trueUpFreeCost,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      findUnique: mocks.jobFindUnique,
      update: mocks.jobUpdate,
    },
    // finalize reads the ANALYZE step for the per-model token breakdown.
    jobStep: { findUnique: mocks.jobStepFindUnique },
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

vi.mock("../processors/transcribe", () => ({
  transcribeVideo: mocks.transcribeVideo,
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlightsV1: mocks.analyzeHighlightsV1,
}));

import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { transcriptionModel } from "../model-selection";
import {
  SourceTooLargeError,
  SourceUnavailableError,
  UnsupportedInputError,
} from "../processors/errors";
import { runAnalyzeStage } from "../stages/analyze";
import { runDownloadStage } from "../stages/download";
import {
  readAnalysisUsageColumn,
  runFinalizeStage,
} from "../stages/finalize";
import { runTranscribeStage } from "../stages/transcribe";

describe("stage handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    // The download stage now re-measures every source. Default it to a readable
    // file on a paying account (no CHARGE row), so these tests keep asserting
    // the download path and the free re-check gets its own file.
    mocks.probeLocalFile.mockResolvedValue({
      ok: true,
      durationSec: 60,
      title: "Upload",
    });
    mocks.findFreeCharge.mockResolvedValue(null);
    mocks.jobFindUnique.mockResolvedValue(null);
    mocks.jobStepFindUnique.mockResolvedValue(null);
    // pin the engine: these tests assert the legacy analyze path and must not
    // depend on the ambient ANALYZE_ENGINE of the environment they run in
    vi.stubEnv("ANALYZE_ENGINE", "legacy");
    vi.stubEnv("ANALYZE_V2_PCT", "0");
  });

  it("download persists a source artifact and enqueues transcribe", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://example.com/video",
      sourceKey: null,
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");
    mocks.normalizeSource.mockResolvedValue({
      path: "/tmp/source.mp4",
      action: "none",
    });

    await runDownloadStage({ jobId: "job1", userId: "u1" });

    expect(mocks.startJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", {
      jobId: "job1",
      userId: "u1",
    });
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      "work/u1/job1/source.mp4",
      "/tmp/source.mp4",
      "video/mp4"
    );
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        sourceArtifactKey: "work/u1/job1/source.mp4",
        status: "DOWNLOADING",
      }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("transcribe", {
      jobId: "job1",
      userId: "u1",
    });

    // A BullMQ retry re-runs the whole stage from scratch. The key has to be
    // derived, not random, so a retry overwrites its own object instead of
    // orphaning it - assert that a second run uploads to the same key.
    const firstUploadKey = mocks.uploadFile.mock.calls[0][0];
    await runDownloadStage({ jobId: "job1", userId: "u1" });
    const secondUploadKey = mocks.uploadFile.mock.calls[1][0];
    expect(secondUploadKey).toBe(firstUploadKey);
  });

  it("transcribe stores transcript json and enqueues analyze", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceArtifactKey: "work/u1/job1/source.mp4",
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");
    mocks.transcribeVideo.mockResolvedValue({
      transcription: {
        text: "hello",
        segments: [{ start: 0, end: 10, text: "hello" }],
      },
      coverage: 1,
      partial: false,
      missingRanges: [],
    });

    await runTranscribeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.downloadVideo).toHaveBeenCalledWith(
      undefined,
      "work/u1/job1/source.mp4"
    );
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "TRANSCRIBING",
        transcription: "hello",
        transcriptJson: {
          text: "hello",
          segments: [{ start: 0, end: 10, text: "hello" }],
        },
      }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("analyze", {
      jobId: "job1",
      userId: "u1",
    });
  });

  it("analyze stores highlights and enqueues render", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 0, end: 10, text: "hello" }],
      },
    });
    mocks.analyzeHighlightsV1.mockResolvedValue([
      { start: 0, end: 10, title: "Clip", reason: "Hook" },
    ]);

    await runAnalyzeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "ANALYZING",
        highlights: [{ start: 0, end: 10, title: "Clip", reason: "Hook" }],
      }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("render", {
      jobId: "job1",
      userId: "u1",
      mode: "clips",
    });
  });

  it("tags a technical analyze failure with a user-facing code", async () => {
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });
    const raw = "scanner failed on all 4 windows (4/4 windows) - analysis models unavailable";
    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeTechnicalError(raw));

    await expect(
      runAnalyzeStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(AnalyzeTechnicalError);

    // the raw diagnostics survive in the DB behind the code
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[ANALYSIS_UNAVAILABLE] ${raw}` },
    });
  });

  it("tags a refusal-shaped analyze failure with the same retryable code", async () => {
    // Replaces 6434d4d's "tags a repeated model refusal with its own code".
    // There is no second code any more: whatever kind of hole left candidates
    // unjudged, the stage knows only that nothing was judged, and the honest
    // handling of that is the same one - fail, bill nothing, retry.
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });
    const raw =
      "no clip survived and 1 of 2 candidate(s) never got a verdict (omitted 0, refused 1, truncated 0, invariant 0) - the empty result is not a complete answer";
    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeTechnicalError(raw));

    await expect(runAnalyzeStage({ jobId: "job1", userId: "u1" })).rejects.toThrow();

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[ANALYSIS_UNAVAILABLE] ${raw}` },
    });
  });

  it("never cancels the BullMQ attempts for an analyze failure", async () => {
    // Replaces 6434d4d's "stops BullMQ from retrying a repeated refusal".
    // job.shouldRetryJob() skips the remaining attempts when `err instanceof
    // UnrecoverableError || err.name === "UnrecoverableError"`, and the stage
    // must hand it nothing of the sort. The retry is the whole reason a
    // technical failure is not billed, and the stage cannot tell a settled
    // refusal from a 503 that the fallback model happened to refuse - so it
    // does not try, and every analyze failure keeps all three attempts.
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });

    mocks.analyzeHighlightsV2.mockRejectedValue(
      new AnalyzeTechnicalError("no clip survived and 2 of 2 candidate(s) never got a verdict (omitted 0, refused 2, truncated 0, invariant 0)")
    );
    const refusal = await runAnalyzeStage({ jobId: "job1", userId: "u1" }).catch((e) => e);
    expect(refusal.name).not.toBe("UnrecoverableError");
    expect(refusal).toBeInstanceOf(AnalyzeTechnicalError);
    // the diagnostics still travel with it
    expect(refusal.message).toContain("refused 2");

    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeTechnicalError("truncated 2"));
    const technical = await runAnalyzeStage({ jobId: "job1", userId: "u1" }).catch((e) => e);
    expect(technical.name).not.toBe("UnrecoverableError");
    expect(technical).toBeInstanceOf(AnalyzeTechnicalError);
  });

  it("leaves a non-technical analyze failure untagged, so the UI shows generic copy", async () => {
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });
    mocks.analyzeHighlightsV2.mockRejectedValue(new Error("connection reset"));

    await expect(runAnalyzeStage({ jobId: "job1", userId: "u1" })).rejects.toThrow();

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: "connection reset" },
    });
  });

  it("tags an audio-only upload as unsupported input", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: null,
      sourceKey: "uploads/u1/audio.m4a",
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.m4a");
    const raw = "Audio-only input is not supported - please upload a video file";
    mocks.normalizeSource.mockRejectedValue(new UnsupportedInputError(raw));

    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(UnsupportedInputError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[UNSUPPORTED_INPUT] ${raw}` },
    });
  });

  it("tags an unfetchable link as an unavailable source", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://youtube.com/watch?v=private",
      sourceKey: null,
    });
    const raw = "yt-dlp could not fetch https://youtube.com/watch?v=private: Private video";
    mocks.downloadVideo.mockRejectedValue(new SourceUnavailableError(raw));

    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(SourceUnavailableError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[SOURCE_UNAVAILABLE] ${raw}` },
    });
  });

  it("tags an oversized source with its own code, not the unavailable bucket", async () => {
    // SourceTooLargeError is a sibling of SourceUnavailableError, not a
    // subclass, so an instanceof chain that checks the wrong one first would
    // silently send an over-the-cap VOD the "it may be private, upload the file
    // directly" copy - advice that cannot work, since the same 2 GB cap applies
    // to uploads.
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://youtube.com/watch?v=longvod",
      sourceKey: null,
    });
    const raw =
      "yt-dlp declined https://youtube.com/watch?v=longvod: File is larger than max-filesize (5368709120 bytes > 2147483648 bytes)";
    mocks.downloadVideo.mockRejectedValue(new SourceTooLargeError(raw));

    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(SourceTooLargeError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[SOURCE_TOO_LARGE] ${raw}` },
    });
  });

  it("finalize clears stale job errors after successful retries", async () => {
    const now = new Date("2026-05-09T22:00:00.000Z");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceDurationSec: 60,
      processingStartedAt: now,
      transcribeMs: 1000,
      analyzeMs: 1000,
      renderMs: 1000,
      clipsGenerated: 1,
      error: "No highlights found in the video",
    });

    await runFinalizeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "DONE",
        error: null,
      }),
    });
  });

  /**
   * The write side of the pricing seam: Job.analysisInputTokens,
   * Job.analysisOutputTokens and Job.analysisUsageByModel are three views of ONE
   * usage object and must be written from it together. Split across two updates
   * (or fed from two objects) they can disagree about a run, and finalize's
   * reconciliation would then reject the breakdown of every job - silently
   * pricing everything at the configured critic again, which is the exact bug
   * the column was added to end.
   */
  it("analyze writes the per-model breakdown from the same usage object as the totals", async () => {
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 0, end: 10, text: "hello" }],
      },
      transcriptPartial: false,
    });
    const usage = {
      requests: 4,
      inputTokens: 30_000,
      outputTokens: 4_000,
      byModel: {
        // the configured critic, which threw and so billed nothing we can see
        "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0, requests: 1 },
        "gpt-5-mini": { inputTokens: 30_000, outputTokens: 4_000, requests: 3 },
      },
    };
    mocks.analyzeHighlightsV2.mockResolvedValue({
      highlights: [{ start: 0, end: 10, title: "Clip", reason: "Hook" }],
      noClipsReason: null,
      telemetry: {},
      usage,
    });

    await runAnalyzeStage({ jobId: "job1", userId: "u1" });

    const usageWrites = mocks.jobUpdate.mock.calls
      .map((call) => call[0].data as Record<string, unknown>)
      .filter(
        (data) =>
          "analysisInputTokens" in data ||
          "analysisOutputTokens" in data ||
          "analysisUsageByModel" in data
      );
    expect(usageWrites).toHaveLength(1);
    expect(usageWrites[0]).toEqual(
      expect.objectContaining({
        analysisInputTokens: 30_000,
        analysisOutputTokens: 4_000,
        analysisUsageByModel: usage.byModel,
      })
    );

    // ...and the row that was just written must satisfy the reader on the other
    // side, reconciliation included. This is the only test that runs analyze's
    // write through finalize's read, so a reshape on either side fails here.
    const warn = vi.fn();
    expect(
      readAnalysisUsageColumn(
        usageWrites[0].analysisUsageByModel,
        {
          inputTokens: usageWrites[0].analysisInputTokens as number,
          outputTokens: usageWrites[0].analysisOutputTokens as number,
        },
        warn
      )
    ).toEqual({
      "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0 },
      "gpt-5-mini": { inputTokens: 30_000, outputTokens: 4_000 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Pins the seam Task 2 created: the model finalize PRICES must be the model
  // the engine RAN. Reverting either call site to its own env-var literal used
  // to leave the whole suite green - see the Task 2 review. It gets its own test
  // and its own fixture so that a break here reports as a pricing-seam failure
  // rather than as an error-clearing one, and so an edit to that test's fixture
  // cannot quietly change what this runs against.
  it("prices the job with the same models the engine actually ran", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceDurationSec: 600,
      processingStartedAt: new Date("2026-05-09T22:00:00.000Z"),
      transcribeMs: 12000,
      analyzeMs: 8000,
      renderMs: 20000,
      clipsGenerated: 3,
      analysisInputTokens: 40000,
      analysisOutputTokens: 5000,
      error: null,
    });

    await runFinalizeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        criticModel: loadAnalyzeConfig({}).criticModel,
        transcriptionModel: transcriptionModel({}),
      }),
    });
  });
});
