import type { Keyframe } from "./types";
import { evenClamp } from "./geometry";

/** Where the anchored face group's centre sits at one detector sample.
 *  `t` is clip-relative seconds, `cx` is source pixels. */
export interface TargetSample {
  t: number;
  cx: number;
}

export interface CameraConfig {
  /** Fraction of cropW the target may drift from the window centre before the
   *  camera starts moving. */
  deadzoneFrac: number;
  /** Fraction of cropW the target must be within before the camera stops. Must
   *  be smaller than deadzoneFrac - that difference IS the hysteresis, and
   *  without it the camera re-triggers on the sample after it stops and crawls
   *  permanently. */
  settleFrac: number;
  /** Fraction of cropW per second the window may travel. */
  maxSpeedFrac: number;
  /** Never emit more than this many keyframes; over it, the caller falls back
   *  to the legacy static x. */
  maxKeyframes: number;
}

/**
 * Provisional. These have no corpus support and their first real values come
 * from looking at the corpus render. Deliberately conservative - a camera that
 * moves too little looks like today, a camera that moves too much looks broken.
 */
export const DEFAULT_CAMERA: Readonly<CameraConfig> = Object.freeze({
  deadzoneFrac: 0.12,
  settleFrac: 0.04,
  maxSpeedFrac: 0.25,
  maxKeyframes: 200,
});

/**
 * Turns a per-sample target position into a crop-window trajectory.
 *
 * Deadzone plus eased follow plus a speed cap: the window holds still while the
 * target sits inside the deadzone, eases toward it when it leaves, and stops
 * once the target is inside the tighter settle band. Stillness is the default
 * state and motion is the exception.
 *
 * Returns null - meaning "emit no trajectory, use the legacy x" - when the
 * camera never moves, when there are fewer than two samples, or when the
 * trajectory would exceed `maxKeyframes`. **Never truncates**: a truncated ramp
 * parks the camera at a position no rule chose.
 *
 * This decides HOW to move. It never decides WHOM to follow: the group was
 * selected once per shot on the median boxes, exactly as before.
 */
export function solveCamera(
  targets: TargetSample[],
  legacyX: number,
  cropW: number,
  sourceWidth: number,
  spanStart: number,
  spanEnd: number,
  cfg: CameraConfig = DEFAULT_CAMERA
): Keyframe[] | null {
  if (targets.length < 2 || !(spanEnd > spanStart)) return null;

  const deadzone = cfg.deadzoneFrac * cropW;
  const settle = cfg.settleFrac * cropW;
  const maxSpeed = cfg.maxSpeedFrac * cropW;
  const ordered = [...targets].sort((a, b) => a.t - b.t);

  let x = legacyX;
  let moving = false;
  const raw: Keyframe[] = [{ t: spanStart, x }];

  for (const sample of ordered) {
    if (sample.t <= spanStart || sample.t > spanEnd) continue;
    const prevT = raw[raw.length - 1].t;
    const dt = sample.t - prevT;
    if (dt <= 0) continue;

    // Where the window would sit if it could teleport, clamped into frame.
    const desired = evenClamp(sample.cx - cropW / 2, cropW, sourceWidth);
    const err = desired - x;
    if (!moving && Math.abs(err) > deadzone) moving = true;
    if (moving) {
      const step = Math.sign(err) * Math.min(Math.abs(err), maxSpeed * dt);
      x = evenClamp(x + step, cropW, sourceWidth);
      if (Math.abs(desired - x) <= settle) moving = false;
    }
    raw.push({ t: sample.t, x });
  }

  if (raw[raw.length - 1].t < spanEnd) {
    raw.push({ t: spanEnd, x });
  }

  // Never moved: emitting a flat trajectory would only add expression length
  // and would make a clip that should be byte-identical to legacy not be.
  if (raw.every((k) => k.x === raw[0].x)) return null;

  const keys = dropCollinear(raw);
  if (keys.length < 2) return null;
  if (keys.length > cfg.maxKeyframes) return null;
  return keys;
}

/** Removes points the ramp expression does not need: a point whose slope in
 *  equals its slope out lies on the segment its neighbours already describe.
 *  Compared as a cross product rather than as two divisions, so a zero-length
 *  interval cannot divide by zero. */
function dropCollinear(keys: Keyframe[]): Keyframe[] {
  if (keys.length <= 2) return keys;
  const out: Keyframe[] = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out[out.length - 1];
    const b = keys[i];
    const c = keys[i + 1];
    const cross = (b.x - a.x) * (c.t - b.t) - (c.x - b.x) * (b.t - a.t);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(keys[keys.length - 1]);
  return out;
}
