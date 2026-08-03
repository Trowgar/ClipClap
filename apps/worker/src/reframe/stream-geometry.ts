import type { CamRect, StreamGeometry } from "./types";

export const OUT_W = 1080;
export const OUT_H = 1920;
export const CAM_SHARE_MIN = 0.3;
export const CAM_SHARE_MAX = 0.55;
const SHARE_STEP = 0.025;

/** Same rounding as evenClamp in plan.ts, so the two agree at .5 values. */
export function evenRound(v: number): number {
  return 2 * Math.round(v / 2);
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
  const band = freeBand(camRect, ws);
  const start = Math.min(CAM_SHARE_MAX, Math.max(CAM_SHARE_MIN, input.camShare));

  for (let share = start; share >= CAM_SHARE_MIN - 1e-9; share -= SHARE_STEP) {
    const targetCamH = evenRound(share * OUT_H);
    const targetContentH = OUT_H - targetCamH;
    if (targetContentH <= 0) continue;
    const contentW = evenRound((hs * OUT_W) / targetContentH);
    if (contentW < 2 || contentW > ws || contentW > band.w) continue;

    // Re-derive from the rounded width so the tiles sum to OUT_H exactly.
    const outContentH = evenRound((hs * OUT_W) / contentW);
    const outCamH = OUT_H - outContentH;
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
    camW = Math.min(evenRound(camW), evenRound(camRect.w));
    camH = Math.min(evenRound(camH), evenRound(camRect.h));
    if (camW < 2 || camH < 2) continue;

    const camY = Math.max(
      camRect.y,
      Math.min(
        evenRound(camRect.y + (camRect.h - camH) / 2),
        camRect.y + camRect.h - camH
      )
    );

    return {
      camCrop: { w: camW, h: camH, y: evenRound(camY) },
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
  const lo = camRect.x;
  const hi = Math.max(lo, camRect.x + camRect.w - camW);
  return evenRound(Math.min(Math.max(faceCenterX - camW / 2, lo), hi));
}

/** Content window centred on the target, clamped into the free band. */
export function streamContentX(
  band: Band,
  contentW: number,
  sourceWidth: number,
  targetCenterX: number
): number {
  const lo = Math.max(0, band.x);
  const hi = Math.max(lo, Math.min(band.x + band.w, sourceWidth) - contentW);
  return evenRound(Math.min(Math.max(targetCenterX - contentW / 2, lo), hi));
}
