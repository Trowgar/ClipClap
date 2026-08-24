import { beforeEach, describe, expect, it, vi } from "vitest";

// renderClips (mode: "clips") stored `subtitles: job.subtitles` on the new
// Clip row - the job-level REQUEST - even though whether this specific
// highlight actually got a burned filter also depends on it having any
// cues in range (`job.subtitles && cues.length > 0`, see the assFilter
// guard in render.ts). A highlight with no dialogue in its window would
// request subtitles but burn none, yet the column said true. Fixed the
// same way as the trim path: write what was actually burned.

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  jobFindUniqueOrThrow: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  jobUpdate: vi.fn(),
  clipCreate: vi.fn(),
  clipUpdateMany: vi.fn(),
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  cutClips: vi.fn(),
  probeTimeline: vi.fn(),
  generateThumbnail: vi.fn(),
  queueAdd: vi.fn(),
  computeClipExpiresAt: vi.fn(),
  createAssFilter: vi.fn(),
  jobStepFindUnique: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFindUniqueOrThrow,
      update: mocks.jobUpdate,
    },
    user: {
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
    },
    clip: {
      create: mocks.clipCreate,
      // The render-retry cleanup (spec
      // 2026-08-24-render-retry-and-stream-gate §1) now runs at the start of
      // every renderClips call - unrelated to what this file tests.
      updateMany: mocks.clipUpdateMany,
    },
    // renderClips now reads the ANALYZE step's telemetry to decide the
    // music-shorts stream-layout override (task M4, stages/render.ts's
    // loadReframeConfigForJob) - unmocked here resolves `undefined`,
    // which that helper treats as "no override", same as a job without an
    // ANALYZE row at all.
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
  uploadFile: mocks.uploadFile,
  getStageQueue: vi.fn(() => ({ add: mocks.queueAdd })),
  computeClipExpiresAt: mocks.computeClipExpiresAt,
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/cut", () => ({
  cutClips: mocks.cutClips,
}));

vi.mock("../processors/normalize", () => ({
  probeTimeline: mocks.probeTimeline,
}));

vi.mock("../processors/thumbnail", () => ({
  generateThumbnail: mocks.generateThumbnail,
}));

// Partial: segmentsToCues stays real, because these tests depend on it deciding
// whether a highlight has cues in range at all. Only the burn entry point is
// swapped, so the language it receives can be asserted.
vi.mock("../processors/subtitles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../processors/subtitles")>();
  return { ...actual, createAssFilter: mocks.createAssFilter };
});

import { runRenderStage } from "../stages/render";

describe("renderClips stores what it actually burned, not the job's subtitles flag", () => {
  const highlight = {
    start: 100,
    end: 110,
    title: "clip",
    reason: "test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
    mocks.cutClips.mockResolvedValue([
      { highlight, clipPath: "/tmp/fake-clip.mp4" },
    ]);
    mocks.probeTimeline.mockResolvedValue({
      formatStart: 0,
      videoStart: 0,
      audioStart: 0,
      hasAudio: true,
      hasVideo: true,
    });
    mocks.generateThumbnail.mockResolvedValue("/tmp/fake-thumb.jpg");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.clipCreate.mockResolvedValue({ id: "clip1" });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.jobUpdate.mockResolvedValue(undefined);
    mocks.computeClipExpiresAt.mockReturnValue(undefined);
    mocks.createAssFilter.mockResolvedValue({
      filter: "ass=filename=/tmp/fake.ass",
      assPath: "/tmp/fake.ass",
    });
  });

  it("stores subtitles: false when the job wants subtitles but this highlight has no cues in range", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      transcriptJson: {
        text: "hello",
        // Outside [100, 110] entirely - segmentsToCues yields no cues.
        segments: [{ start: 0, end: 3, text: "hello" }],
      },
      highlights: [highlight],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.clipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subtitles: false }),
      })
    );
  });

  it("stores subtitles: true when this highlight actually gets a burned filter", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [highlight],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.clipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subtitles: true }),
      })
    );
  });

  it("stores subtitles: false when the job has subtitles off, even with cues in range", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [highlight],
      subtitles: false,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.clipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subtitles: false }),
      })
    );
  });

  it("hands the highlight's language to the subtitle burn", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      language: "en",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [{ ...highlight, language: "ar" }],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.createAssFilter).toHaveBeenCalledWith(expect.anything(), "ar");
  });

  // The 13 production clip rows with a null language are covered by this
  // branch, and a job-level language is what an Arabic source without
  // per-highlight detection would carry.
  it("falls back to the job language when the highlight has none", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      language: "ar",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [highlight],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.createAssFilter).toHaveBeenCalledWith(expect.anything(), "ar");
  });
});
