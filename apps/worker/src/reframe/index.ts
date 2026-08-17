import { execFile } from "child_process";
import { promisify } from "util";
import { loadReframeConfig, type ReframeConfig } from "./config";
import { detectShots } from "./shots";
import { detectFaces } from "./faces";
import { buildCropPlan } from "./plan";
import { resolveCamRect } from "./cam-rect";
import type { CropPlan } from "./types";

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
  shotCount: number;
}

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
  const deadline = startedAt + cfg.maxDetectSec * 1000;
  const remaining = () => Math.max(1000, deadline - Date.now());
  const fail = (
    fallbackReason: ReframeFallbackReason,
    shotCount: number
  ): ReframeResult => ({
    plan: null,
    fallbackReason,
    shotCount,
    detectMs: Date.now() - startedAt,
  });

  let shotCount = 0;
  try {
    const { width, height } = await probeDimensions(sourcePath, remaining());
    // Candidates are ignored here until cut recovery is wired (Task 3).
    const { shots } = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = shots.length;
    let tracks;
    try {
      tracks = await detectFaces(
        sourcePath, startSec, endSec, shots, width, height, cfg, remaining()
      );
    } catch (error) {
      if (isTimeout(error)) return fail("timeout", shotCount);
      if ((error as Error).message === "detector_invalid_json") {
        return fail("detector_invalid_json", shotCount);
      }
      return fail("detector_failed", shotCount);
    }
    const cam = resolveCamRect(
      tracks.map((t) => t.camRect),
      width,
      height
    );
    const plan = buildCropPlan(
      shots,
      tracks,
      width,
      height,
      {
        faceSmallFrac: cfg.faceSmallFrac,
        faceLargeFrac: cfg.faceLargeFrac,
        stream: cfg.stream,
        camShare: cfg.camShare,
        motion: cfg.motion,
        camera: cfg.camera,
      },
      cam
    );
    if (!plan) return fail("plan_empty", shotCount);
    return { plan, shotCount, detectMs: Date.now() - startedAt };
  } catch (error) {
    return fail(isTimeout(error) ? "timeout" : "scdet_failed", shotCount);
  }
}
