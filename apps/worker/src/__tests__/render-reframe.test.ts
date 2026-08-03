import { beforeEach, describe, expect, it, vi } from "vitest";

// The reframe branch of renderClips had no coverage at all: every other render
// test stubs REFRAME_ENGINE to "off", so nothing exercised the handoff from a
// computed plan to the filtergraph, the fallback to the legacy center crop, the
// second cut after an encode failure, or the two-timeouts circuit breaker.
// buildFiltergraph and the telemetry builders are deliberately NOT mocked -
// what matters here is that the real graph reaches ffmpeg.

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
  computeCropPlan: vi.fn(),
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
    clip: { create: mocks.clipCreate },
  },
  uploadFile: mocks.uploadFile,
  getStageQueue: vi.fn(() => ({ add: mocks.queueAdd })),
  computeClipExpiresAt: mocks.computeClipExpiresAt,
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/cut", () => ({ cutClips: mocks.cutClips }));

vi.mock("../processors/normalize", () => ({
  probeTimeline: mocks.probeTimeline,
}));

vi.mock("../processors/thumbnail", () => ({
  generateThumbnail: mocks.generateThumbnail,
}));

vi.mock("../reframe", () => ({ computeCropPlan: mocks.computeCropPlan }));

import { runRenderStage } from "../stages/render";
import type { CropPlan } from "../reframe/types";

const streamPlan: CropPlan = {
  version: 2,
  engine: "faces",
  source: { width: 1280, height: 720 },
  profile: { class: "stream", faceFrac: 0.034, camRectScore: 6.9 },
  stream: {
    camCrop: { w: 334, h: 238, y: 0 },
    contentCrop: { w: 676, h: 720 },
    outCamH: 770,
    outContentH: 1150,
  },
  shots: [
    { start: 0, end: 10, layout: "stream", cam: { x: 34 }, content: { x: 426 } },
  ],
};

const highlight = { start: 100, end: 110, title: "clip", reason: "test" };

/** The renderManifest written at the end of the stage. */
const manifest = () => {
  const call = mocks.jobUpdate.mock.calls.find(
    (c) => c[0]?.data?.renderManifest
  );
  return call![0].data.renderManifest as {
    reframe: { engine: string; checks: Array<Record<string, unknown>> };
  };
};

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

describe("renderClips reframe branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "faces");
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.jobFindUniqueOrThrow.mockResolvedValue(jobWith([highlight]));
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
    mocks.cutClips.mockImplementation(async (_src: string, hs: unknown[]) => [
      { highlight: hs[0], clipPath: "/tmp/fake-clip.mp4" },
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

  it("cuts through the filtergraph built from the plan and stores the plan", async () => {
    mocks.computeCropPlan.mockResolvedValue({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 900,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    const spec = mocks.cutClips.mock.calls[0][3];
    expect(spec.kind).toBe("complex");
    // The stream tiles, not a center crop: two overlays into [vout].
    expect(spec.graph).toContain("scale=1080:770,setsar=1[cam]");
    expect(spec.graph).toContain("overlay=x=0:y=770:enable=");
    expect(spec.graph).toContain("[vout]");
    expect(mocks.clipCreate.mock.calls[0][0].data.cropPlan).toEqual(streamPlan);
    expect(manifest().reframe).toEqual({
      engine: "faces",
      checks: [
        {
          shotCount: 1,
          detectMs: 900,
          layouts: { single: 0, split: 0, center: 0, stream: 1 },
          profile: streamPlan.profile,
        },
      ],
    });
  });

  it("falls back to the legacy crop and records why when there is no plan", async () => {
    mocks.computeCropPlan.mockResolvedValue({
      plan: null,
      shotCount: 3,
      detectMs: 120,
      fallbackReason: "detector_failed",
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.cutClips).toHaveBeenCalledTimes(1);
    expect(mocks.cutClips.mock.calls[0][3]).toBeNull();
    expect(mocks.clipCreate.mock.calls[0][0].data.cropPlan).toBeUndefined();
    expect(manifest().reframe.checks).toEqual([
      { shotCount: 3, detectMs: 120, fallbackReason: "detector_failed" },
    ]);
  });

  it("re-cuts without the filtergraph when the reframe encode throws", async () => {
    mocks.computeCropPlan.mockResolvedValue({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 900,
    });
    mocks.cutClips
      .mockRejectedValueOnce(new Error("ffmpeg error -22"))
      .mockResolvedValueOnce([
        { highlight, clipPath: "/tmp/fake-clip.mp4" },
      ]);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.cutClips).toHaveBeenCalledTimes(2);
    expect(mocks.cutClips.mock.calls[1][3]).toBeNull();
    // The clip was still produced, and the plan is not stored for a picture
    // that was never rendered.
    expect(mocks.clipCreate).toHaveBeenCalledTimes(1);
    expect(mocks.clipCreate.mock.calls[0][0].data.cropPlan).toBeUndefined();
    expect(manifest().reframe.checks).toEqual([
      {
        shotCount: 1,
        detectMs: 900,
        profile: streamPlan.profile,
        fallbackReason: "encode_failed",
      },
    ]);
  });

  it("stops detecting after two consecutive timeouts", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue(
      jobWith([highlight, highlight, highlight])
    );
    mocks.computeCropPlan.mockResolvedValue({
      plan: null,
      shotCount: 0,
      detectMs: 30000,
      fallbackReason: "timeout",
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.computeCropPlan).toHaveBeenCalledTimes(2);
    expect(mocks.cutClips).toHaveBeenCalledTimes(3);
    expect(manifest().reframe.checks[2]).toEqual({
      shotCount: 0,
      detectMs: 0,
      fallbackReason: "skipped_after_timeouts",
    });
  });

  it("resets the timeout counter on any non-timeout result", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue(
      jobWith([highlight, highlight, highlight])
    );
    mocks.computeCropPlan
      .mockResolvedValueOnce({
        plan: null,
        shotCount: 0,
        detectMs: 30000,
        fallbackReason: "timeout",
      })
      .mockResolvedValueOnce({
        plan: null,
        shotCount: 2,
        detectMs: 400,
        fallbackReason: "plan_empty",
      })
      .mockResolvedValueOnce({
        plan: null,
        shotCount: 0,
        detectMs: 30000,
        fallbackReason: "timeout",
      });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.computeCropPlan).toHaveBeenCalledTimes(3);
    expect(
      manifest().reframe.checks.map((c) => c.fallbackReason)
    ).toEqual(["timeout", "plan_empty", "timeout"]);
  });
});
