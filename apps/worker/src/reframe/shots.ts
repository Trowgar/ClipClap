import { execFile } from "child_process";
import { promisify } from "util";
import type { ReframeConfig } from "./config";
import type { Shot } from "./types";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
const execFileAsync = promisify(execFile);

/**
 * Pure: scene-cut times (clip-relative) -> shot list covering [0, duration].
 * Segments shorter than minShotSec merge forward into the next segment
 * (the cut is simply dropped); a too-short tail merges backward into the
 * last shot. Anti-flicker per spec §5.1.
 */
export function cutsToShots(
  cutTimes: number[],
  duration: number,
  minShotSec: number
): Shot[] {
  if (!(duration > 0)) return [];
  const cuts = [...new Set(cutTimes)]
    .filter((t) => t > 0 && t < duration)
    .sort((a, b) => a - b);
  const shots: Shot[] = [];
  let pendingStart = 0;
  for (const t of [...cuts, duration]) {
    if (t - pendingStart < minShotSec) {
      if (t === duration) {
        if (shots.length > 0) shots[shots.length - 1].end = duration;
        else shots.push({ start: pendingStart, end: duration });
      }
      continue; // drop the cut - segment keeps growing into the next one
    }
    shots.push({ start: pendingStart, end: t });
    pendingStart = t;
  }
  return shots;
}

/**
 * Runs ffmpeg scene detection on the highlight window only, at 320px width.
 * Timestamps in showinfo output are clip-relative because -ss precedes -i.
 *
 * A long window with ZERO cuts is retried once at half the threshold: dark
 * same-studio podcast cuts score in the 0.3-0.4 band and a missed cut merges
 * different camera angles into one mega-shot whose mixed face tracks force a
 * center layout (the empty-frame bug). Over-segmentation is self-healing -
 * adjacent same-geometry shots merge back in the plan pass - while
 * under-segmentation is not, so the retry only ever errs on the safe side.
 */
const LONG_TAKE_RETRY_SEC = 15;
const RETRY_THRESHOLD_FLOOR = 0.15;

export async function detectShots(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<Shot[]> {
  let cuts = await scdetPass(sourcePath, startSec, endSec, cfg.sceneThreshold, timeoutMs);
  if (cuts.length === 0 && endSec - startSec >= LONG_TAKE_RETRY_SEC) {
    cuts = await scdetPass(
      sourcePath,
      startSec,
      endSec,
      Math.max(RETRY_THRESHOLD_FLOOR, cfg.sceneThreshold / 2),
      timeoutMs
    );
  }
  return cutsToShots(cuts, endSec - startSec, cfg.minShotSec);
}

async function scdetPass(
  sourcePath: string,
  startSec: number,
  endSec: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-ss", String(startSec),
      "-to", String(endSec),
      "-i", sourcePath,
      "-vf", `scale=320:-2,select='gte(scene,${threshold})',showinfo`,
      "-f", "null", "-",
    ],
    { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)].map((m) =>
    Number(m[1])
  );
}
