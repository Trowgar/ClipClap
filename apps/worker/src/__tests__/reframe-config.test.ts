import { describe, expect, it } from "vitest";
import { loadReframeConfig } from "../reframe/config";

describe("loadReframeConfig", () => {
  it("defaults to off with documented knob values", () => {
    const cfg = loadReframeConfig({});
    expect(cfg).toEqual({
      engine: "off",
      sampleFps: 2,
      sceneThreshold: 0.4,
      minShotSec: 1.0,
      faceMinScore: 0.7,
      maxDetectSec: 30,
    });
  });

  it("reads env overrides and only accepts the literal 'faces' engine", () => {
    const cfg = loadReframeConfig({
      REFRAME_ENGINE: "faces",
      REFRAME_SAMPLE_FPS: "4",
      REFRAME_SCENE_THRESHOLD: "0.3",
      REFRAME_MIN_SHOT_SEC: "2",
      REFRAME_FACE_MIN_SCORE: "0.8",
      REFRAME_MAX_DETECT_SEC: "15",
    });
    expect(cfg.engine).toBe("faces");
    expect(cfg.sampleFps).toBe(4);
    expect(cfg.sceneThreshold).toBe(0.3);
    expect(cfg.minShotSec).toBe(2);
    expect(cfg.faceMinScore).toBe(0.8);
    expect(cfg.maxDetectSec).toBe(15);
    expect(loadReframeConfig({ REFRAME_ENGINE: "yes" }).engine).toBe("off");
  });

  it("falls back to defaults on junk numbers", () => {
    const cfg = loadReframeConfig({ REFRAME_SAMPLE_FPS: "-1", REFRAME_SCENE_THRESHOLD: "abc" });
    expect(cfg.sampleFps).toBe(2);
    expect(cfg.sceneThreshold).toBe(0.4);
  });
});
