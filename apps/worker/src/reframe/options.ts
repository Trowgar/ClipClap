/**
 * Thresholds that decide WHICH layout a shot gets. Unlike the geometry
 * constants in plan.ts (which are deliberately not env knobs), these rest on a
 * single measured fixture and are expected to move once real stream sources
 * arrive - so they are overridable.
 */
import { DEFAULT_CAMERA, type CameraConfig } from "./camera";

export interface PlanOptions {
  /** Strictly below this fraction of frame width, a face may not anchor a crop. */
  faceSmallFrac: number;
  /** At or above this fraction, the existing single/split logic applies. */
  faceLargeFrac: number;
  /** Emit the stream layout at all. */
  stream: boolean;
  /** Target cam tile share of output height. */
  camShare: number;
  /** Emit crop-window trajectories at all. Off means every plan is byte-
   *  identical to the static-window one that ships today.
   *
   *  Optional, unlike every field above it, and deliberately: the callers that
   *  hand-build a PlanOptions literal (`reframe/index.ts`, the config seam
   *  test) predate this field, and absent must mean exactly what `false` means.
   *  Making it required would force those call sites to write `motion: false`
   *  to say what omitting it already says. */
  motion?: boolean;
  /** How the window moves once motion is on. Never decides whom it follows.
   *  Absent falls back to DEFAULT_CAMERA, which is what `motion: false` renders
   *  moot anyway. */
  camera?: CameraConfig;
}

export const DEFAULT_PLAN_OPTIONS: Readonly<PlanOptions> = Object.freeze({
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
  motion: false,
  camera: DEFAULT_CAMERA,
});
