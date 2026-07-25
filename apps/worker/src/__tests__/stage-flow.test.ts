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
  jobUpdate: vi.fn(),
  analyzeHighlightsV2: vi.fn(),
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

vi.mock("../processors/transcribe", () => ({
  transcribeVideo: mocks.transcribeVideo,
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlightsV1: mocks.analyzeHighlightsV1,
}));

import { AnalyzeRefusalError, AnalyzeTechnicalError } from "../analyze-v2/critic";
import {
  SourceTooLargeError,
  SourceUnavailableError,
  UnsupportedInputError,
} from "../processors/errors";
import { runAnalyzeStage } from "../stages/analyze";
import { runDownloadStage } from "../stages/download";
import { runFinalizeStage } from "../stages/finalize";
import { runTranscribeStage } from "../stages/transcribe";

describe("stage handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
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
      expect.stringMatching(/^work\/u1\/job1\/source-/),
      "/tmp/source.mp4",
      "video/mp4"
    );
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        sourceArtifactKey: expect.stringMatching(/^work\/u1\/job1\/source-/),
        status: "DOWNLOADING",
      }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("transcribe", {
      jobId: "job1",
      userId: "u1",
    });
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

  it("tags a repeated model refusal with its own code, not the transient one", async () => {
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });
    const raw =
      "no clip survived and 1 of 2 candidate(s) never got a verdict (omitted 0, refused 1, truncated 0, invariant 0) - the empty result is not a complete answer";
    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeRefusalError(raw));

    await expect(runAnalyzeStage({ jobId: "job1", userId: "u1" })).rejects.toThrow();

    // FAILED, so usage.service (which sums every job that is not FAILED) bills
    // nothing - but the code is NOT ANALYSIS_UNAVAILABLE, whose copy promises a
    // retry that re-sends a prompt the model already refused twice.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: `[ANALYSIS_REFUSED] ${raw}` },
    });
  });

  it("stops BullMQ from retrying a repeated refusal, but keeps retrying everything else", async () => {
    // BullMQ decides on the error the processor throws: job.shouldRetryJob()
    // skips the remaining attempts when `err instanceof UnrecoverableError ||
    // err.name === "UnrecoverableError"`. On a cached transcript the remaining
    // attempts re-run scanner + critic to re-send a prompt the model already
    // refused twice, so for a refusal they are pure model spend for a
    // guaranteed identical failure; for every other technical failure they are
    // the whole point and must survive.
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: { text: "hello", segments: [] },
      transcriptPartial: false,
    });

    mocks.analyzeHighlightsV2.mockRejectedValue(new AnalyzeRefusalError("refused 2"));
    const refusal = await runAnalyzeStage({ jobId: "job1", userId: "u1" }).catch((e) => e);
    expect(refusal.name).toBe("UnrecoverableError");
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
});
