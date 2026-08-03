/**
 * Thresholds that decide WHICH layout a shot gets. Unlike the geometry
 * constants in plan.ts (which are deliberately not env knobs), these rest on a
 * single measured fixture and are expected to move once real stream sources
 * arrive - so they are overridable.
 */
export interface PlanOptions {
  /** Strictly below this fraction of frame width, a face may not anchor a crop. */
  faceSmallFrac: number;
  /** At or above this fraction, the existing single/split logic applies. */
  faceLargeFrac: number;
  /** Emit the stream layout at all. */
  stream: boolean;
  /** Target cam tile share of output height. */
  camShare: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = Object.freeze({
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
});
