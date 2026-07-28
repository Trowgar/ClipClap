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
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  cutClips: vi.fn(),
  probeTimeline: vi.fn(),
  generateThumbnail: vi.fn(),
  queueAdd: vi.fn(),
  computeClipExpiresAt: vi.fn(),
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
    },
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
    mocks.jobUpdate.mockResolvedValue(undefined);
    mocks.computeClipExpiresAt.mockReturnValue(undefined);
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
});
