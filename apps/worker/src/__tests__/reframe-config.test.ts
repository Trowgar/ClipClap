import { describe, expect, it } from "vitest";
import { loadReframeConfig } from "../reframe/config";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildCropPlan } from "../reframe/plan";
import { DEFAULT_PLAN_OPTIONS } from "../reframe/options";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { FaceTrack, Shot, ShotTracks } from "../reframe/types";

describe("loadReframeConfig", () => {
  it("defaults to off with documented knob values", () => {
    const cfg = loadReframeConfig({});
    expect(cfg).toEqual({
      engine: "off",
      sampleFps: 2,
      sceneThreshold: 0.3,
      minShotSec: 1.0,
      faceMinScore: 0.7,
      maxDetectSec: 30,
      stream: false,
      // Shared with the planner, so these must not drift from that constant.
      camShare: DEFAULT_PLAN_OPTIONS.camShare,
      faceSmallFrac: DEFAULT_PLAN_OPTIONS.faceSmallFrac,
      faceLargeFrac: DEFAULT_PLAN_OPTIONS.faceLargeFrac,
      streamFaceCeiling: DEFAULT_PLAN_OPTIONS.streamFaceCeiling,
      streamVirtualCam: false,
      pipMaxFrac: 0.5,
      pipEdgeMin: 4.0,
      motion: false,
      cutRecovery: false,
      tailKeep: false,
      camera: DEFAULT_CAMERA,
    });
  });

  it("turns cut recovery on only for the exact literal 'on'", () => {
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "on" }).cutRecovery).toBe(true);
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "true" }).cutRecovery).toBe(false);
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "1" }).cutRecovery).toBe(false);
    expect(loadReframeConfig({}).cutRecovery).toBe(false);
  });

  // spec 2026-08-24-camera-visual-anchoring mechanism C. Same rule as
  // REFRAME_STREAM/REFRAME_CUT_RECOVERY: a stray truthy value must not change
  // a shipped clip's geometry.
  it("turns tail keep on only for the exact literal 'on'", () => {
    expect(loadReframeConfig({ REFRAME_TAIL_KEEP: "on" }).tailKeep).toBe(true);
    expect(loadReframeConfig({ REFRAME_TAIL_KEEP: "ON" }).tailKeep).toBe(false);
    expect(loadReframeConfig({ REFRAME_TAIL_KEEP: "true" }).tailKeep).toBe(false);
    expect(loadReframeConfig({ REFRAME_TAIL_KEEP: "1" }).tailKeep).toBe(false);
    expect(loadReframeConfig({}).tailKeep).toBe(false);
  });

  it("reads env overrides and only accepts the literal 'faces' engine", () => {
    const cfg = loadReframeConfig({
      REFRAME_ENGINE: "faces",
      REFRAME_SAMPLE_FPS: "4",
      REFRAME_SCENE_THRESHOLD: "0.25",
      REFRAME_MIN_SHOT_SEC: "2",
      REFRAME_FACE_MIN_SCORE: "0.8",
      REFRAME_MAX_DETECT_SEC: "15",
      REFRAME_PIP_MAX_FRAC: "0.4",
      REFRAME_PIP_EDGE_MIN: "6",
      REFRAME_FACE_SMALL_FRAC: "0.09",
    });
    expect(cfg.engine).toBe("faces");
    expect(cfg.sampleFps).toBe(4);
    expect(cfg.sceneThreshold).toBe(0.25);
    expect(cfg.minShotSec).toBe(2);
    expect(cfg.faceMinScore).toBe(0.8);
    expect(cfg.maxDetectSec).toBe(15);
    expect(cfg.pipMaxFrac).toBe(0.4);
    expect(cfg.pipEdgeMin).toBe(6);
    expect(cfg.faceSmallFrac).toBe(0.09);
    expect(loadReframeConfig({ REFRAME_ENGINE: "yes" }).engine).toBe("off");
  });

  it("falls back to defaults on junk numbers", () => {
    const cfg = loadReframeConfig({ REFRAME_SAMPLE_FPS: "-1", REFRAME_SCENE_THRESHOLD: "abc" });
    expect(cfg.sampleFps).toBe(2);
    expect(cfg.sceneThreshold).toBe(0.3);
  });
});

describe("stream knobs", () => {
  it("defaults to the stream layout being OFF", () => {
    const cfg = loadReframeConfig({});
    expect(cfg.stream).toBe(false);
    expect(cfg.camShare).toBe(0.4);
    expect(cfg.faceSmallFrac).toBe(0.06);
    expect(cfg.faceLargeFrac).toBe(0.1);
    expect(cfg.pipMaxFrac).toBe(0.5);
    expect(cfg.pipEdgeMin).toBe(4.0);
  });

  it("enables the stream layout only on the exact literal", () => {
    expect(loadReframeConfig({ REFRAME_STREAM: "on" }).stream).toBe(true);
    expect(loadReframeConfig({ REFRAME_STREAM: "true" }).stream).toBe(false);
  });

  it("overrides numeric knobs", () => {
    const cfg = loadReframeConfig({
      REFRAME_CAM_SHARE: "0.35",
      REFRAME_PIP_EDGE_MIN: "2.2",
    });
    expect(cfg.camShare).toBe(0.35);
    expect(cfg.pipEdgeMin).toBe(2.2);
  });

  it("ignores a nonsense override rather than emitting a broken plan", () => {
    expect(loadReframeConfig({ REFRAME_CAM_SHARE: "banana" }).camShare).toBe(0.4);
  });

  // spec 2026-08-19-stream-reframe-v2 D5.
  it("defaults REFRAME_STREAM_FACE_CEILING to 0.15 and rejects junk", () => {
    expect(loadReframeConfig({}).streamFaceCeiling).toBe(0.15);
    expect(
      loadReframeConfig({ REFRAME_STREAM_FACE_CEILING: "banana" }).streamFaceCeiling
    ).toBe(0.15);
    expect(loadReframeConfig({ REFRAME_STREAM_FACE_CEILING: "0.2" }).streamFaceCeiling).toBe(
      0.2
    );
  });

  // spec 2026-08-19-stream-reframe-v2 D4. Same rule as REFRAME_STREAM: a
  // stray truthy value must not re-layout someone's clip.
  it("enables the virtual cam tile only on the exact literal 'on'", () => {
    expect(loadReframeConfig({}).streamVirtualCam).toBe(false);
    expect(loadReframeConfig({ REFRAME_STREAM_VIRTUAL_CAM: "true" }).streamVirtualCam).toBe(
      false
    );
    expect(loadReframeConfig({ REFRAME_STREAM_VIRTUAL_CAM: "1" }).streamVirtualCam).toBe(false);
    expect(loadReframeConfig({ REFRAME_STREAM_VIRTUAL_CAM: "ON" }).streamVirtualCam).toBe(false);
    expect(loadReframeConfig({ REFRAME_STREAM_VIRTUAL_CAM: "on" }).streamVirtualCam).toBe(true);
  });
});

describe("REFRAME_STREAM gates the stream layout end to end", () => {
  // Same fixture as the "stream layout" describe block in reframe-plan.test.ts:
  // a small inset face plus a resolvable camRect, which WOULD classify as
  // `stream` once the killswitch is on. The seam under test is config ->
  // buildCropPlan, not buildCropPlan alone, so opts here come from
  // loadReframeConfig rather than a hand-written PlanOptions literal.
  const SW = 1280;
  const SH = 720;
  const camRect = { x: 0, y: 0, w: 428, h: 240, score: 4.7 };
  const insetFace: FaceTrack = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };
  const shots: Shot[] = [{ start: 0, end: 30 }];
  const tracksByShot: ShotTracks[] = [{ shotIndex: 0, tracks: [insetFace], camRect }];

  function planFor(env: NodeJS.ProcessEnv) {
    const cfg = loadReframeConfig(env);
    const cam = resolveCamRect(tracksByShot.map((s) => s.camRect), SW, SH);
    const opts = {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
      motion: cfg.motion,
      camera: cfg.camera,
    };
    return buildCropPlan(shots, tracksByShot, SW, SH, opts, cam);
  }

  it("with REFRAME_STREAM unset, a would-be stream source gets no stream shot and no stream geometry", () => {
    const plan = planFor({});
    expect(plan?.shots.some((s) => s.layout === "stream")).toBe(false);
    expect(plan?.stream).toBeUndefined();
    expect(plan?.version).toBe(1);
    expect(plan?.profile?.reason).toBe("stream_disabled");
  });

  it("with REFRAME_STREAM=on, the same source gets a stream shot and stream geometry", () => {
    const plan = planFor({ REFRAME_STREAM: "on" });
    expect(plan?.shots.some((s) => s.layout === "stream")).toBe(true);
    expect(plan?.stream).toBeDefined();
    expect(plan?.version).toBe(2);
    expect(plan?.profile?.class).toBe("stream");
  });
});

describe("REFRAME_MOTION", () => {
  it("is off by default", () => {
    expect(loadReframeConfig({}).motion).toBe(false);
  });

  it("requires the exact literal 'on'", () => {
    // Same rule as REFRAME_STREAM: a killswitch that can be flipped by
    // accident is not one.
    expect(loadReframeConfig({ REFRAME_MOTION: "on" }).motion).toBe(true);
    expect(loadReframeConfig({ REFRAME_MOTION: "true" }).motion).toBe(false);
    expect(loadReframeConfig({ REFRAME_MOTION: "1" }).motion).toBe(false);
    expect(loadReframeConfig({ REFRAME_MOTION: "ON" }).motion).toBe(false);
    expect(loadReframeConfig({ REFRAME_MOTION: " on" }).motion).toBe(false);
  });

  it("carries camera knobs at the documented defaults", () => {
    const cfg = loadReframeConfig({});
    expect(cfg.camera).toEqual({
      deadzoneFrac: 0.12,
      settleFrac: 0.04,
      maxSpeedFrac: 0.25,
      maxKeyframes: 200,
    });
  });

  it("lets each knob be overridden", () => {
    const cfg = loadReframeConfig({
      REFRAME_CAM_DEADZONE: "0.2",
      REFRAME_CAM_SETTLE: "0.05",
      REFRAME_CAM_MAX_SPEED: "0.5",
      REFRAME_CAM_MAX_KEYFRAMES: "50",
    });
    expect(cfg.camera).toEqual({
      deadzoneFrac: 0.2,
      settleFrac: 0.05,
      maxSpeedFrac: 0.5,
      maxKeyframes: 50,
    });
  });

  it("falls back to the default for a knob that is not a positive number", () => {
    const cfg = loadReframeConfig({
      REFRAME_CAM_DEADZONE: "banana",
      REFRAME_CAM_SETTLE: "0",
      REFRAME_CAM_MAX_SPEED: "-1",
    });
    expect(cfg.camera.deadzoneFrac).toBe(0.12);
    expect(cfg.camera.settleFrac).toBe(0.04);
    expect(cfg.camera.maxSpeedFrac).toBe(0.25);
  });
});
