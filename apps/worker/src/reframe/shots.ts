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

/** A scene change scdet reported BELOW the cut threshold: not a shot boundary
 *  on its own, but a place the cut-recovery layer may confirm with the face
 *  tracks. `t` is clip-relative seconds, `score` is ffmpeg's lavfi.scene_score. */
export interface CutCandidate {
  t: number;
  score: number;
}

export interface DetectedShots {
  shots: Shot[];
  candidates: CutCandidate[];
}

/**
 * A long window with ZERO cuts is re-read at half the threshold: dark
 * same-studio podcast cuts score in the 0.3-0.4 band and a missed cut merges
 * different camera angles into one mega-shot whose mixed face tracks force a
 * center layout (the empty-frame bug). Over-segmentation is self-healing -
 * adjacent same-geometry shots merge back in the plan pass - while
 * under-segmentation is not, so the retry only ever errs on the safe side.
 *
 * Since 2026-08-17 the retry is a FILTER, not a second ffmpeg run: scdet is
 * asked once for every frame scoring at least CANDIDATE_FLOOR, with the score
 * printed, and cuts / retry cuts / candidates are all read off that one list.
 * The scene score of a frame does not depend on the select threshold, so the
 * cut set at the configured threshold is exactly what the old single-threshold
 * pass returned.
 */
const LONG_TAKE_RETRY_SEC = 15;
const RETRY_THRESHOLD_FLOOR = 0.15;
/** Lowest score scdet is asked to report; the bottom of the candidate band. */
export const CANDIDATE_FLOOR = RETRY_THRESHOLD_FLOOR;

/**
 * Pairs each selected frame's `pts_time` with the `lavfi.scene_score` that
 * `metadata=print` writes right after it. Token order, not line structure:
 * ffmpeg's progress line ends in \r and can share a physical line with a
 * metadata line. A frame without a score fails the whole pass - the frame
 * cannot be classified, and a wrong cut list is worse than the legacy
 * fallback the caller degrades to.
 */
export function parseSceneScores(stderr: string): CutCandidate[] {
  const out: CutCandidate[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)|lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/g;
  let pending: number | null = null;
  for (const m of stderr.matchAll(re)) {
    if (m[1] !== undefined) {
      if (pending !== null) throw new Error("scdet_score_missing");
      pending = Number(m[1]);
    } else if (pending !== null) {
      out.push({ t: pending, score: Number(m[2]) });
      pending = null;
    }
  }
  if (pending !== null) throw new Error("scdet_score_missing");
  return out;
}

/** Pure: which scored frames are cuts (with the long-take retry applied) and
 *  which remain candidates. Candidates never overlap cuts. */
export function classifyCuts(
  scored: CutCandidate[],
  durationSec: number,
  sceneThreshold: number
): { cuts: number[]; candidates: CutCandidate[] } {
  let cutThreshold = sceneThreshold;
  let cuts = scored.filter((s) => s.score >= cutThreshold).map((s) => s.t);
  if (cuts.length === 0 && durationSec >= LONG_TAKE_RETRY_SEC) {
    cutThreshold = Math.max(RETRY_THRESHOLD_FLOOR, sceneThreshold / 2);
    cuts = scored.filter((s) => s.score >= cutThreshold).map((s) => s.t);
  }
  const candidates = scored.filter(
    (s) => s.score >= CANDIDATE_FLOOR && s.score < cutThreshold
  );
  return { cuts, candidates };
}

export async function detectShots(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<DetectedShots> {
  const scored = await scdetPass(
    sourcePath,
    startSec,
    endSec,
    Math.min(CANDIDATE_FLOOR, cfg.sceneThreshold),
    timeoutMs
  );
  const duration = endSec - startSec;
  const { cuts, candidates } = classifyCuts(scored, duration, cfg.sceneThreshold);
  return { shots: cutsToShots(cuts, duration, cfg.minShotSec), candidates };
}

/**
 * Runs ffmpeg scene detection on the highlight window only, at 320px width.
 * Timestamps are clip-relative because -ss precedes -i. `-nostats` drops the
 * progress line, which is noise here and only makes stderr bigger.
 */
async function scdetPass(
  sourcePath: string,
  startSec: number,
  endSec: number,
  threshold: number,
  timeoutMs: number
): Promise<CutCandidate[]> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-nostats",
      "-ss", String(startSec),
      "-to", String(endSec),
      "-i", sourcePath,
      "-vf", `scale=320:-2,select='gte(scene,${threshold})',metadata=print`,
      "-f", "null", "-",
    ],
    { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return parseSceneScores(stderr);
}
