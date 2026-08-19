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

export interface ShotTracks {
  shotIndex: number;
  tracks: FaceTrack[];
  /** Null when the sidecar found no inset, or is an older build. */
  camRect: CamRect | null;
}

export type ShotLayout =
  | { start: number; end: number; layout: "center"; x: number }
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
