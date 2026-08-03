import type { CropPlan, FaceTrack, Shot, ShotLayout, ShotTracks } from "./types";
import { DEFAULT_PLAN_OPTIONS, type PlanOptions } from "./options";

// Layout constants - tuned via fixtures, deliberately NOT env knobs (spec §7).
const FIT_MARGIN = 0.9; // face bbox must fit in 90% of the crop window
const DOMINANCE_LEAD = 1.5; // top-2 must each lead the 3rd by this factor
const MERGE_DX_FRAC = 0.04; // same-layout shots merge when |dx| < 4% of iw
const MIN_TRACK_SAMPLES = 2; // 1-sample tracks are detector noise
const MIN_SAMPLE_FRAC = 0.3; // tracks seen in <30% of the dominant track's samples are transient noise
const MAX_PLAN_SHOTS = 90; // ffmpeg av_expr nesting fails at ~100 segments; headroom below that
const W_AREA = 0.5;
const W_CENTER = 0.3;
const W_MOUTH = 0.2;

export function cropWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 16 / 2);
}

export function tileWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 8 / 2);
}

export function evenClamp(x: number, cropW: number, sourceWidth: number): number {
  const clamped = Math.min(Math.max(0, x), sourceWidth - cropW);
  return 2 * Math.round(clamped / 2);
}

export function dominance(
  t: FaceTrack,
  sourceWidth: number,
  sourceHeight: number
): number {
  const area = (t.box.w * t.box.h) / (sourceWidth * sourceHeight);
  const cx = t.box.x + t.box.w / 2;
  const centrality = 1 - Math.abs(cx - sourceWidth / 2) / (sourceWidth / 2);
  return (
    W_AREA * Math.min(1, area * 20) +
    W_CENTER * centrality +
    W_MOUTH * Math.min(1, t.mouthActivity * 10)
  );
}

export function buildCropPlan(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  sourceWidth: number,
  sourceHeight: number,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS
): CropPlan | null {
  if (shots.length === 0) return null;
  const cropW = cropWidthFor(sourceHeight);
  const tileW = tileWidthFor(sourceHeight);
  // Already vertical or narrower: nothing to reframe, let the legacy path run.
  if (cropW >= sourceWidth) return null;
  // Split tiles need ih*9/8 of width; on narrower-than-9:8 sources a split
  // would emit crop w > iw and fail the encode (error -22) - center instead.
  const splitPossible = tileW <= sourceWidth;
  const centerX = evenClamp((sourceWidth - cropW) / 2, cropW, sourceWidth);
  const minFaceWidth = opts.faceSmallFrac * sourceWidth;
  const byIndex = new Map(tracksByShot.map((s) => [s.shotIndex, s.tracks]));

  const layouts = shots.map((shot, i): ShotLayout => {
    const shotTracks = byIndex.get(i) ?? [];
    const maxSamples = Math.max(0, ...shotTracks.map((t) => t.samples));
    // Keep only tracks that clear the noise floor AND are seen often enough
    // relative to the dominant track - a stray low-sample track must not widen
    // the fit bbox or become a split tile pointing at nothing.
    const tracks = shotTracks.filter(
      (t) =>
        t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
    );
    // Measured 3.4% of frame width on a 1280x720 stream VOD, against 15-30%
    // for podcasts and facecams. A face this small is a webcam inset or a
    // bystander; centring a 9:16 window on it yields a truncated inset plus
    // whatever overlay sits under it (spec §4.1).
    const anchorable = tracks.filter((t) => t.box.w >= minFaceWidth);
    if (anchorable.length === 0) {
      return { start: shot.start, end: shot.end, layout: "center", x: centerX };
    }
    const minX = Math.min(...anchorable.map((t) => t.box.x));
    const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
    if (maxX - minX <= FIT_MARGIN * cropW) {
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
      return { start: shot.start, end: shot.end, layout: "single", x };
    }
    // Guard both split-producing paths (2-track and 3+ dominant-pair): a split
    // needs tileW <= sourceWidth or the encode fails with error -22.
    if (!splitPossible) {
      return { start: shot.start, end: shot.end, layout: "center", x: centerX };
    }
    let pair = anchorable;
    if (anchorable.length > 2) {
      const scored = [...anchorable].sort(
        (a, b) =>
          dominance(b, sourceWidth, sourceHeight) -
          dominance(a, sourceWidth, sourceHeight)
      );
      const third = dominance(scored[2], sourceWidth, sourceHeight);
      const clearLead =
        dominance(scored[0], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third &&
        dominance(scored[1], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third;
      if (!clearLead) {
        return { start: shot.start, end: shot.end, layout: "center", x: centerX };
      }
      pair = [scored[0], scored[1]];
    }
    const [left, right] = [...pair].sort(
      (a, b) => a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2)
    );
    return {
      start: shot.start,
      end: shot.end,
      layout: "split",
      top: { x: evenClamp(left.box.x + left.box.w / 2 - tileW / 2, tileW, sourceWidth) },
      bottom: {
        x: evenClamp(right.box.x + right.box.w / 2 - tileW / 2, tileW, sourceWidth),
      },
    };
  });

  const merged = mergeAdjacentLayouts(layouts, sourceWidth);
  // piecewiseX nests one if() per shot; ffmpeg's av_expr parser fails at 100
  // nested segments ("Missing ')' or too many args"). Bail so the orchestrator
  // falls back to a plain centered crop rather than emitting a broken graph.
  if (merged.length > MAX_PLAN_SHOTS) return null;
  return {
    version: 1,
    engine: "faces",
    source: { width: sourceWidth, height: sourceHeight },
    shots: merged,
  };
}

/** Same layout + near-identical geometry -> one window; the FIRST shot's
 *  geometry wins so the virtual camera stays put on soft scene cuts. */
export function mergeAdjacentLayouts(
  shots: ShotLayout[],
  sourceWidth: number
): ShotLayout[] {
  const maxDx = MERGE_DX_FRAC * sourceWidth;
  const merged: ShotLayout[] = [];
  for (const shot of shots) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const same =
        (prev.layout === "center" && shot.layout === "center") ||
        (prev.layout === "single" &&
          shot.layout === "single" &&
          Math.abs(prev.x - shot.x) <= maxDx) ||
        (prev.layout === "split" &&
          shot.layout === "split" &&
          Math.abs(prev.top.x - shot.top.x) <= maxDx &&
          Math.abs(prev.bottom.x - shot.bottom.x) <= maxDx);
      if (same) {
        prev.end = shot.end;
        continue;
      }
    }
    merged.push({ ...shot });
  }
  return merged;
}

/** Re-window a stored plan to a [start, end] sub-range of the same clip
 *  (mirror of sliceCues). Null when nothing overlaps or version is unknown. */
export function sliceCropPlan(
  plan: CropPlan,
  start: number,
  end: number
): CropPlan | null {
  if (
    !plan ||
    (plan.version !== 1 && plan.version !== 2) ||
    !Array.isArray(plan.shots) ||
    !plan.source ||
    typeof plan.source.width !== "number" ||
    typeof plan.source.height !== "number" ||
    !(end > start)
  ) {
    return null;
  }
  const shots = plan.shots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - start),
      end: Math.min(end - start, s.end - start),
    }));
  if (shots.length === 0) return null;
  return { ...plan, shots };
}

export function planLayoutCounts(
  plan: CropPlan
): Record<"single" | "split" | "center" | "stream", number> {
  const counts = { single: 0, split: 0, center: 0, stream: 0 };
  for (const s of plan.shots) counts[s.layout] += 1;
  return counts;
}
