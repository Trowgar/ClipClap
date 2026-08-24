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
  /** Ceiling below which the classifier ATTEMPTS the rect-first stream
   *  layout before falling back to the normal_face/small_face chain (spec
   *  2026-08-19-stream-reframe-v2 D5). Below this fraction of frame width, a
   *  resolvable camRect around the widest face wins classification BEFORE
   *  the normal_face floor is even consulted - this is what lets a real
   *  corner-cam stream (measured strogo/tox 0.076-0.077, both ABOVE
   *  faceSmallFrac 0.06) ever reach `stream`: under the old ordering they hit
   *  normal_face first and the rect was never asked. Podcasts measured at
   *  0.15-0.30 sit above it by design; tw-buster (0.089, fullscreen face) is
   *  safe under the ceiling only because no rect resolves on a fullscreen
   *  face, not because of the ceiling's position - a bigger ceiling alone was
   *  measured to degrade buster, the rect-first ORDERING is what protects it.
   *  Provisional until more corpus shapes exist.
   *
   *  Optional, unlike its siblings above: making it required would force
   *  every hand-built PlanOptions literal elsewhere in the tree (the eval
   *  scripts under src/scripts/) to be edited for a knob that did not exist
   *  when they were written. buildCropPlan falls back to
   *  DEFAULT_STREAM_FACE_CEILING when it is omitted, so those callers are
   *  unaffected by its addition. */
  streamFaceCeiling?: number;
  /** Synthesize a camRect from the widest face when stream is on, faceFrac
   *  sits under `streamFaceCeiling`, and no real rect was found or resolved
   *  (D4, spec 2026-08-19-stream-reframe-v2 §3): the only mechanism that can
   *  ever serve a borderless/chroma-key cam, which edge detection cannot see
   *  at all (tox's true sides measured 0.31/0.62 against edge_min 4.0).
   *  Provisional multipliers - see `synthesizeVirtualCamRect` in plan.ts.
   *
   *  Optional and defaults to false for the same reason as `streamFaceCeiling`:
   *  a knob that did not exist when the eval scripts' hand-built PlanOptions
   *  literals were written must not force them to be edited. buildCropPlan
   *  treats an omitted value as off, so those callers are unaffected. */
  streamVirtualCam?: boolean;
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
  /** MUSIC-ONLY (spec 2026-08-23-music-shorts v1.1): threaded from render.ts's
   *  music branch through ReframeConfig, mirroring how `streamFaceCeiling` is
   *  threaded. Gates two things, both scoped to a shot that would otherwise
   *  be blind to the detector's saliency data: a faceless (no anchorable
   *  face) shot anchors its centre crop on `saliency.x` instead of the frame
   *  centre, and every non-split/non-stream shot carries its
   *  `saliency.spreadFrac` onto the plan for filtergraph.ts's punch-in gate.
   *
   *  Optional and defaults to false/undefined for the same reason as
   *  `streamFaceCeiling`/`streamVirtualCam`: a knob that did not exist when
   *  the eval scripts' hand-built PlanOptions literals were written must not
   *  force them to be edited. Every non-music caller - which is every caller
   *  except render.ts's music branch - leaves this unset, and buildCropPlan
   *  then never reads a shot's saliency at all: byte-identical to v1. */
  musicMode?: boolean;
  /** SHADOW TELEMETRY ONLY (spec 2026-08-24-camera-visual-anchoring,
   *  mechanism B): threaded from render.ts's cfg through
   *  ReframeConfig.saliencyShadow, mirroring how `musicMode` is threaded.
   *  Never changes a shot's geometry - gates only whether a faceless
   *  (center-fallback) shot OUTSIDE music mode carries an extra
   *  `saliencyShadow` field recording what an ACTIVE anchor would have
   *  computed for it. See `plan.ts`'s `saliencyShadowFor`.
   *
   *  Optional and defaults to false for the same reason as `musicMode`: a
   *  knob that did not exist when the eval scripts' hand-built PlanOptions
   *  literals were written must not force them to be edited. Every caller
   *  that leaves this unset gets a cropPlan with no `saliencyShadow` field
   *  anywhere: byte-identical to today. */
  saliencyShadow?: boolean;
}

/** Default for `PlanOptions.streamFaceCeiling` and `ReframeConfig.streamFaceCeiling`
 *  - named so config.ts's env fallback and this file's default cannot drift
 *  apart (spec 2026-08-19-stream-reframe-v2 D5). */
export const DEFAULT_STREAM_FACE_CEILING = 0.15;

export const DEFAULT_PLAN_OPTIONS: Readonly<PlanOptions> = Object.freeze({
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
  streamFaceCeiling: DEFAULT_STREAM_FACE_CEILING,
  streamVirtualCam: false,
  motion: false,
  camera: DEFAULT_CAMERA,
  musicMode: false,
  saliencyShadow: false,
});
