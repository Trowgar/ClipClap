import { describe, expect, it } from "vitest";
import {
  buildCropPlan,
  cropWidthFor,
  evenClamp,
  planLayoutCounts,
  sliceCropPlan,
  tileWidthFor,
} from "../reframe/plan";
import type { CropPlan, FaceTrack, Shot, ShotTracks } from "../reframe/types";
import { DEFAULT_PLAN_OPTIONS } from "../reframe/options";

const W = 1920;
const H = 1080;

function track(x: number, w: number, extra?: Partial<FaceTrack>): FaceTrack {
  return {
    id: 0,
    box: { x, y: 200, w, h: w * 1.3 },
    score: 0.9,
    samples: 10,
    mouthActivity: 0.05,
    ...extra,
  };
}

const oneShot: Shot[] = [{ start: 0, end: 30 }];
const withTracks = (tracks: FaceTrack[]): ShotTracks[] => [
  { shotIndex: 0, tracks },
];

describe("geometry helpers", () => {
  it("computes even crop and tile widths", () => {
    expect(cropWidthFor(1080)).toBe(608);
    expect(tileWidthFor(1080)).toBe(1216);
  });

  it("clamps into frame and rounds to even", () => {
    expect(evenClamp(-50, 608, W)).toBe(0);
    expect(evenClamp(5000, 608, W)).toBe(1312);
    expect(evenClamp(101, 608, W)).toBe(102);
  });
});

describe("buildCropPlan layouts", () => {
  it("screenshot 1 regression: a single off-center face gets a single face crop", () => {
    // face at 600..1000, center 800 -> window x = 800 - 304 = 496
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });

  it("screenshot 2 regression: a far-apart duet becomes a split, left on top", () => {
    // A center 275 -> tile x clamps to 0; B center 1645 -> clamps to 704
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(1570, 150, { id: 1 }), track(200, 150)]),
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
    ]);
  });

  it("zero faces fall back to a centered window", () => {
    const plan = buildCropPlan(oneShot, withTracks([]), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("two close faces that fit one window stay single, centered on the pair", () => {
    // faces 700..850 and 950..1100: bbox 700..1100 = 400 <= 0.9*608
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(700, 150), track(950, 150, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 596 }]);
  });

  it("three faces with a clear dominant pair split on that pair", () => {
    const tiny = track(940, 130, { id: 2, mouthActivity: 0 });
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(200, 300), tiny, track(1400, 300, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots[0].layout).toBe("split");
  });

  it("three similar faces with no dominant pair fall back to center", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 300),
        track(800, 300, { id: 1 }),
        track(1500, 300, { id: 2 }),
      ]),
      W,
      H
    );
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "center", x: 656 });
  });

  it("ignores 1-sample noise tracks", () => {
    const noise = track(1500, 200, { id: 1, samples: 1 });
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400), noise]), W, H);
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "single", x: 496 });
  });

  it("returns null when the source is already 9:16 or narrower", () => {
    expect(buildCropPlan(oneShot, withTracks([]), 608, 1080)).toBeNull();
    expect(buildCropPlan([], [], W, H)).toBeNull();
  });

  it("square source with far-apart faces centers instead of splitting", () => {
    // 1080x1080: tileW 1216 > 1080 so a split's crop would exceed iw and fail
    // the encode (error -22). The narrow-source guard must center instead.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(50, 150), track(880, 150, { id: 1 })]),
      1080,
      1080
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 236 }]);
  });

  it("square source still crops a single face (cropW 608 < 1080)", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(300, 200)]), 1080, 1080);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 96 }]);
  });

  it("drops a stray low-sample track and stays single on the dominant face", () => {
    // dominant has 10 samples; the edge stray has 2 < 0.3*10 -> filtered out,
    // so the fit bbox stays narrow and the shot resolves to a single crop.
    const stray = track(1700, 150, { id: 1, samples: 2 });
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400), stray]), W, H);
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "single", x: 496 });
  });
});

describe("adjacent-shot merging", () => {
  const twoShots: Shot[] = [
    { start: 0, end: 10 },
    { start: 10, end: 30 },
  ];

  it("merges same-layout shots with near-identical geometry, first x wins", () => {
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(600, 400)] },
        { shotIndex: 1, tracks: [track(620, 400)] }, // dx 20 < 4% of 1920
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });

  it("keeps shots separate when the offset moves for real", () => {
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(600, 400)] },
        { shotIndex: 1, tracks: [track(1100, 400)] },
      ],
      W,
      H
    );
    expect(plan!.shots).toHaveLength(2);
  });

  it("merges center-center adjacent shots into one window", () => {
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [] },
        { shotIndex: 1, tracks: [] },
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("merges split-split adjacent shots, first tile geometry wins", () => {
    // shot 0 tiles resolve to top 0 / bottom 704; shot 1's left face nudges the
    // top tile to 52 (dx < 4% of iw) so the pair merges keeping shot 0 geometry.
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(1570, 150, { id: 1 }), track(200, 150)] },
        { shotIndex: 1, tracks: [track(1570, 150, { id: 1 }), track(585, 150)] },
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
    ]);
  });

  it("keeps split-split shots separate when a tile moves past 4% of iw", () => {
    // shot 1's left face pushes the top tile to 192 (dx > 4% of 1920) -> no merge.
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(1570, 150, { id: 1 }), track(200, 150)] },
        { shotIndex: 1, tracks: [track(1570, 150, { id: 1 }), track(725, 150)] },
      ],
      W,
      H
    );
    expect(plan!.shots).toHaveLength(2);
    expect(plan!.shots.every((s) => s.layout === "split")).toBe(true);
  });
});

describe("plan complexity cap", () => {
  it("returns null when the merged plan exceeds the ffmpeg expression cap", () => {
    // 95 alternating single crops never merge (dx 1312 >> 4% of iw), exceeding
    // MAX_PLAN_SHOTS so the plan bails rather than nesting 95 if() segments.
    const shots: Shot[] = Array.from({ length: 95 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 2,
    }));
    const tracksByShot: ShotTracks[] = shots.map((_, i) => ({
      shotIndex: i,
      tracks: [i % 2 === 0 ? track(100, 300) : track(1500, 300)],
    }));
    expect(buildCropPlan(shots, tracksByShot, W, H)).toBeNull();
  });
});

describe("sliceCropPlan (trim re-render)", () => {
  const plan: CropPlan = {
    version: 1,
    engine: "faces",
    source: { width: W, height: H },
    shots: [
      { start: 0, end: 12.4, layout: "single", x: 496 },
      { start: 12.4, end: 31, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
      { start: 31, end: 57.5, layout: "center", x: 656 },
    ],
  };

  it("re-windows shots to the trim range like sliceCues", () => {
    const sliced = sliceCropPlan(plan, 10, 40);
    expect(sliced!.shots).toEqual([
      { start: 0, end: 2.4000000000000004, layout: "single", x: 496 },
      { start: 2.4000000000000004, end: 21, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
      { start: 21, end: 30, layout: "center", x: 656 },
    ]);
  });

  it("returns null for an empty window or wrong version", () => {
    expect(sliceCropPlan(plan, 100, 120)).toBeNull();
    expect(sliceCropPlan({ ...plan, version: 2 as unknown as 1 }, 0, 10)).toBeNull();
  });

  it("returns null for a foreign/corrupt stored Json instead of throwing", () => {
    // A version:1 shell with no shots array must not blow up downstream.
    expect(sliceCropPlan({ version: 1 } as unknown as CropPlan, 0, 10)).toBeNull();
    // shots present but not an array (foreign Json shape).
    expect(
      sliceCropPlan(
        {
          version: 1,
          engine: "faces",
          source: { width: 1920, height: 1080 },
          shots: "garbage",
        } as unknown as CropPlan,
        0,
        10
      )
    ).toBeNull();
    // missing source dimensions.
    expect(
      sliceCropPlan(
        { version: 1, engine: "faces", shots: [] } as unknown as CropPlan,
        0,
        10
      )
    ).toBeNull();
  });
});

describe("planLayoutCounts", () => {
  it("counts layouts for telemetry", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H);
    expect(planLayoutCounts(plan!)).toEqual({ single: 1, split: 0, center: 0 });
  });
});

describe("min-face guard", () => {
  it("centres instead of anchoring on a face below 6% of frame width", () => {
    // 1920 * 0.06 = 115.2, so a 40px face is far below the floor.
    const plan = buildCropPlan(oneShot, withTracks([track(900, 40)]), W, H);
    expect(plan?.shots[0].layout).toBe("center");
  });

  it("still anchors on a face at or above the floor", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(900, 120)]), W, H);
    expect(plan?.shots[0].layout).toBe("single");
  });

  it("a tiny central track no longer vetoes a real pair through dominance", () => {
    // The speck scores lowest and never enters the pair - but without the
    // guard its centrality lifts the third-place score enough to fail
    // DOMINANCE_LEAD, which flipped the whole shot to center.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(100, 200), track(1600, 200), track(950, 30)]),
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
    ]);
  });

  it("anchors on a face exactly at the floor, and centres just below it", () => {
    // The floor is exclusive: 0.06 * 1920 = 115.2, so 116 anchors and 115 does not.
    expect(
      buildCropPlan(oneShot, withTracks([track(900, 116)]), W, H)?.shots[0].layout
    ).toBe("single");
    expect(
      buildCropPlan(oneShot, withTracks([track(900, 115)]), W, H)?.shots[0].layout
    ).toBe("center");
  });

  it("reads the floor from opts rather than hardcoding it", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(900, 120)]), W, H, {
      ...DEFAULT_PLAN_OPTIONS,
      faceSmallFrac: 0.2,
    });
    expect(plan?.shots[0].layout).toBe("center");
  });
});
