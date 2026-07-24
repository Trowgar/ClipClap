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
    };

export interface CropPlan {
  version: 1;
  engine: "faces";
  source: { width: number; height: number };
  shots: ShotLayout[];
}

export type FilterSpec =
  | { kind: "vf"; graph: string }
  | { kind: "complex"; graph: string };
