import type { FaceBox, FaceTrack, Shot } from "./types";

export type RegionKind = "face" | "saliency" | "ui" | "text";

export interface FocalRegionSample {
  t: number;
  box: FaceBox;
  confidence: number;
}

export interface FocalRegionTrack {
  id: string;
  kind: RegionKind;
  priority: "mandatory" | "supporting";
  samples: FocalRegionSample[];
}

export function faceTracksToRegions(
  tracks: FaceTrack[],
  span: Shot,
  idPrefix: string
): FocalRegionTrack[] {
  return tracks.flatMap((track) => {
    const samples = (track.path ?? [])
      .filter(({ t }) => t >= span.start && t <= span.end)
      .map(({ t, x, y, w, h }) => ({
        t,
        box: { x, y, w, h },
        confidence: track.score,
      }));

    if (samples.length === 0) return [];
    return [
      {
        id: `${idPrefix}:face-${track.id}`,
        kind: "face",
        priority: "mandatory",
        samples,
      },
    ];
  });
}
