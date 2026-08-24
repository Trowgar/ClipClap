export interface Shot {
  start: number; // clip-relative seconds
  end: number;
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One detector sample of one track. `t` is clip-relative seconds. */
export interface PathSample extends FaceBox {
  t: number;
}

export interface FaceTrack {
  id: number;
  /** Median box across the track's samples, SOURCE pixels. */
  box: FaceBox;
  score: number; // mean detection confidence
  samples: number; // detections associated into this track
  mouthActivity: number; // mean abs mouth-region diff between samples, 0..1
  /** Per-sample boxes, SOURCE pixels, sorted by t. Absent from older sidecar
   *  builds, which is not a contract violation. */
  path?: PathSample[];
}

/** A point on the crop window's trajectory. `t` is clip-relative seconds, `x`
 *  is the window's LEFT edge in source pixels - the same quantity as the
 *  legacy `ShotLayout.single.x`. */
export interface Keyframe {
  t: number;
  x: number;
}

/** Per-shot visual-mass summary from the detector's column edge energy (spec
 *  2026-08-23-music-shorts v1.1). `x` is the energy centroid column in SOURCE
 *  px; `spreadFrac` is the fraction of columns needed to cover 70% of the
 *  shot's total energy - small when the mass sits in a narrow cluster (a
 *  subject against a plain background), large when it is spread across the
 *  frame (a busy/close-up shot). Consulted ONLY under an explicit musicMode
 *  (plan.ts anchors a faceless shot's centre crop on it; filtergraph.ts gates
 *  the punch-in zoom on it) - see detect_faces.py's saliency_from_columns. */
export interface Saliency {
  x: number;
  spreadFrac: number;
}

/**
 * SHADOW TELEMETRY ONLY (spec 2026-08-24-camera-visual-anchoring, mechanism
 * B). What an ACTIVE saliency anchor would have computed for a faceless
 * (center-fallback) shot OUTSIDE music mode - recorded, never applied. The
 * shot's real `x` stays plain `centerX` regardless of this field's presence;
 * see `ShotLayout`'s "center" variant and `plan.ts`'s `saliencyShadowFor`.
 * `centroidX`/`spreadFrac` are the raw sidecar `Saliency` values for this
 * shot; `suggestedX` is what `centerXForShot` would have returned;
 * `deltaPx` is `suggestedX - centerX` (source px, can be negative).
 */
export interface SaliencyShadow {
  centroidX: number;
  spreadFrac: number;
  suggestedX: number;
  deltaPx: number;
}

export interface ShotTracks {
  shotIndex: number;
  tracks: FaceTrack[];
  /** Null when the sidecar found no inset, or is an older build. */
  camRect: CamRect | null;
  /** Absent on an older sidecar build (backward compatible); null when the
   *  shot had no sampled frames. Both mean "no saliency data" to every
   *  consumer - see `Saliency`. */
  saliency?: Saliency | null;
}

export type ShotLayout =
  | {
      start: number;
      end: number;
      layout: "center";
      x: number;
      /** MUSIC-ONLY (spec 2026-08-23-music-shorts v1.1): this shot's
       *  saliency.spreadFrac, carried onto the plan so filtergraph.ts can
       *  gate the punch-in without re-deriving it. Absent off the music path
       *  and on any shot with no saliency data. */
      spreadFrac?: number;
      /** SHADOW TELEMETRY ONLY (spec 2026-08-24-camera-visual-anchoring,
       *  mechanism B). Present only when REFRAME_SALIENCY_SHADOW=on AND
       *  musicMode is false AND the sidecar had saliency data for this shot.
       *  Never applied to `x` above - see `SaliencyShadow`. Absent on every
       *  other shot, including every music-mode shot (which already applies
       *  saliency actively via `spreadFrac`/`x` instead). */
      saliencyShadow?: SaliencyShadow;
    }
  | {
      start: number;
      end: number;
      layout: "single";
      /** LEGACY median x. Unchanged from v2, and never the first value of `xs`
       *  - a consumer that ignores `xs` must render exactly what v2 rendered,
       *  which is what makes "flag off equals today" falsifiable. */
      x: number;
      /** Trajectory, present only when the camera actually moves. */
      xs?: Keyframe[];
      /** MUSIC-ONLY, same field and meaning as on the "center" variant above. */
      spreadFrac?: number;
    }
  | {
      start: number;
      end: number;
      layout: "split";
      top: { x: number };
      bottom: { x: number };
    }
  | {
      start: number;
      end: number;
      layout: "stream";
      cam: { x: number };
      content: { x: number };
    };

export interface CropPlan {
  version: 1 | 2 | 3;
  engine: "faces";
  source: { width: number; height: number };
  profile?: SourceProfile;
  /** Present iff at least one shot has layout "stream". */
  stream?: StreamGeometry;
  shots: ShotLayout[];
}

export type FilterSpec =
  | { kind: "vf"; graph: string }
  | { kind: "complex"; graph: string };

export type SourceClass = "faceless" | "normal_face" | "small_face" | "stream";

/**
 * Webcam inset in SOURCE pixels, as reported by the detector: possibly
 * fractional, possibly extending past the frame. `resolveCamRect` is what
 * makes a rect even and in-frame; consumers downstream of it may rely on
 * that, consumers upstream may not.
 */
export interface CamRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Minimum of the four border energies, normalised by frame mean. */
  score: number;
}

/** Clip-constant tile geometry. Only the two x offsets vary per shot. */
export interface StreamGeometry {
  camCrop: { w: number; h: number; y: number };
  contentCrop: { w: number; h: number };
  outCamH: number;
  outContentH: number;
}

/**
 * Music-only render-direction options (spec 2026-08-23-music-shorts, tasks
 * R1/R3/R4). Born ONCE in the render stage's music branch (where task M4's
 * `loadReframeConfigForJob` already fires) and threaded explicitly into
 * `buildFiltergraph` and `buildCutArgs` - not an env knob, because none of
 * this is operator-tunable: it always follows the music path, never anything
 * an operator flips independently of it.
 *
 * `topBar`/`bottomBar` are 0 when no CONSTANT letterbox bar was detected on
 * the source (transient bars, e.g. one dark scene, must never be cropped -
 * see `reframe/letterbox.ts`); a zero pair is a valid, common value, not an
 * error state. `punchIn`/`fades` are flat feature bits rather than the mere
 * presence of this object, so a test (or a mutation) can disable one without
 * touching the other.
 */
export interface MusicDirectionOpts {
  topBar: number;
  bottomBar: number;
  punchIn: boolean;
  fades: boolean;
}

export interface SourceProfile {
  class: SourceClass;
  /** Widest surviving face box width as a fraction of source width. */
  faceFrac: number;
  camRectScore?: number;
  reason?: string;
  /**
   * Set to `true` only on a `stream` profile whose camRect was synthesized
   * from the face box rather than detected (D4, spec
   * 2026-08-19-stream-reframe-v2 §3): the borderless/chroma-key cams that
   * `find_cam_rect` can never see (tox's true sides score 0.31/0.62 against
   * edge_min 4.0). Absent everywhere else, including on a real-rect `stream`
   * profile - never `false` - the repo's "not a key" discipline, so telemetry
   * can tell virtual from real by presence alone.
   */
  virtualCam?: true;
}
