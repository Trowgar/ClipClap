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

export interface ShotRegionEvidence {
  regions: FocalRegionTrack[];
  hasMandatoryRegions: boolean;
  invalid: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function validPathSample(value: unknown, span: Shot, previousTime: number): boolean {
  const sample = record(value);
  if (!sample) return false;
  const t = sample.t;
  return (
    Number.isFinite(t) &&
    Number.isFinite(sample.x) &&
    Number.isFinite(sample.y) &&
    Number.isFinite(sample.w) &&
    Number.isFinite(sample.h) &&
    (sample.w as number) > 0 &&
    (sample.h as number) > 0 &&
    (t as number) >= span.start &&
    (t as number) <= span.end &&
    (t as number) >= previousTime
  );
}

/** Adapt surviving detector tracks while preserving invalid evidence for the
 * active planner. A single malformed track invalidates the shot; its valid
 * peers are retained only for diagnostics and compatibility consumers. */
export function faceTracksToRegionEvidence(
  surviving: FaceTrack[],
  span: Shot,
  idPrefix: string
): ShotRegionEvidence {
  const tracks = Array.isArray(surviving) ? surviving : [];
  if (tracks.length === 0) {
    return { regions: [], hasMandatoryRegions: false, invalid: false };
  }

  let invalid =
    !Number.isFinite(span.start) ||
    !Number.isFinite(span.end) ||
    !(span.end >= span.start);
  const regions: FocalRegionTrack[] = [];
  for (const rawTrack of tracks) {
    const track = record(rawTrack);
    const path = track?.path;
    const pathSamples: unknown[] = Array.isArray(path) ? path : [];
    let valid = pathSamples.length > 0;
    let previousTime = Number.NEGATIVE_INFINITY;
    if (valid) {
      for (const rawSample of pathSamples) {
        if (!validPathSample(rawSample, span, previousTime)) {
          valid = false;
          break;
        }
        previousTime = (record(rawSample)!.t as number);
      }
    }
    if (!valid) {
      invalid = true;
      continue;
    }
    const score = track?.score;
    regions.push({
      id: `${idPrefix}:face-${String(track?.id)}`,
      kind: "face",
      priority: "mandatory",
      samples: pathSamples.map((rawSample) => {
        const sample = record(rawSample)!;
        return {
          t: sample.t as number,
          box: {
            x: sample.x as number,
            y: sample.y as number,
            w: sample.w as number,
            h: sample.h as number,
          },
          confidence: score as number,
        };
      }),
    });
  }
  return { regions, hasMandatoryRegions: true, invalid };
}

export function faceTracksToRegions(
  tracks: FaceTrack[],
  span: Shot,
  idPrefix: string
): FocalRegionTrack[] {
  // Legacy adapter semantics are intentionally retained for the shadow and
  // replay readers: paths are clipped to the requested span and tracks with
  // no in-span samples disappear. Active planning uses the strict evidence
  // adapter above, where the original path itself is trusted or rejected as a
  // whole.
  return tracks.flatMap((track) => {
    const samples = (track.path ?? [])
      .filter(({ t }) => t >= span.start && t <= span.end)
      .map(({ t, x, y, w, h }) => ({
        t,
        box: { x, y, w, h },
        confidence: track.score,
      }));
    if (samples.length === 0) return [];
    return [{
      id: `${idPrefix}:face-${track.id}`,
      kind: "face" as const,
      priority: "mandatory" as const,
      samples,
    }];
  });
}
