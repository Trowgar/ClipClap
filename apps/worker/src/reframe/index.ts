import { execFile } from "child_process";
import { promisify } from "util";
import { loadReframeConfig, type ReframeConfig } from "./config";
import { detectShots, type CutCandidate } from "./shots";
import { detectFaces } from "./faces";
import { buildCropPlan, MAX_PLAN_SHOTS } from "./plan";
import { resolveCamRect } from "./cam-rect";
import { recoverCuts, type CutRecoveryResult, type CutRecoveryTelemetry } from "./cut-recovery";
import type { PlanOptions } from "./options";
import type { CropPlan, Shot, ShotTracks } from "./types";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

export type ReframeFallbackReason =
  | "scdet_failed"
  | "detector_failed"
  | "detector_invalid_json"
  | "timeout"
  | "plan_empty";

export interface ReframeResult {
  plan: CropPlan | null;
  fallbackReason?: ReframeFallbackReason;
  detectMs: number;
  /** DETECTOR shots, before cut recovery; the recovered count is plan.shots.length. */
  shotCount: number;
  /** Present iff cut recovery ran (flag on and detection succeeded). */
  cutRecovery?: CutRecoveryTelemetry;
}

/** Everything the detectors produced for one range - what the planner is a
 *  pure function of. Exposed so the eval can plan ONE detection twice
 *  (flag off / flag on) and compare. */
export interface Detection {
  width: number;
  height: number;
  shots: Shot[];
  candidates: CutCandidate[];
  tracksByShot: ShotTracks[];
}

export type DetectionResult =
  | { ok: true; detection: Detection; shotCount: number }
  | { ok: false; fallbackReason: ReframeFallbackReason; shotCount: number };

// execFile kills on timeout with error.killed=true
function isTimeout(error: unknown): boolean {
  return Boolean((error as { killed?: boolean } | null)?.killed);
}

async function probeDimensions(
  path: string,
  timeoutMs: number
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      path,
    ],
    { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

/**
 * Probe -> shots -> faces, under one wall-clock deadline (absolute ms).
 * Never throws: every failure comes back as ok:false with a machine-readable
 * reason, and the caller falls back to the legacy center crop (spec §8).
 */
export async function detectRange(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  deadlineMs: number
): Promise<DetectionResult> {
  const remaining = () => Math.max(1000, deadlineMs - Date.now());
  let shotCount = 0;
  try {
    const { width, height } = await probeDimensions(sourcePath, remaining());
    const detected = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = detected.shots.length;
    let tracks: ShotTracks[];
    try {
      tracks = await detectFaces(
        sourcePath, startSec, endSec, detected.shots, width, height, cfg, remaining()
      );
    } catch (error) {
      if (isTimeout(error)) return { ok: false, fallbackReason: "timeout", shotCount };
      if ((error as Error).message === "detector_invalid_json") {
        return { ok: false, fallbackReason: "detector_invalid_json", shotCount };
      }
      return { ok: false, fallbackReason: "detector_failed", shotCount };
    }
    return {
      ok: true,
      shotCount,
      detection: {
        width,
        height,
        shots: detected.shots,
        candidates: detected.candidates,
        tracksByShot: tracks,
      },
    };
  } catch (error) {
    return {
      ok: false,
      fallbackReason: isTimeout(error) ? "timeout" : "scdet_failed",
      shotCount,
    };
  }
}

export interface PlannedDetection {
  plan: CropPlan | null;
  cutRecovery?: CutRecoveryTelemetry;
  /** Per-candidate verdicts, for the eval only - never copied into
   *  ReframeResult or the manifest. */
  decisions?: CutRecoveryResult["decisions"];
}

/** Coverage floor below which a `virtualCam` plan is re-planned with stream
 *  disabled (spec 2026-08-24-render-retry-and-stream-gate §2). A
 *  single-corpus provisional constant: the 3 measured false positives landed
 *  5.7-20.5%, the 7 true positives 97.5-100% - 55pp margin either way at this
 *  value. Exported so tests can pin the exact boundary. */
export const STREAM_SHOT_COVERAGE_MIN = 0.75;

/** Fraction of `plan`'s total shot duration covered by shots laid out
 *  "stream", 0 when the plan has no shots at all. The coverage gate's only
 *  input - see `STREAM_SHOT_COVERAGE_MIN`. */
function streamShotFrac(plan: CropPlan): number {
  let streamSec = 0;
  let totalSec = 0;
  for (const shot of plan.shots) {
    const dur = shot.end - shot.start;
    totalSec += dur;
    if (shot.layout === "stream") streamSec += dur;
  }
  return totalSec > 0 ? streamSec / totalSec : 0;
}

/**
 * Pure: the plan for a detection. Cut recovery runs iff cfg.cutRecovery - the
 * ONE place that policy lives. The clip-level cam rect is resolved on the
 * DETECTOR shots, before recovery, so repeating one parent's rect across its
 * sub-shots cannot swing resolveCamRect's majority vote.
 */
export function planDetected(d: Detection, cfg: ReframeConfig): PlannedDetection {
  const cam = resolveCamRect(d.tracksByShot.map((t) => t.camRect), d.width, d.height);
  let shots = d.shots;
  let tracks = d.tracksByShot;
  let cutRecovery: CutRecoveryTelemetry | undefined;
  let decisions: CutRecoveryResult["decisions"] | undefined;
  if (cfg.cutRecovery) {
    const r = recoverCuts(shots, tracks, d.candidates, {
      minShotSec: cfg.minShotSec,
      sampleFps: cfg.sampleFps,
      maxPlanShots: MAX_PLAN_SHOTS,
    });
    shots = r.shots;
    tracks = r.tracksByShot;
    cutRecovery = r.telemetry;
    decisions = r.decisions;
  }
  const planOpts: PlanOptions = {
    faceSmallFrac: cfg.faceSmallFrac,
    faceLargeFrac: cfg.faceLargeFrac,
    stream: cfg.stream,
    camShare: cfg.camShare,
    // Threaded so REFRAME_STREAM_FACE_CEILING actually reaches the
    // classifier in production; omitting it would make the knob readable
    // from config but inert (spec 2026-08-19-stream-reframe-v2 D5).
    streamFaceCeiling: cfg.streamFaceCeiling,
    // Threaded so REFRAME_STREAM_VIRTUAL_CAM actually reaches the
    // classifier in production; omitting it would make the knob readable
    // from config but inert (spec 2026-08-19-stream-reframe-v2 D4).
    streamVirtualCam: cfg.streamVirtualCam,
    motion: cfg.motion,
    camera: cfg.camera,
    // Threaded so render.ts's music-branch override actually reaches the
    // planner; omitting it would make ReframeConfig.musicMode readable but
    // inert (spec 2026-08-23-music-shorts v1.1, mirrors streamFaceCeiling).
    musicMode: cfg.musicMode,
    // Threaded so REFRAME_SALIENCY_SHADOW actually reaches the planner in
    // production; omitting it would make the knob readable from config but
    // inert (spec 2026-08-24-camera-visual-anchoring mechanism B, mirrors
    // musicMode/streamFaceCeiling threading above).
    saliencyShadow: cfg.saliencyShadow,
  };
  let plan = buildCropPlan(shots, tracks, d.width, d.height, planOpts, cam);
  // Coverage gate (spec 2026-08-24-render-retry-and-stream-gate §2). Only a
  // SYNTHESIZED rect (profile.virtualCam true - see SourceProfile.virtualCam)
  // is in scope: the measured failure mode is a stream layout fabricated from
  // a short-lived junk face track, never a genuinely DETECTED inset, so a
  // real camRect (virtualCam false/absent) bypasses this unconditionally.
  // Re-planning calls buildCropPlan again over the exact same `shots`/`tracks`
  // /`cam` (no sidecar re-run - both are already pure over the detection),
  // with only `stream` flipped off; every other option - musicMode,
  // saliencyShadow, streamFaceCeiling, etc. - stays identical.
  if (
    cfg.streamCoverageGate &&
    plan?.profile?.virtualCam &&
    streamShotFrac(plan) < STREAM_SHOT_COVERAGE_MIN
  ) {
    // Minimal persisted stamp. Without it, the re-planned profile falls into
    // plan.ts's ordinary !camRect branch (reason "stream_no_rect" or
    // cam?.reason) - indistinguishable in the persisted cropPlan from a
    // source that never had stream signal at all, so the gate's first live
    // firing would be unfindable. Overwritten in place on the RE-PLANNED
    // profile (never virtualCam itself, since it was built with
    // stream:false) rather than threaded as a new telemetry struct through
    // PlannedDetection/ReframeResult - too wide for what this needs.
    const gatedCoverage = Math.round(streamShotFrac(plan) * 1000) / 1000;
    const replanned = buildCropPlan(
      shots, tracks, d.width, d.height, { ...planOpts, stream: false }, cam
    );
    plan = replanned?.profile
      ? {
          ...replanned,
          profile: { ...replanned.profile, reason: "stream_coverage_gated", gatedCoverage },
        }
      : replanned;
  }
  return {
    plan,
    ...(cutRecovery ? { cutRecovery } : {}),
    ...(decisions ? { decisions } : {}),
  };
}

/**
 * Shots -> faces -> layout, under one wall-clock budget (cfg.maxDetectSec).
 * Never throws: every failure returns plan:null with a machine-readable
 * reason, and the caller falls back to the legacy center crop (spec §8).
 */
export async function computeCropPlan(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig = loadReframeConfig()
): Promise<ReframeResult> {
  const startedAt = Date.now();
  const detected = await detectRange(
    sourcePath, startSec, endSec, cfg, startedAt + cfg.maxDetectSec * 1000
  );
  const detectMs = () => Date.now() - startedAt;
  if (!detected.ok) {
    return {
      plan: null,
      fallbackReason: detected.fallbackReason,
      shotCount: detected.shotCount,
      detectMs: detectMs(),
    };
  }
  // Parity with the pre-2026-08-17 shape, where buildCropPlan sat inside the
  // same try as the detectors: a planner throw is still a fallback, never an
  // exception out of this function.
  let planned: PlannedDetection;
  try {
    planned = planDetected(detected.detection, cfg);
  } catch (error) {
    console.warn(`[reframe] planner threw, falling back to the legacy crop:`, error);
    return {
      plan: null,
      fallbackReason: "scdet_failed",
      shotCount: detected.shotCount,
      detectMs: detectMs(),
    };
  }
  const telemetry = planned.cutRecovery ? { cutRecovery: planned.cutRecovery } : {};
  if (!planned.plan) {
    return {
      plan: null,
      fallbackReason: "plan_empty",
      shotCount: detected.shotCount,
      detectMs: detectMs(),
      ...telemetry,
    };
  }
  return { plan: planned.plan, shotCount: detected.shotCount, detectMs: detectMs(), ...telemetry };
}
