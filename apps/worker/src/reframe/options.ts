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
   *  Required, and that is the point. `false` and "I forgot" are the same
   *  runtime behaviour, so an optional field would let a future caller that
   *  hand-builds a PlanOptions literal disable this feature by omission, in
   *  silence, with every test still green - the one failure mode this layer
   *  cannot detect from the inside. Required, the compiler catches it instead.
   *  Callers that want today's behaviour say `motion: false` out loud, or
   *  spread DEFAULT_PLAN_OPTIONS. */
  motion: boolean;
  /** How the window moves once motion is on. Never decides whom it follows.
   *  Required for the same reason as `motion`: a caller that means DEFAULT_CAMERA
   *  should name it, since a wrong-but-plausible camera is invisible in a plan. */
  camera: CameraConfig;
}

export const DEFAULT_PLAN_OPTIONS: Readonly<PlanOptions> = Object.freeze({
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
  motion: false,
  camera: DEFAULT_CAMERA,
});
