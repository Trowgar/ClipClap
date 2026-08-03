export interface Shot {
  start: number; // clip-relative seconds
  end: number;
}

export interface FaceTrack {
  id: number;
  /** Median box across the track's samples, SOURCE pixels. */
  box: { x: number; y: number; w: number; h: number };
  score: number; // mean detection confidence
  samples: number; // detections associated into this track
  mouthActivity: number; // mean abs mouth-region diff between samples, 0..1
}

export interface ShotTracks {
  shotIndex: number;
  tracks: FaceTrack[];
}

export type ShotLayout =
  | { start: number; end: number; layout: "center"; x: number }
  | { start: number; end: number; layout: "single"; x: number }
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
  version: 1 | 2;
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

/** Webcam inset in SOURCE pixels. x/y even and inside frame; w/h even. */
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
}
