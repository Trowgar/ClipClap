import type { CamRect } from "./types";

/** Shots may disagree by this much of frame width and still count as agreeing. */
const AGREE_TOL_FRAC = 0.02;

export interface CamRectResolution {
  rect: CamRect | null;
  /** Why there is no rect. Absent when one was resolved. */
  reason?: "stream_no_rect" | "stream_rect_unstable";
}

/** Upper middle on even-length input: sorted[floor(n/2)], not an average of the two middles. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Collapses per-shot rects into one clip-level rect. The inset is static in
 * real OBS scenes, so disagreement means the scene composition changes
 * mid-clip - and that is a reason to decline, not to average.
 */
export function resolveCamRect(
  perShot: Array<CamRect | null>,
  sourceWidth: number,
  sourceHeight: number
): CamRectResolution {
  const found = perShot.filter((r): r is CamRect => r !== null);
  if (found.length === 0 || found.length * 2 < perShot.length) {
    return { rect: null, reason: "stream_no_rect" };
  }

  const rect = {
    x: median(found.map((r) => r.x)),
    y: median(found.map((r) => r.y)),
    w: median(found.map((r) => r.w)),
    h: median(found.map((r) => r.h)),
    score: median(found.map((r) => r.score)),
  };

  const tol = AGREE_TOL_FRAC * sourceWidth;
  const agree = found.filter(
    (r) =>
      Math.abs(r.x - rect.x) <= tol &&
      Math.abs(r.y - rect.y) <= tol &&
      Math.abs(r.w - rect.w) <= tol &&
      Math.abs(r.h - rect.h) <= tol
  );
  // Require a strict MAJORITY of the shots that found anything, not merely
  // "at least half". Measured against found.length (not perShot.length): a
  // clean 50/50 split - half the shots left, half right - always leaves the
  // median sitting exactly on one side, so exactly half of `found` agrees
  // with it by construction. "at least half" (`<=` against perShot.length,
  // or a non-strict comparison) never trips on that tie and would silently
  // average across a scene change. Only a strict majority catches it.
  if (agree.length * 2 <= found.length) {
    return { rect: null, reason: "stream_rect_unstable" };
  }

  // Snap outward, then clamp BOTH axes back inside the frame.
  //
  // The medians of y and h are taken independently, so they can disagree: two
  // shots of a bottom-flush inset that are each in frame (y=842,h=238 and
  // y=844,h=236 on a 1080-tall source) yield the upper medians y=844 and h=238,
  // a bottom edge of 1082. That reaches ffmpeg as a crop past the source and
  // fails the encode with error -22, after every fallback in the pipeline.
  // Clamping width alone - which is what an earlier draft of this did - leaves
  // exactly that hole open on the vertical axis.
  const x = Math.max(0, 2 * Math.floor(rect.x / 2));
  const y = Math.max(0, 2 * Math.floor(rect.y / 2));
  const w = 2 * Math.ceil((rect.x + rect.w - x) / 2);
  const h = 2 * Math.ceil((rect.y + rect.h - y) / 2);
  return {
    rect: {
      x,
      y,
      w: Math.min(w, 2 * Math.floor((sourceWidth - x) / 2)),
      h: Math.min(h, 2 * Math.floor((sourceHeight - y) / 2)),
      score: rect.score,
    },
  };
}
