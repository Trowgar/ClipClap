export interface ReframeConfig {
  engine: "off" | "faces";
  sampleFps: number;
  sceneThreshold: number;
  minShotSec: number;
  faceMinScore: number;
  maxDetectSec: number;
}

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadReframeConfig(
  env: NodeJS.ProcessEnv = process.env
): ReframeConfig {
  return {
    engine: env.REFRAME_ENGINE === "faces" ? "faces" : "off",
    sampleFps: positive(env.REFRAME_SAMPLE_FPS, 2),
    sceneThreshold: positive(env.REFRAME_SCENE_THRESHOLD, 0.3),
    minShotSec: positive(env.REFRAME_MIN_SHOT_SEC, 1.0),
    faceMinScore: positive(env.REFRAME_FACE_MIN_SCORE, 0.7),
    maxDetectSec: positive(env.REFRAME_MAX_DETECT_SEC, 30),
  };
}
