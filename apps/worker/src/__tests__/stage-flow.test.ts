import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  downloadVideo: vi.fn(),
  transcribeVideo: vi.fn(),
  analyzeHighlightsV1: vi.fn(),
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
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      update: mocks.jobUpdate,
    },
  },
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/transcribe", () => ({
  transcribeVideo: mocks.transcribeVideo,
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlightsV1: mocks.analyzeHighlightsV1,
}));

import { runAnalyzeStage } from "../stages/analyze";
import { runDownloadStage } from "../stages/download";
import { runFinalizeStage } from "../stages/finalize";
import { runTranscribeStage } from "../stages/transcribe";

describe("stage handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
  });

  it("download persists a source artifact and enqueues transcribe", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://example.com/video",
      sourceKey: null,
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");

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
      text: "hello",
      segments: [{ start: 0, end: 10, text: "hello" }],
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
