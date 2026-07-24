import { execFile } from "child_process";
import { promisify } from "util";
import type { ReframeConfig } from "./config";
import type { Shot } from "./types";

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
 */
export async function detectShots(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<Shot[]> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-ss", String(startSec),
      "-to", String(endSec),
      "-i", sourcePath,
      "-vf", `scale=320:-2,select='gte(scene,${cfg.sceneThreshold})',showinfo`,
      "-f", "null", "-",
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
  );
  const cuts = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)].map(
    (m) => Number(m[1])
  );
  return cutsToShots(cuts, endSec - startSec, cfg.minShotSec);
}
