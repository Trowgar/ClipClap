import { describe, expect, it } from "vitest";
import { faceTracksToRegions } from "../reframe/regions";
import type { FaceTrack, Shot } from "../reframe/types";

describe("faceTracksToRegions", () => {
  it("normalizes only path samples within the inclusive shot span", () => {
    const tracks: FaceTrack[] = [
      {
        id: 7,
        // Deliberately unlike the path: the median box must never be used.
        box: { x: 900, y: 800, w: 50, h: 50 },
        score: 0.91,
        samples: 4,
        mouthActivity: 0.2,
        path: [
          { t: 0.5, x: 10, y: 20, w: 30, h: 40 },
          { t: 1, x: 100, y: 110, w: 120, h: 130 },
          { t: 3, x: 300, y: 310, w: 320, h: 330 },
          { t: 3.5, x: 350, y: 360, w: 370, h: 380 },
        ],
      },
      {
        id: 8,
        box: { x: 1, y: 2, w: 3, h: 4 },
        score: 0.75,
        samples: 1,
        mouthActivity: 0,
      },
      {
        id: 9,
        box: { x: 5, y: 6, w: 7, h: 8 },
        score: 0.62,
        samples: 1,
        mouthActivity: 0,
        path: [{ t: -1, x: 50, y: 60, w: 70, h: 80 }],
      },
    ];
    const original = JSON.parse(JSON.stringify(tracks));
    const span: Shot = { start: 1, end: 3 };

    expect(faceTracksToRegions(tracks, span, "job-ephemeral")).toEqual([
      {
        id: "job-ephemeral:face-7",
        kind: "face",
        priority: "mandatory",
        samples: [
          { t: 1, box: { x: 100, y: 110, w: 120, h: 130 }, confidence: 0.91 },
          { t: 3, box: { x: 300, y: 310, w: 320, h: 330 }, confidence: 0.91 },
        ],
      },
    ]);
    expect(tracks).toEqual(original);
  });
});
