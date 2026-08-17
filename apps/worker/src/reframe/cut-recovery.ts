import type { CutCandidate } from "./shots";
import type { FaceBox, FaceTrack, PathSample, Shot, ShotTracks } from "./types";
import { survivingTracks } from "./plan";

/**
 * Cut recovery: confirms scdet candidates (scene score in the 0.15-0.30 band,
 * see shots.ts) with the face tracks and splits the detector shot there.
 *
 * WHY. scdet at 0.3 under-scores real camera cuts in dark studios and dim film
 * scenes (0.29, 0.30 on the Alipov podcast; La Brea's Veronica clip). One
 * detector shot then spans two framings and the median-box window is a
 * compromise between angles that never coexist - a cup and a microphone for
 * 2.4s, the back of a head for 6.5s. A lower global threshold trades that
 * defect for false cuts on graphics (a 0.5s lamp shot on ar-habits). So the
 * pixel signal nominates and the face signal confirms: a candidate is a cut
 * when the set of faces on screen just before it and just after it are
 * disjoint, both sides have a face, and both sub-shots clear the shot floor.
 *
 * WHAT IT NEVER DOES. It never merges, never moves an existing boundary,
 * never invents a boundary scdet did not nominate, and returns its inputs by
 * reference when nothing is confirmed - so with the flag off (or no
 * candidates) the plan is today's plan byte for byte. The tracker, the sidecar
 * and buildCropPlan are not touched; sub-shot tracks are rebuilt from the
 * sidecar's own per-sample `path`.
 *
 * Spec: docs/superpowers/specs/2026-08-17-cut-recovery-design.md §2b.
 */

export interface CutRecoveryConfig {
  minShotSec: number;
  sampleFps: number;
  /** Cap on the PRE-merge shot count. buildCropPlan returns null above
   *  MAX_PLAN_SHOTS merged shots - a whole-clip fallback - and the pre-merge
   *  count bounds the merged count, so capping here keeps that unreachable. */
  maxPlanShots: number;
}

export interface CutRecoveryTelemetry {
  /** Candidates that fell strictly inside a shot; boundary-exact ones are
   *  already cuts and are not counted. */
  candidates: number;
  confirmed: number;
  rejected: { noTurnover: number; oneSideEmpty: number; tooShort: number; noPath: number };
  capHit: number;
}

export type CutDecision =
  | "confirmed"
  | "noTurnover"
  | "oneSideEmpty"
  | "tooShort"
  | "noPath"
  | "capHit";

export interface CutRecoveryResult {
  shots: Shot[];
  tracksByShot: ShotTracks[];
  telemetry: CutRecoveryTelemetry;
  /** Per-candidate verdicts in shot order - for the eval, not persisted.
   *  `shotIndex` is the PRE-recovery (detector) shot index. */
  decisions: Array<{ shotIndex: number; t: number; score: number; verdict: CutDecision }>;
}

/** Samples on each side of a candidate whose live face sets must be disjoint.
 *  Two at 2 fps = 1.0s: one is fragile to a single dropped detection, three
 *  reaches into neighbouring shots on fast-cut material. */
export const TURNOVER_SAMPLES = 2;

function emptyTelemetry(): CutRecoveryTelemetry {
  return {
    candidates: 0,
    confirmed: 0,
    rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
    capHit: 0,
  };
}

/** Ids of the tracks with at least one path sample in [from, to). */
function liveIds(tracks: FaceTrack[], from: number, to: number): Set<number> {
  const ids = new Set<number>();
  for (const tr of tracks) {
    if (tr.path?.some((p) => p.t >= from && p.t < to)) ids.add(tr.id);
  }
  return ids;
}

function disjoint(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

// Averages the two middles - np.median's convention, which is what the
// sidecar used for the parent box (detect_faces.py), so a sliced sub-shot box
// is exactly what the sidecar would have emitted for that sub-range.
// cam-rect.ts deliberately takes the UPPER middle for a different reason; do
// not unify the two.
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function medianBox(samples: PathSample[]): FaceBox {
  return {
    x: median(samples.map((p) => p.x)),
    y: median(samples.map((p) => p.y)),
    w: median(samples.map((p) => p.w)),
    h: median(samples.map((p) => p.h)),
  };
}

/**
 * The parent's tracks restricted to one sub-range: same id, median box over
 * the samples in range, `samples` = their count, score and mouthActivity
 * copied. The final segment keeps every sample from `from` on, including any
 * the sidecar filed past the shot end. A track with no sample in the range is
 * dropped.
 */
export function sliceTracks(
  tracks: FaceTrack[],
  from: number,
  to: number,
  inclusiveEnd: boolean
): FaceTrack[] {
  const out: FaceTrack[] = [];
  for (const tr of tracks) {
    const samples = (tr.path ?? []).filter(
      (p) => p.t >= from && (inclusiveEnd || p.t < to)
    );
    if (samples.length === 0) continue;
    out.push({
      id: tr.id,
      box: medianBox(samples),
      score: tr.score,
      samples: samples.length,
      mouthActivity: tr.mouthActivity,
      path: samples,
    });
  }
  return out;
}

export function recoverCuts(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  candidates: CutCandidate[],
  cfg: CutRecoveryConfig
): CutRecoveryResult {
  const telemetry = emptyTelemetry();
  const decisions: CutRecoveryResult["decisions"] = [];
  const byIndex = new Map(tracksByShot.map((s) => [s.shotIndex, s]));
  const winSec = TURNOVER_SAMPLES / cfg.sampleFps;
  let budget = cfg.maxPlanShots - shots.length;

  const outShots: Shot[] = [];
  const outTracks: ShotTracks[] = [];
  let anyConfirmed = false;

  shots.forEach((shot, i) => {
    const st = byIndex.get(i);
    const inShot = candidates
      .filter((c) => c.t > shot.start && c.t < shot.end)
      .sort((a, b) => a.t - b.t);
    telemetry.candidates += inShot.length;
    const decide = (c: CutCandidate, verdict: CutDecision) => {
      decisions.push({ shotIndex: i, t: c.t, score: c.score, verdict });
      if (verdict === "confirmed") telemetry.confirmed += 1;
      else if (verdict === "capHit") telemetry.capHit += 1;
      else telemetry.rejected[verdict] += 1;
    };

    const splits: number[] = [];
    if (inShot.length > 0) {
      const tracks = st?.tracks ?? [];
      const pathMissing = tracks.some((t) => !Array.isArray(t.path));
      if (pathMissing) {
        for (const c of inShot) decide(c, "noPath");
      } else {
        const surviving = survivingTracks(tracks);
        let segStart = shot.start;
        for (const c of inShot) {
          const before = liveIds(surviving, c.t - winSec, c.t);
          const after = liveIds(surviving, c.t, c.t + winSec);
          if (before.size === 0 || after.size === 0) {
            decide(c, "oneSideEmpty");
            continue;
          }
          if (!disjoint(before, after)) {
            decide(c, "noTurnover");
            continue;
          }
          if (c.t - segStart < cfg.minShotSec || shot.end - c.t < cfg.minShotSec) {
            decide(c, "tooShort");
            continue;
          }
          if (budget <= 0) {
            decide(c, "capHit");
            continue;
          }
          decide(c, "confirmed");
          splits.push(c.t);
          segStart = c.t;
          budget -= 1;
        }
      }
    }

    if (splits.length === 0) {
      outShots.push(shot);
      outTracks.push(st ?? { shotIndex: i, tracks: [], camRect: null });
      return;
    }
    anyConfirmed = true;
    const bounds = [shot.start, ...splits, shot.end];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const from = bounds[k];
      const to = bounds[k + 1];
      outShots.push({ start: from, end: to });
      outTracks.push({
        shotIndex: -1, // renumbered below
        tracks: sliceTracks(st!.tracks, from, to, k + 2 === bounds.length),
        camRect: st!.camRect,
      });
    }
  });

  if (!anyConfirmed) return { shots, tracksByShot, telemetry, decisions };

  const renumbered = outTracks.map((s, idx) =>
    s.shotIndex === idx ? s : { ...s, shotIndex: idx }
  );
  return { shots: outShots, tracksByShot: renumbered, telemetry, decisions };
}
