import { DEFAULT_PLAN_OPTIONS, DEFAULT_STREAM_FACE_CEILING } from "./options";
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
  /** Rect-first stream classification ceiling (spec 2026-08-19-stream-reframe-v2
   *  D5). Optional for the same reason as PlanOptions.streamFaceCeiling -
   *  existing hand-built ReframeConfig literals elsewhere in the tree don't
   *  need updating for a new knob; loadReframeConfig always sets it below. */
  streamFaceCeiling?: number;
  /** Virtual cam tile killswitch (spec 2026-08-19-stream-reframe-v2 D4).
   *  Required, not optional: unlike `streamFaceCeiling` this is a boolean
   *  feature switch in the `stream`/`motion`/`cutRecovery` family, so
   *  loadReframeConfig always sets it and an omitted value would be a
   *  silent-disable footgun, not a harmless default. */
  streamVirtualCam: boolean;
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
  /** MUSIC-ONLY plan hint (spec 2026-08-23-music-shorts v1.1, PlanOptions.
   *  musicMode). No env knob - render.ts's music branch is the only writer,
   *  overriding this on the cfg object it builds per job (same idiom as its
   *  `stream`/`streamVirtualCam` overrides beside it). loadReframeConfig
   *  never sets it, so every env-sourced config leaves it undefined. */
  musicMode?: boolean;
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
    streamFaceCeiling: positive(
      env.REFRAME_STREAM_FACE_CEILING,
      DEFAULT_STREAM_FACE_CEILING
    ),
    // Exact literal, the REFRAME_STREAM rule: a stray truthy value must not
    // re-layout someone's clip.
    streamVirtualCam: env.REFRAME_STREAM_VIRTUAL_CAM === "on",
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
