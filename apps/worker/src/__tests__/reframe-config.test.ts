import { describe, expect, it } from "vitest";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_PLAN_OPTIONS } from "../reframe/options";

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
      pipMaxFrac: 0.5,
      pipEdgeMin: 4.0,
      // Shared with the planner, so it must not drift from that constant.
      faceSmallFrac: DEFAULT_PLAN_OPTIONS.faceSmallFrac,
    });
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
