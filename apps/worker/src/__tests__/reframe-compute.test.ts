import { beforeEach, describe, expect, it, vi } from "vitest";

// computeCropPlan's contract is that it NEVER throws: every failure of the
// probe, the scene detector or the python sidecar comes back as plan:null plus
// a machine-readable reason, and the render stage falls back to the legacy
// center crop. Every "this degrades safely" claim in the reframe design rests
// on that, and none of it had a test. The three child-process boundaries
// (ffprobe, ffmpeg, python3) are mocked so no video is needed.

type ExecResult = { stdout: string; stderr: string };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  // Returning an Error means "the process failed"; throwing means the spawn
  // itself blew up synchronously.
  respond: (_cmd: string, _args: string[]): ExecResult | Error => ({
    stdout: "",
    stderr: "",
  }),
}));

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, result?: ExecResult) => void
  ) => {
    h.calls.push({ cmd, args });
    const result = h.respond(cmd, args);
    if (result instanceof Error) cb(result);
    else cb(null, result);
  },
}));

import { computeCropPlan, planDetected, STREAM_SHOT_COVERAGE_MIN, type Detection } from "../reframe";
import type { ReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { FaceTrack } from "../reframe/types";

const cfg: ReframeConfig = {
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  motion: false,
  cutRecovery: false,
  tailKeep: false,
  saliencyShadow: false,
  safetyShadow: false,
  streamCoverageGate: false,
  streamVirtualCam: false,
  camera: DEFAULT_CAMERA,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

/** One off-centre face per shot, wide enough to anchor a single layout. */
const detectorJson = (shotCount: number) =>
  JSON.stringify({
    shots: Array.from({ length: shotCount }, (_, i) => ({
      shotIndex: i,
      camRect: null,
      tracks: [
        {
          id: 1,
          box: { x: 800, y: 180, w: 240, h: 240 },
          score: 0.92,
          samples: 8,
          mouthActivity: 0.3,
        },
      ],
    })),
  });

/** Two faces that never share the screen: A for 0-5s, B for 5-10s, one shot. */
const turnoverJson = () => {
  const path = (from: number, to: number, x: number) =>
    Array.from({ length: Math.round((to - from) * 2) }, (_, k) => ({
      t: from + k * 0.5,
      x,
      y: 180,
      w: 240,
      h: 240,
    }));
  return JSON.stringify({
    shots: [
      {
        shotIndex: 0,
        camRect: null,
        tracks: [
          { id: 1, box: { x: 100, y: 180, w: 240, h: 240 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(0, 5, 100) },
          { id: 2, box: { x: 900, y: 180, w: 240, h: 240 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(5, 10, 900) },
        ],
      },
    ],
  });
};

/** scdet stderr: one candidate at 5.0s scoring 0.22 - below the 0.3 bar. */
const candidateStderr =
  "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:5.0\n" +
  "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.22\n";

function turnoverPath(cmd: string, _args: string[]): ExecResult {
  if (cmd === "ffprobe") return { stdout: "1280x720\n", stderr: "" };
  if (cmd === "ffmpeg") return { stdout: "", stderr: candidateStderr };
  if (cmd === "python3") return { stdout: turnoverJson(), stderr: "" };
  throw new Error(`unexpected command ${cmd}`);
}

/**
 * Everything succeeds: 1280x720, no scene cuts (so one shot covering the
 * window), one usable face in it.
 */
function happyPath(cmd: string, _args: string[]): ExecResult {
  if (cmd === "ffprobe") return { stdout: "1280x720\n", stderr: "" };
  if (cmd === "ffmpeg") return { stdout: "", stderr: "" };
  if (cmd === "python3") return { stdout: detectorJson(1), stderr: "" };
  throw new Error(`unexpected command ${cmd}`);
}

const killed = (message: string) => {
  const error = new Error(message) as Error & { killed: boolean };
  error.killed = true;
  return error;
};

describe("computeCropPlan never throws", () => {
  beforeEach(() => {
    h.calls = [];
    h.respond = happyPath;
  });

  it("returns scdet_failed when probing the source fails", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe" ? new Error("boom") : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
    // Nothing downstream of the probe should have run.
    expect(h.calls.map((c) => c.cmd)).toEqual(["ffprobe"]);
  });

  it("returns scdet_failed when ffprobe answers with something unparseable", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe"
        ? { stdout: "N/AxN/A\n", stderr: "" }
        : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
  });

  it("returns scdet_failed when a selected frame carries no scene score", async () => {
    h.respond = (cmd, args) =>
      cmd === "ffmpeg"
        ? { stdout: "", stderr: "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:5.0\n" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
  });

  it("maps a killed process to timeout", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe" ? killed("killed") : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("timeout");
  });

  it("maps a killed detector to timeout, keeping the shots it already had", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? killed("killed") : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("timeout");
    expect(r.shotCount).toBe(1);
  });

  it("returns detector_failed when the sidecar exits non-zero", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? new Error("exit status 1") : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_failed");
    expect(r.shotCount).toBe(1);
  });

  it("returns detector_invalid_json when the sidecar prints garbage", async () => {
    // The sidecar succeeding and answering with nonsense is a different failure
    // from it dying, and the one a half-written stdout actually produces.
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: '{"shots": [{"shotIn', stderr: "" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_invalid_json");
  });

  it("returns detector_invalid_json when the sidecar answers about the wrong shots", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: detectorJson(4), stderr: "" } // one shot was detected
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_invalid_json");
  });

  it("returns plan_empty when the window yields no shots at all", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: detectorJson(0), stderr: "" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 5, 5, { ...cfg, safetyShadow: true });

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("plan_empty");
    expect(r.shotCount).toBe(0);
    expect(r.safetyShadow).toBeUndefined();
  });

  it("survives a spawn that throws synchronously", async () => {
    h.respond = () => {
      throw new Error("sync explosion");
    };

    await expect(computeCropPlan("/x.mp4", 0, 10, cfg)).resolves.toMatchObject({
      plan: null,
      fallbackReason: "scdet_failed",
    });
  });

  it("returns a real plan when every stage succeeds", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.fallbackReason).toBeUndefined();
    expect(r.shotCount).toBe(1);
    expect(r.detectMs).toBeGreaterThanOrEqual(0);
    expect(r.plan).toEqual({
      version: 1,
      engine: "faces",
      source: { width: 1280, height: 720 },
      profile: { class: "normal_face", faceFrac: 240 / 1280 },
      // Face centred on x=920 of a 1280-wide source, 406-wide 9:16 window.
      shots: [{ start: 0, end: 10, layout: "single", x: 718 }],
    });
    expect(h.calls.map((c) => c.cmd)).toEqual([
      "ffprobe",
      "ffmpeg", // scene detection
      "ffmpeg", // frame extraction
      "python3",
    ]);
  });

  it("propagates safety shadow telemetry from a successful detector path", async () => {
    const pathDetector = JSON.stringify({
      shots: [{
        shotIndex: 0,
        camRect: null,
        tracks: [{
          id: 1,
          box: { x: 800, y: 180, w: 240, h: 240 },
          score: 0.92,
          samples: 8,
          mouthActivity: 0.3,
          path: [{ t: 5, x: 800, y: 180, w: 240, h: 240 }],
        }],
      }],
    });
    h.respond = (cmd, args) =>
      cmd === "python3" ? { stdout: pathDetector, stderr: "" } : happyPath(cmd, args);

    const on = await computeCropPlan("/x.mp4", 0, 10, { ...cfg, safetyShadow: true });
    const off = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(JSON.stringify(on.plan)).toBe(JSON.stringify(off.plan));
    expect(off.safetyShadow).toBeUndefined();
    expect(on.safetyShadow).toEqual({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 1,
      evaluatedSamples: 1,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
    expect(JSON.stringify(on.plan)).not.toContain("800");
    expect(JSON.stringify(on.safetyShadow)).not.toMatch(/face|box|region|id/i);
  });
});

describe("computeCropPlan cut recovery", () => {
  beforeEach(() => {
    h.calls = [];
    h.respond = turnoverPath;
  });

  it("leaves the plan alone and reports no telemetry with the flag off", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan?.shots).toHaveLength(1);
    expect(r.cutRecovery).toBeUndefined();
    expect(r.shotCount).toBe(1);
  });

  it("splits at the confirmed candidate with the flag on and reports telemetry", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, { ...cfg, cutRecovery: true });

    // Two full windows, one per face - the split changed the picture, not just the count.
    expect(r.plan?.shots).toEqual([
      { start: 0, end: 5, layout: "single", x: 18 }, // face A at x=100
      { start: 5, end: 10, layout: "single", x: 818 }, // face B at x=900
    ]);
    expect(r.cutRecovery).toEqual({
      candidates: 1,
      confirmed: 1,
      rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
      capHit: 0,
    });
    // shotCount stays the DETECTOR count; the recovered count is the plan's.
    expect(r.shotCount).toBe(1);
  });

  it("counts noPath and changes nothing when the sidecar sent no path", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? { stdout: detectorJson(1), stderr: "" } : turnoverPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, { ...cfg, cutRecovery: true });

    expect(r.plan?.shots).toHaveLength(1);
    expect(r.cutRecovery?.rejected.noPath).toBe(1);
  });

  it("resolves the clip-level cam rect on the DETECTOR shots, before recovery (spec §4)", async () => {
    // Faces well under REFRAME_FACE_SMALL_FRAC (0.06 * 1280 = 76.8px) so
    // buildCropPlan falls through past normal_face to small_face and surfaces
    // resolveCamRect's reason on plan.profile - the field this test pins.
    const path = (from: number, to: number, x: number) =>
      Array.from({ length: Math.round((to - from) * 2) }, (_, k) => ({
        t: from + k * 0.5,
        x,
        y: 180,
        w: 40,
        h: 40,
      }));
    const camVoteJson = JSON.stringify({
      shots: [
        {
          shotIndex: 0,
          camRect: { x: 40, y: 40, w: 300, h: 220, score: 6.0 },
          tracks: [
            { id: 1, box: { x: 100, y: 180, w: 40, h: 40 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(0, 5, 100) },
            { id: 2, box: { x: 900, y: 180, w: 40, h: 40 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(5, 10, 900) },
          ],
        },
        {
          shotIndex: 1,
          camRect: { x: 900, y: 400, w: 300, h: 220, score: 6.0 },
          tracks: [
            { id: 3, box: { x: 600, y: 180, w: 40, h: 40 }, score: 0.9, samples: 20, mouthActivity: 0.3, path: path(10, 20, 600) },
          ],
        },
      ],
    });
    // scdet: a real cut at 10.0 (0.5, above the 0.3 bar - the detector shot
    // boundary) and a candidate at 5.0 (0.22, inside shot 0 - cut recovery's to confirm).
    const camVoteStderr =
      "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:5.0\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.22\n" +
      "[Parsed_metadata_2 @ 0x1] frame:1 pts:2 pts_time:10.0\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.5\n";
    h.respond = (cmd: string, _args: string[]): ExecResult => {
      if (cmd === "ffprobe") return { stdout: "1280x720\n", stderr: "" };
      if (cmd === "ffmpeg") return { stdout: "", stderr: camVoteStderr };
      if (cmd === "python3") return { stdout: camVoteJson, stderr: "" };
      throw new Error(`unexpected command ${cmd}`);
    };

    const r = await computeCropPlan("/x.mp4", 0, 20, { ...cfg, cutRecovery: true, stream: true });

    // Pre-recovery the vote is over the two DETECTOR shots' rects only:
    // [rectA(x=40), rectB(x=900)] disagree by far more than the 2% tolerance,
    // so resolveCamRect declines (stream_rect_unstable) rather than average
    // across what is really a scene change - and buildCropPlan surfaces that
    // reason on profile since there is no normal-sized face to anchor on.
    //
    // If resolveCamRect instead ran AFTER recovery, shot 0 would already be
    // split at t=5 into two sub-shots that both inherit rectA - a vote of
    // [A, A, B] - and A's 2-of-3 majority would resolve cleanly instead of
    // declining. That is exactly the ordering bug this seam guards against.
    expect(r.plan?.profile).toMatchObject({
      class: "small_face",
      reason: "stream_rect_unstable",
    });
  });
});

// spec 2026-08-24-render-retry-and-stream-gate §2. planDetected is a pure
// function of a Detection - these tests build one directly, bypassing the
// child_process mocking above entirely (detectRange/the sidecar are never
// involved once a Detection exists).
describe("planDetected: stream-layout coverage gate", () => {
  const SW = 640;
  const SH = 360;
  // Real tox_4X88jJU.mp4 GT face box (.corpus/stream-v2/README.md), same
  // fixture reframe-plan.test.ts's D4 suite uses: 49/640 = 0.0765625, well
  // under the default 0.15 streamFaceCeiling.
  const toxFace: FaceTrack = {
    id: 0,
    box: { x: 575, y: 285, w: 49, h: 55 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
    path: [{ t: 0.5, x: 575, y: 285, w: 49, h: 55 }],
  };
  // Same geometry as reframe-plan.test.ts's "a real, resolvable camRect wins
  // via D5" fixture: contains toxFace, solves, and (unlike a synthesized
  // rect) carries a nonzero score - a genuinely DETECTED inset.
  const realCamRect = { x: 520, y: 254, w: 120, h: 90, score: 5.2 };

  const gateOn: ReframeConfig = {
    ...cfg,
    stream: true,
    streamVirtualCam: true,
    streamCoverageGate: true,
  };

  /** One shot showing the streamer (duration `onSec`), one shot showing
   *  nothing at all (duration `offSec`) - the shape every measured FP had:
   *  a synthesized rect that is only sometimes actually on screen. */
  function lowHighDetection(onSec: number, offSec: number, camRect: null | typeof realCamRect): Detection {
    return {
      width: SW,
      height: SH,
      candidates: [],
      shots: [
        { start: 0, end: onSec },
        { start: onSec, end: onSec + offSec },
      ],
      tracksByShot: [
        { shotIndex: 0, tracks: [toxFace], camRect },
        { shotIndex: 1, tracks: [], camRect },
      ],
    };
  }

  it("keeps the plan byte-identical while adding aggregate shadow telemetry", () => {
    const detection: Detection = {
      width: 1280,
      height: 720,
      candidates: [],
      shots: [{ start: 0, end: 10 }],
      tracksByShot: [{
        shotIndex: 0,
        camRect: null,
        tracks: [{
          id: 7,
          box: { x: 800, y: 180, w: 240, h: 240 },
          score: 0.92,
          samples: 8,
          mouthActivity: 0.3,
          path: [{ t: 5, x: 800, y: 180, w: 240, h: 240 }],
        }],
      }],
    };
    const off = planDetected(detection, { ...cfg, safetyShadow: false });
    const on = planDetected(detection, { ...cfg, safetyShadow: true });

    expect(JSON.stringify(off.plan)).toBe(JSON.stringify(on.plan));
    expect(off.safetyShadow).toBeUndefined();
    expect(on.safetyShadow).toEqual({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 1,
      evaluatedSamples: 1,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
  });

  it("reports a failed shadow when a mandatory sample is outside the final crop", () => {
    const detection: Detection = {
      width: 1280,
      height: 720,
      candidates: [],
      shots: [{ start: 0, end: 10 }],
      tracksByShot: [{
        shotIndex: 0,
        camRect: null,
        tracks: [{
          id: 8,
          box: { x: 800, y: 180, w: 240, h: 240 },
          score: 0.92,
          samples: 8,
          mouthActivity: 0.3,
          path: [{ t: 5, x: 100, y: 180, w: 240, h: 240 }],
        }],
      }],
    };

    expect(planDetected(detection, { ...cfg, safetyShadow: true }).safetyShadow).toEqual({
      status: "fail",
      threshold: 0.9,
      minimumCoverage: 0,
      evaluatedSamples: 1,
      rejectedSamples: 1,
      unmappedSamples: 0,
    });
  });

  it("(a) virtualCam plan at ~10% coverage re-plans to zero stream shots, stamped and otherwise equal to an explicit stream:false plan", () => {
    const detection = lowHighDetection(1, 9, null);

    // Baseline: prove the fixture is actually the FP shape the gate targets
    // before asserting the gate's effect on it.
    const ungated = planDetected(detection, { ...gateOn, streamCoverageGate: false });
    expect(ungated.plan?.profile?.virtualCam).toBe(true);
    expect(ungated.plan?.shots.some((s) => s.layout === "stream")).toBe(true);

    const gated = planDetected(detection, gateOn);
    const streamOff = planDetected(detection, { ...gateOn, stream: false });

    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(false);
    // Persisted stamp (spec 2026-08-24-render-retry-and-stream-gate §2):
    // without it the re-planned profile is indistinguishable from a source
    // that never had stream signal, so the gate's first live firing would be
    // unfindable. Geometry-wise the plan is exactly the stream:false plan -
    // only `profile.reason`/`gatedCoverage` differ, on purpose.
    expect(gated.plan?.profile?.reason).toBe("stream_coverage_gated");
    expect(gated.plan?.profile?.gatedCoverage).toBeCloseTo(0.1, 5);
    expect(gated.plan).toEqual({
      ...streamOff.plan,
      profile: { ...streamOff.plan?.profile, reason: "stream_coverage_gated", gatedCoverage: 0.1 },
    });
  });

  it("evaluates the final stream-gated plan rather than its pre-gate stream layout", () => {
    const detection = lowHighDetection(1, 9, null);
    const gated = planDetected(detection, { ...gateOn, safetyShadow: true });

    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(false);
    expect(gated.safetyShadow).toEqual({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 1,
      evaluatedSamples: 1,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
  });

  it("(b) virtualCam plan at 90% coverage is byte-identical to the gate-off plan, no stamp", () => {
    const detection = lowHighDetection(9, 1, null);

    const gated = planDetected(detection, gateOn);
    expect(gated.plan?.profile?.virtualCam).toBe(true);

    const gateOff = planDetected(detection, { ...gateOn, streamCoverageGate: false });
    expect(JSON.stringify(gated.plan)).toBe(JSON.stringify(gateOff.plan));
    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(true);
    expect(gated.plan?.profile?.gatedCoverage).toBeUndefined();
  });

  it("(c) a DETECTED cam rect at ~10% coverage bypasses the gate untouched, no stamp", () => {
    const detection = lowHighDetection(1, 9, realCamRect);

    const gated = planDetected(detection, gateOn);
    expect(gated.plan?.profile?.class).toBe("stream");
    expect(gated.plan?.profile?.virtualCam).toBeUndefined(); // genuinely detected, not synthesized

    const gateOff = planDetected(detection, { ...gateOn, streamCoverageGate: false });
    expect(JSON.stringify(gated.plan)).toBe(JSON.stringify(gateOff.plan));
    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(true);
    expect(gated.plan?.profile?.gatedCoverage).toBeUndefined();
  });

  it("(d) flag OFF leaves a low-coverage virtualCam plan untouched, no stamp", () => {
    const detection = lowHighDetection(1, 9, null);

    const off = planDetected(detection, { ...gateOn, streamCoverageGate: false });
    expect(off.plan?.profile?.virtualCam).toBe(true);
    expect(off.plan?.shots.some((s) => s.layout === "stream")).toBe(true);
    expect(off.plan?.profile?.gatedCoverage).toBeUndefined();
  });

  it("(e) boundary: coverage just below 0.75 (~0.74) re-plans to zero stream shots", () => {
    // 74s stream + 26s off, of 100s total = 0.74 - the complement of (f)'s
    // exact-boundary pass, tuned to sit just under the floor.
    const detection = lowHighDetection(74, 26, null);

    const gated = planDetected(detection, gateOn);
    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(false);
    expect(gated.plan?.profile?.reason).toBe("stream_coverage_gated");
    expect(gated.plan?.profile?.gatedCoverage).toBeCloseTo(0.74, 5);
  });

  it("(f) boundary: coverage exactly 0.75 passes untouched, no stamp (>= keeps, < re-plans)", () => {
    expect(STREAM_SHOT_COVERAGE_MIN).toBe(0.75);
    // 3s stream + 1s off, of 4s total = exactly 0.75.
    const detection = lowHighDetection(3, 1, null);

    const gated = planDetected(detection, gateOn);
    expect(gated.plan?.profile?.virtualCam).toBe(true);
    expect(gated.plan?.shots.some((s) => s.layout === "stream")).toBe(true);
    expect(gated.plan?.profile?.gatedCoverage).toBeUndefined();

    const gateOff = planDetected(detection, { ...gateOn, streamCoverageGate: false });
    expect(gated.plan).toEqual(gateOff.plan);
  });
});
