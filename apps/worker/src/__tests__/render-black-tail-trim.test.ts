import { beforeEach, describe, expect, it, vi } from "vitest";

// Black-tail trim (spec 2026-08-25-cjk-subtitles.md §Black-tail trim): the
// TRIM DECISION lives entirely in cut.ts (see cut-black-tail-trim.test.ts).
// This file proves the other half - render.ts's renderClips loop stores the
// clip's ACTUAL cut end/duration (cutResult.effectiveEnd), not the
// highlight's nominal end, and threads {jobId, clipIndex} into cutClips so
// the trim's own log line can name the clip. Mocking shape mirrors
// render-reframe.test.ts; REFRAME_ENGINE stays "off" throughout since the
// reframe branch is unrelated to what this file checks.

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
    user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    clip: { create: mocks.clipCreate, updateMany: mocks.clipUpdateMany },
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
  uploadFile: mocks.uploadFile,
  getStageQueue: vi.fn(() => ({ add: mocks.queueAdd })),
  computeClipExpiresAt: mocks.computeClipExpiresAt,
}));

vi.mock("../processors/download", () => ({ downloadVideo: mocks.downloadVideo }));
vi.mock("../processors/cut", () => ({ cutClips: mocks.cutClips }));
vi.mock("../processors/normalize", () => ({ probeTimeline: mocks.probeTimeline }));
vi.mock("../processors/thumbnail", () => ({
  generateThumbnail: mocks.generateThumbnail,
}));

import { runRenderStage } from "../stages/render";

const highlight = { start: 57.9, end: 75.06, title: "clip", reason: "test" };

function jobWith(highlights: Array<typeof highlight>) {
  return {
    id: "job1",
    normalizedArtifactKey: null,
    sourceArtifactKey: "work/u1/job1/source.mp4",
    transcriptJson: { text: "", segments: [] },
    highlights,
    subtitles: false,
  };
}

describe("renderClips black-tail trim threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.jobFindUniqueOrThrow.mockResolvedValue(jobWith([highlight]));
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
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
    mocks.jobStepFindUnique.mockResolvedValue(null);
  });

  it("stores endTime/duration from cutResult.effectiveEnd when cutClips reports a trim", async () => {
    mocks.cutClips.mockImplementation(async (_src: string, hs: unknown[]) => [
      { highlight: hs[0], clipPath: "/tmp/fake-clip.mp4", effectiveEnd: 74.79 },
    ]);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    const data = mocks.clipCreate.mock.calls[0][0].data;
    expect(data.startTime).toBe(57.9);
    expect(data.endTime).toBeCloseTo(74.79, 5);
    expect(data.duration).toBe(Math.round(74.79 - 57.9));
  });

  it("falls back to highlight.end when cutClips reports no effectiveEnd at all (today's behaviour, e.g. flag off)", async () => {
    mocks.cutClips.mockImplementation(async (_src: string, hs: unknown[]) => [
      { highlight: hs[0], clipPath: "/tmp/fake-clip.mp4" },
    ]);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    const data = mocks.clipCreate.mock.calls[0][0].data;
    expect(data.endTime).toBe(75.06);
    expect(data.duration).toBe(Math.round(75.06 - 57.9));
  });

  it("threads jobId and the highlight's own index (not always 0) as cutClips's 6th argument", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue(jobWith([highlight, highlight]));
    mocks.cutClips.mockImplementation(async (_src: string, hs: unknown[]) => [
      { highlight: hs[0], clipPath: "/tmp/fake-clip.mp4" },
    ]);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.cutClips).toHaveBeenCalledTimes(2);
    expect(mocks.cutClips.mock.calls[0][5]).toEqual({ jobId: "job1", clipIndex: 0 });
    expect(mocks.cutClips.mock.calls[1][5]).toEqual({ jobId: "job1", clipIndex: 1 });
  });

});
