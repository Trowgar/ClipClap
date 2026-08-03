import type { CamRect, StreamGeometry } from "./types";

const OUT_W = 1080;
const OUT_H = 1920;
export const CAM_SHARE_MIN = 0.3;
const CAM_SHARE_MAX = 0.55;
const SHARE_STEP = 0.025;

/** Same rounding as evenClamp in plan.ts, so the two agree at .5 values. */
export function evenRound(v: number): number {
  return 2 * Math.round(v / 2);
}

/** Largest even value <= v. Use for UPPER bounds - evenRound would exceed them. */
export function evenFloor(v: number): number {
  return 2 * Math.floor(v / 2);
}

/** Smallest even value >= v. Use for LOWER bounds. */
export function evenCeil(v: number): number {
  return 2 * Math.ceil(v / 2);
}

/**
 * Even value nearest `ideal` within [lo, hi]. The bounds are tightened to even
 * BEFORE the clamp, so the result can never be rounded back outside them - the
 * ordering that produced a crop past the frame edge in review.
 */
export function clampEven(ideal: number, lo: number, hi: number): number {
  const loEven = evenCeil(lo);
  const hiEven = evenFloor(hi);
  if (hiEven < loEven) return Math.max(0, hiEven);
  return Math.min(Math.max(evenRound(ideal), loEven), hiEven);
}

export interface Band {
  x: number;
  w: number;
}

/** The wider of the two horizontal strips the inset does not cover. */
export function freeBand(camRect: CamRect, sourceWidth: number): Band {
  const left: Band = { x: 0, w: Math.max(0, camRect.x) };
  const right: Band = {
    x: camRect.x + camRect.w,
    w: Math.max(0, sourceWidth - (camRect.x + camRect.w)),
  };
  return right.w >= left.w ? right : left;
}

export interface StreamSolveInput {
  sourceWidth: number;
  sourceHeight: number;
  camRect: CamRect;
  camShare: number;
}

/**
 * Solves both tiles from one free parameter.
 *
 *   Hg = Hs * OUT_W / Wg     content tile height
 *   Hc = OUT_H - Hg          cam tile height
 *
 * The relationship inverts the obvious adjustment: a TALLER cam tile needs a
 * WIDER content window, because a shorter content tile is proportionally wider.
 * So when the window will not fit the free band, the share is reduced.
 *
 * Returns null when no allowed share fits - rendering the inset twice, once
 * large and once as a sliced fragment, is worse than not splitting at all.
 */
export function solveStreamGeometry(
  input: StreamSolveInput
): StreamGeometry | null {
  const { sourceWidth: ws, sourceHeight: hs, camRect } = input;
  if (camRect.w < 2 || camRect.h < 2) return null;
  // The caller resolves one rect per clip from per-shot detections (medians
  // taken independently per axis), so a rect that lies outside the source is
  // not hypothetical - do not trust it. A crop past the frame edge is ffmpeg
  // error -22, raised after every fallback, failing the render outright.
  if (camRect.x < 0 || camRect.y < 0) return null;
  if (camRect.x + camRect.w > ws || camRect.y + camRect.h > hs) return null;
  const band = freeBand(camRect, ws);
  const start = Math.min(CAM_SHARE_MAX, Math.max(CAM_SHARE_MIN, input.camShare));

  for (let share = start; share >= CAM_SHARE_MIN - 1e-9; share -= SHARE_STEP) {
    const targetCamH = evenRound(share * OUT_H);
    const targetContentH = OUT_H - targetCamH;
    // Unreachable while CAM_SHARE_MAX <= 0.55 (targetContentH >= 864); kept so a
    // widened share range cannot silently produce a negative tile.
    if (targetContentH <= 0) continue;
    const contentW = evenRound((hs * OUT_W) / targetContentH);
    // contentW > ws is defence in depth: the in-frame guard above makes
    // band.w < ws hold by construction, so contentW > band.w already implies
    // contentW > ws in every reachable case.
    if (contentW < 2 || contentW > ws || contentW > band.w) continue;

    // Re-derive from the rounded width so the tiles sum to OUT_H exactly.
    const outContentH = evenRound((hs * OUT_W) / contentW);
    const outCamH = OUT_H - outContentH;
    // Also unreachable while CAM_SHARE_MAX <= 0.55, for the same reason as above.
    if (outCamH < 2 || outContentH < 2) continue;

    // Cover-crop the inset to the cam tile's aspect: one branch or the other
    // always yields a rectangle inside camRect.
    const aspect = OUT_W / outCamH;
    let camW: number;
    let camH: number;
    if (camRect.w / camRect.h >= aspect) {
      camH = camRect.h;
      camW = evenRound(camH * aspect);
    } else {
      camW = camRect.w;
      camH = evenRound(camW / aspect);
    }
    camW = Math.min(evenRound(camW), evenFloor(camRect.w));
    camH = Math.min(evenRound(camH), evenFloor(camRect.h));
    if (camW < 2 || camH < 2) continue;

    const camY = clampEven(
      camRect.y + (camRect.h - camH) / 2,
      camRect.y,
      camRect.y + camRect.h - camH
    );

    return {
      camCrop: { w: camW, h: camH, y: camY },
      contentCrop: { w: contentW, h: hs },
      outCamH,
      outContentH,
    };
  }
  return null;
}

/** Cam window centred on the face, clamped inside the inset. */
export function streamCamX(
  camRect: CamRect,
  camW: number,
  faceCenterX: number
): number {
  return clampEven(
    faceCenterX - camW / 2,
    camRect.x,
    camRect.x + camRect.w - camW
  );
}

/** Content window centred on the target, clamped into the free band. */
export function streamContentX(
  band: Band,
  contentW: number,
  sourceWidth: number,
  targetCenterX: number
): number {
  return clampEven(
    targetCenterX - contentW / 2,
    Math.max(0, band.x),
    Math.min(band.x + band.w, sourceWidth) - contentW
  );
}
