import { DEFAULT_PLAN_OPTIONS } from "./options";
import { DEFAULT_CAMERA, type CameraConfig } from "./camera";

export interface ReframeConfig {
  engine: "off" | "faces";
  sampleFps: number;
  sceneThreshold: number;
  minShotSec: number;
  faceMinScore: number;
  maxDetectSec: number;
  /** Stream layout killswitch. Classification runs regardless. */
  stream: boolean;
  camShare: number;
  faceSmallFrac: number;
  faceLargeFrac: number;
  pipMaxFrac: number;
  pipEdgeMin: number;
  /** Crop-trajectory killswitch. Planning runs regardless; this decides whether
   *  a trajectory is emitted at all. */
  motion: boolean;
  /** Cut-recovery killswitch (spec 2026-08-17-cut-recovery-design §2c). Off is
   *  today's plan byte for byte; on lets face-track turnover confirm scdet
   *  candidates in the 0.15-0.30 band. */
  cutRecovery: boolean;
  camera: CameraConfig;
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
    // REFRAME_STREAM must match the exact literal "on" - not truthy, not
    // "true", not "1". A killswitch that can be flipped by accident isn't one.
    stream: env.REFRAME_STREAM === "on",
    camShare: positive(env.REFRAME_CAM_SHARE, DEFAULT_PLAN_OPTIONS.camShare),
    // Shared with the planner, so these must not drift from that constant.
    faceSmallFrac: positive(
      env.REFRAME_FACE_SMALL_FRAC,
      DEFAULT_PLAN_OPTIONS.faceSmallFrac
    ),
    faceLargeFrac: positive(
      env.REFRAME_FACE_LARGE_FRAC,
      DEFAULT_PLAN_OPTIONS.faceLargeFrac
    ),
    pipMaxFrac: positive(env.REFRAME_PIP_MAX_FRAC, 0.5),
    pipEdgeMin: positive(env.REFRAME_PIP_EDGE_MIN, 4.0),
    // Exact literal, the REFRAME_STREAM rule: a killswitch that can be flipped
    // by accident is not one.
    motion: env.REFRAME_MOTION === "on",
    // Exact literal, the REFRAME_STREAM rule.
    cutRecovery: env.REFRAME_CUT_RECOVERY === "on",
    camera: {
      deadzoneFrac: positive(env.REFRAME_CAM_DEADZONE, DEFAULT_CAMERA.deadzoneFrac),
      settleFrac: positive(env.REFRAME_CAM_SETTLE, DEFAULT_CAMERA.settleFrac),
      maxSpeedFrac: positive(env.REFRAME_CAM_MAX_SPEED, DEFAULT_CAMERA.maxSpeedFrac),
      maxKeyframes: positive(env.REFRAME_CAM_MAX_KEYFRAMES, DEFAULT_CAMERA.maxKeyframes),
    },
  };
}
