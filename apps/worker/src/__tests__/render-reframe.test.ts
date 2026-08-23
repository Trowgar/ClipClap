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
    clip: { create: mocks.clipCreate },
    // Unmocked calls (every test outside the music-shorts describe block
    // below) resolve to plain `undefined` here - loadReframeConfigForJob's
    // own optional chaining treats that exactly like "no row", the same
    // degrade-safely discipline as a missing/malformed row.
    jobStep: { findUnique: mocks.jobStepFindUnique },
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
import { loadReframeConfig } from "../reframe/config";
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
    subtitles: Record<string, number>;
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

// The dropped-word repair reports what it did through renderManifest.subtitles,
// and `unresolved` growing there is the documented signal that Whisper's output
// shape has changed. Nothing asserted that manifest field: the five hand-written
// += lines and the hand-rolled object literal that duplicates RestoreSummary
// could be transposed - restoredHead += restores.restoredTail - and the whole
// suite stayed green. A mis-summed tripwire is worse than no tripwire.
describe("renderClips subtitle telemetry", () => {
  // One segment per outcome, inside the highlight window, with the head and
  // tail counts DIFFERENT so a transposition of the two cannot pass.
  const segments = [
    {
      // tail restore with its own timing entry: 0.8s of room and a spaced seam.
      start: 100.0,
      end: 101.0,
      text: "Nice, bro.",
      words: [{ text: "Nice", start: 100.0, end: 100.2 }],
    },
    {
      // tail restore that merges: "во-первых" is one word tokenised in two.
      start: 101.0,
      end: 102.0,
      text: "Это во-первых.",
      words: [
        { text: "Это", start: 101.0, end: 101.3 },
        { text: "во", start: 101.3, end: 101.6 },
      ],
    },
    {
      // head restore that merges: no head room at all, the common Russian shape.
      start: 102.0,
      end: 103.0,
      text: "Заниматься сексом.",
      words: [{ text: "сексом.", start: 102.0, end: 102.5 }],
    },
    {
      // text missing at BOTH ends - the repair declines to guess.
      start: 103.0,
      end: 104.0,
      text: "start middle end",
      words: [{ text: "middle", start: 103.4, end: 103.6 }],
    },
    {
      // nothing dropped: counted as an occurrence, restored nowhere.
      start: 104.0,
      end: 104.5,
      text: "All good.",
      words: [
        { text: "All", start: 104.0, end: 104.2 },
        { text: "good.", start: 104.2, end: 104.5 },
      ],
    },
    // No words[] at all: takes the wordless fallback cue, which cannot drop a
    // word, so it must not be counted as an occurrence.
    { start: 104.5, end: 105.0, text: "Silent." },
    // Outside the highlight window entirely.
    {
      start: 200.0,
      end: 201.0,
      text: "Nice, bro.",
      words: [{ text: "Nice", start: 200.0, end: 200.2 }],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
    mocks.cutClips.mockImplementation(async (_src: string, hs: unknown[]) =>
      hs.map(() => ({ highlight: hs[0], clipPath: "/tmp/fake-clip.mp4" }))
    );
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

  it("writes the summary the segments imply", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      ...jobWith([highlight]),
      transcriptJson: { text: "", segments },
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(manifest().subtitles).toEqual({
      // Five of the seven segments overlap the window and carry words[].
      segmentOccurrences: 5,
      restoredHead: 1,
      restoredTail: 2,
      unresolved: 1,
      // The merged head plus the merged tail, and NOT the tail that got its
      // own entry.
      merged: 2,
    });
  });

  it("sums over the job's clips rather than keeping the last one", async () => {
    // Two highlights over the same segments: every field doubles. Written to
    // kill an assignment where an accumulation is meant.
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      ...jobWith([highlight, highlight]),
      transcriptJson: { text: "", segments },
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(manifest().subtitles).toEqual({
      segmentOccurrences: 10,
      restoredHead: 2,
      restoredTail: 4,
      unresolved: 2,
      merged: 4,
    });
  });
});

// task M4 (spec 2026-08-23-music-shorts): a music-shorts job must never reach
// the stream/virtual-cam layouts, even when REFRAME_STREAM(_VIRTUAL_CAM) is
// "on" - the corpus E2E render of the Baby Shark hook window classified
// stream+virtualCam (cartoon faces at ~8% frame width) and shipped a two-tile
// boy/girl layout, wrong for a music short whose full performance frame IS
// the content. computeCropPlan is mocked, so the object it actually receives
// as its cfg argument is directly inspectable - the cleanest seam to prove
// the override reached the real call, not just loadReframeConfigForJob in
// isolation.
describe("renderClips music-shorts stream override (task M4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "faces");
    // Both stream knobs explicitly "on" - the override must win over an
    // operator-armed env, not merely agree with an already-off default.
    vi.stubEnv("REFRAME_STREAM", "on");
    vi.stubEnv("REFRAME_STREAM_VIRTUAL_CAM", "on");
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
    mocks.computeCropPlan.mockResolvedValue({
      plan: null,
      shotCount: 3,
      detectMs: 120,
      fallbackReason: "detector_failed",
    });
  });

  it("a music-shorts job's ANALYZE telemetry forces stream/streamVirtualCam OFF on the cfg handed to computeCropPlan, even though the env literals are 'on'", async () => {
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { telemetry: { path: "music-shorts" } },
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.jobStepFindUnique).toHaveBeenCalledWith({
      where: { jobId_step: { jobId: "job1", step: "ANALYZE" } },
      select: { outputJson: true },
    });
    const cfg = mocks.computeCropPlan.mock.calls[0][3];
    expect(cfg.stream).toBe(false);
    expect(cfg.streamVirtualCam).toBe(false);
    // face-crop itself is untouched - only the two stream-family knobs move
    expect(cfg.engine).toBe("faces");
  });

  it("a normal (non-music-shorts) job passes the env-sourced cfg through untouched - byte-identical to loadReframeConfig()", async () => {
    // No ANALYZE row at all (the common case: most jobs are checked before
    // this telemetry key ever existed, or simply aren't music-shorts).
    mocks.jobStepFindUnique.mockResolvedValue(null);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    const cfg = mocks.computeCropPlan.mock.calls[0][3];
    expect(cfg).toEqual(loadReframeConfig());
    expect(cfg.stream).toBe(true);
    expect(cfg.streamVirtualCam).toBe(true);
  });

  it("an ANALYZE telemetry path other than 'music-shorts' also passes the env-sourced cfg through untouched", async () => {
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { telemetry: { path: "song-gate" } },
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    const cfg = mocks.computeCropPlan.mock.calls[0][3];
    expect(cfg).toEqual(loadReframeConfig());
  });
});
