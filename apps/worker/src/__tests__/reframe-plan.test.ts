import { describe, expect, it } from "vitest";
import {
  attachTrajectories,
  buildCropPlan,
  buildTargetSamples,
  cropWidthFor,
  evenClamp,
  planLayoutCounts,
  selectGroupForShot,
  sliceCropPlan,
  tileWidthFor,
} from "../reframe/plan";
// DEFAULT_CAMERA lives in camera.ts and plan.ts does not re-export it, so this
// is a second import statement by necessity, not by preference.
import { DEFAULT_CAMERA } from "../reframe/camera";
import type {
  CamRect,
  CropPlan,
  FaceTrack,
  Shot,
  ShotTracks,
} from "../reframe/types";
import { DEFAULT_PLAN_OPTIONS } from "../reframe/options";

const W = 1920;
const H = 1080;
// A split needs two ih*9/8 tiles side by side, i.e. 2.25h of width, so 16:9
// can never carry one (engine-notes §7b). Split cases therefore need a source
// wide enough to hold both tiles apart: 3200x1080 is 2.96:1, tileW 1216, max
// tile x 1984.
const WIDE_W = 3200;

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
  { shotIndex: 0, tracks, camRect: null },
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

  it("a far-apart duet becomes a split where the tiles fit apart, left on top", () => {
    // 3200x1080: A center 600 -> tile x 0 (clamped); B center 2500 -> 1892.
    // Separation 1892 >= tileW 1216, so the two tiles share no pixel.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(2400, 200, { id: 1 }), track(500, 200)]),
      WIDE_W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 1892 } },
    ]);
  });

  it("screenshot 2 regression: the same 16:9 duet anchors instead of stacking", () => {
    // Two 1216-wide tiles need 2430 of width; this source has 1920, so the
    // tiles would overlap by 512px whatever the faces do. Anchor on the face
    // with the most face area instead - here the wider left one, centre 690.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(1570, 150, { id: 1 }), track(600, 180)]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 386 }]);
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
    // The middle face is 200px against a 192px floor, so it survives the
    // min-face guard and DOMINANCE_LEAD's accept side really is under test:
    // 0.675 and 0.675 against 1.5 * 0.432 = 0.648.
    const tiny = track(1400, 200, { id: 2, mouthActivity: 0 });
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(100, 600), tiny, track(2500, 600, { id: 1 })]),
      WIDE_W,
      H
    );
    expect(plan!.shots[0].layout).toBe("split");
  });

  it("three similar faces with no dominant pair anchor instead of centring", () => {
    // DOMINANCE_LEAD fails (0.79 vs 1.5 * 0.56), and the old code centred on a
    // window whose nearest face centre was 0.51 cropW away. Anchor on the best
    // group instead: three equal-area singletons, so the most central wins.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 300),
        track(1200, 300, { id: 1 }),
        track(2800, 300, { id: 2 }),
      ]),
      WIDE_W,
      H
    );
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "single", x: 1046 });
  });

  it("three similar faces on 16:9 anchor on the most central face", () => {
    // The 12-of-16 case from engine-notes §7b: anchorable faces, no dominant
    // pair, and the old planner centred blind at x = 656 with the nearest face
    // centre 0.48 cropW away. Faces at 250 / 950 / 1650, frame centre 960.
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
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "single", x: 646 });
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

  it("square source with far-apart faces anchors on the bigger face", () => {
    // 1080x1080: tileW 1216 > 1080, so a split's crop would exceed iw and fail
    // the encode (error -22). The disjointness gate refuses it; the shot then
    // anchors on the larger face (200px beats 150px) rather than centring.
    // Ideal x is 626, clamped to 1080 - 608 = 472, which still holds all of it.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(50, 150), track(830, 200, { id: 1 })]),
      1080,
      1080
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 472 }]);
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

describe("split gate: two tiles must be able to sit apart", () => {
  // tileWidthFor(720) = 810 exactly, so 2 * tileW = 1620 = 720 * 2.25. This
  // family puts the aspect floor on a pixel boundary; at 1080 high the tile
  // rounds UP to 1216 and the true floor is 2432, not 2430.
  const SH = 720;
  const far = withTracks([track(60, 150), track(1400, 150, { id: 1 })]);

  it("splits at exactly 2.25:1, where the tiles abut and share nothing", () => {
    const plan = buildCropPlan(oneShot, far, 1620, SH);
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 810 } },
    ]);
    // 810 - 0 = tileW: disjoint by exactly zero pixels of margin.
    expect(tileWidthFor(SH)).toBe(810);
  });

  it("refuses the split two pixels below the floor and anchors instead", () => {
    const plan = buildCropPlan(oneShot, far, 1618, SH);
    expect(plan!.shots[0].layout).toBe("single");
  });

  it("still splits two pixels above the floor", () => {
    const plan = buildCropPlan(oneShot, far, 1622, SH);
    expect(plan!.shots[0].layout).toBe("split");
  });

  it("refuses a split whose tiles would overlap even on a wide source", () => {
    // 3200 wide, faces at 600 and 1500: the span (1100) is too wide for one
    // 608px window, and the tiles land 892 apart against a tileW of 1216. The
    // aspect allows a split; THESE faces do not. Anchor on the central face.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(500, 200), track(1400, 200, { id: 1 })]),
      WIDE_W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 1196 }]);
  });

  it("never emits overlapping tiles across a sweep of widths and positions", () => {
    for (const width of [1080, 1280, 1618, 1620, 1920, 2560, 3200, 3840]) {
      const tileW = tileWidthFor(H);
      for (let bx = 200; bx + 300 <= width; bx += 100) {
        const plan = buildCropPlan(
          oneShot,
          withTracks([track(100, 300), track(bx, 300, { id: 1 })]),
          width,
          H
        );
        const shot = plan?.shots[0];
        if (!shot || shot.layout !== "split") continue;
        expect(shot.bottom.x - shot.top.x).toBeGreaterThanOrEqual(tileW);
      }
    }
  });
});

describe("anchoring when no window holds every face", () => {
  it("prefers the group showing the most face area over the one with more faces", () => {
    // A alone (260px wide) carries 87,880px of face; the B+C pair carries
    // 84,240. The bigger single face wins, and it is NOT the pair.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(200, 260),
        track(1200, 180, { id: 1 }),
        track(1500, 180, { id: 2 }),
      ]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 26 }]);
  });

  it("flips to the pair when the pair carries more face area", () => {
    // Same positions, B and C grown to 200px: 104,000 against A's 87,880.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(200, 260),
        track(1200, 200, { id: 1 }),
        track(1500, 200, { id: 2 }),
      ]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 1146 }]);
  });

  it("does not depend on the order the detector returned the tracks", () => {
    const tracks = [
      track(200, 260),
      track(1200, 200, { id: 1 }),
      track(1500, 200, { id: 2 }),
    ];
    const forwards = buildCropPlan(oneShot, withTracks(tracks), W, H);
    const backwards = buildCropPlan(oneShot, withTracks([...tracks].reverse()), W, H);
    expect(backwards!.shots).toEqual(forwards!.shots);
    expect(forwards!.shots[0]).toMatchObject({ x: 1146 });
  });

  it("does not move when mouthActivity moves", () => {
    // mouthActivity is a 2fps frame difference that a head turn produces as
    // readily as speech, and nothing in this repo validates it (§7b). The
    // anchor must not read it: same geometry, opposite mouth signals, same x.
    const quiet = buildCropPlan(
      oneShot,
      withTracks([
        track(200, 260, { mouthActivity: 0.25 }),
        track(1200, 200, { id: 1, mouthActivity: 0.001 }),
        track(1500, 200, { id: 2, mouthActivity: 0.001 }),
      ]),
      W,
      H
    );
    const loud = buildCropPlan(
      oneShot,
      withTracks([
        track(200, 260, { mouthActivity: 0.001 }),
        track(1200, 200, { id: 1, mouthActivity: 0.25 }),
        track(1500, 200, { id: 2, mouthActivity: 0.25 }),
      ]),
      W,
      H
    );
    expect(quiet!.shots).toEqual(loud!.shots);
    expect(quiet!.shots[0]).toMatchObject({ x: 1146 });
  });

  it("keeps every face of the chosen group whole, even against the frame edge", () => {
    // The pair sits at 1500..1910; its ideal window starts at 1401 and clamps
    // to 1312. Both faces must still be inside 1312..1920.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 150),
        track(1500, 180, { id: 1 }),
        track(1740, 170, { id: 2 }),
      ]),
      W,
      H
    );
    const shot = plan!.shots[0];
    expect(shot).toEqual({ start: 0, end: 30, layout: "single", x: 1312 });
    const x = (shot as { x: number }).x;
    for (const [left, right] of [
      [1500, 1680],
      [1740, 1910],
    ]) {
      expect(left).toBeGreaterThanOrEqual(x);
      expect(right).toBeLessThanOrEqual(x + cropWidthFor(H));
    }
  });

  it("breaks an exact tie toward the leftmost group, and says so", () => {
    // Two identical faces mirrored about the frame centre: equal area, equal
    // distance from centre. There is no measurable reason to prefer either, so
    // the rule is "leftmost", pinned here so it cannot drift into "whichever
    // the detector listed first".
    const mirrored = [track(200, 150), track(1570, 150, { id: 1 })];
    const plan = buildCropPlan(oneShot, withTracks(mirrored), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 0 }]);
    const reversed = buildCropPlan(oneShot, withTracks([...mirrored].reverse()), W, H);
    expect(reversed!.shots).toEqual(plan!.shots);
  });

  it("centres the window on a face too wide to fit inside it", () => {
    // A 600px face against a 608px window fails the 0.9 fit margin, and with
    // one face there is no pair to split. Anchor on it anyway - the old code
    // reached the split branch with a one-element pair and threw.
    const plan = buildCropPlan(oneShot, withTracks([track(500, 600)]), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });

  it("anchors rather than splitting when the top two do not lead the third", () => {
    // DOMINANCE_LEAD's REJECT side, on a source wide enough that the refusal
    // is the lead test and not the tile geometry: the outer pair score 0.656
    // and 0.658 against 1.5 * 0.550 = 0.826. At a lead of 1.0 this same shot
    // splits into disjoint tiles at 0 and 1984, so the constant is pinned.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 400),
        track(1500, 200, { id: 1 }),
        track(2680, 420, { id: 2 }),
      ]),
      WIDE_W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 2586 }]);
  });

  it("admits a group spanning exactly 90% of the window, and no more", () => {
    // 1084 high makes cropW 610 and the fit margin an exact 549, the only way
    // to land a face bbox ON the boundary (at 1080 it is 547.2, which no
    // integer span can equal). A+B span exactly 549 and must group; C is far
    // enough away to keep the shot off the plain single path.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 150),
        track(499, 150, { id: 1 }),
        track(1700, 150, { id: 2 }),
      ]),
      W,
      1084
    );
    expect(cropWidthFor(1084)).toBe(610);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 70 }]);
  });

  it("rejects a group that fills the window with no margin", () => {
    // A+B span 580: inside the 608px window but past the 0.9 fit margin, so
    // they are not a group and the shot anchors on the single most central
    // face instead of framing two faces flush against the borders.
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 150),
        track(530, 150, { id: 1 }),
        track(1700, 150, { id: 2 }),
      ]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 302 }]);
  });

  it("falls back to the biggest face when every face is wider than the window", () => {
    // Two close-ups, 560px and 600px against a 608px window: no group fits, no
    // split is possible (tiles 704 apart, tileW 1216), and the bigger face is
    // the one worth centring on.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(100, 560), track(1200, 600, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 1196 }]);
  });

  it("still degrades to centre for the shots that have nothing to anchor on", () => {
    // Per shot, not per clip: shot 1 is an establishing wide with only a
    // sub-floor face, and must keep the centre crop while shot 0 anchors.
    const plan = buildCropPlan(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ],
      [
        {
          shotIndex: 0,
          tracks: [track(200, 260), track(1200, 200, { id: 1 }), track(1500, 200, { id: 2 })],
          camRect: null,
        },
        { shotIndex: 1, tracks: [track(900, 40, { id: 3 })], camRect: null },
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 10, layout: "single", x: 1146 },
      { start: 10, end: 20, layout: "center", x: 656 },
    ]);
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
        { shotIndex: 0, tracks: [track(600, 400)], camRect: null },
        // dx 20 < 4% of 1920
        { shotIndex: 1, tracks: [track(620, 400)], camRect: null },
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
        { shotIndex: 0, tracks: [track(600, 400)], camRect: null },
        { shotIndex: 1, tracks: [track(1100, 400)], camRect: null },
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
        { shotIndex: 0, tracks: [], camRect: null },
        { shotIndex: 1, tracks: [], camRect: null },
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("merges split-split adjacent shots, first tile geometry wins", () => {
    // 3200 wide: shot 0 tiles resolve to top 0 / bottom 1892; shot 1's right
    // face nudges the bottom tile to 1942 (dx 50 < 4% of iw = 128) so the pair
    // merges keeping shot 0 geometry.
    const plan = buildCropPlan(
      twoShots,
      [
        {
          shotIndex: 0,
          tracks: [track(2400, 200, { id: 1 }), track(500, 200)],
          camRect: null,
        },
        {
          shotIndex: 1,
          tracks: [track(2450, 200, { id: 1 }), track(500, 200)],
          camRect: null,
        },
      ],
      WIDE_W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 1892 } },
    ]);
  });

  it("keeps split-split shots separate when a tile moves past 4% of iw", () => {
    // shot 0's bottom tile is 1492, shot 1's is 1692: dx 200 > 128 -> no merge.
    const plan = buildCropPlan(
      twoShots,
      [
        {
          shotIndex: 0,
          tracks: [track(2000, 200, { id: 1 }), track(500, 200)],
          camRect: null,
        },
        {
          shotIndex: 1,
          tracks: [track(2200, 200, { id: 1 }), track(500, 200)],
          camRect: null,
        },
      ],
      WIDE_W,
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
      camRect: null,
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
    // 2 and 3 are now supported plan versions (see "v2 plan handling" and
    // "sliceCropPlan with trajectories" below); 4 is genuinely unknown and must
    // still be rejected. This probe has to move up with every version we learn
    // to read - the assertion under test is "unknown is refused", not "3 is".
    expect(sliceCropPlan({ ...plan, version: 4 as unknown as 1 }, 0, 10)).toBeNull();
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
    expect(planLayoutCounts(plan!)).toEqual({
      single: 1,
      split: 0,
      center: 0,
      stream: 0,
    });
  });
});

describe("v2 plan handling", () => {
  const v2: CropPlan = {
    version: 2,
    engine: "faces",
    source: { width: 1280, height: 720 },
    profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
    stream: {
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    },
    shots: [
      { start: 0, end: 10, layout: "stream", cam: { x: 34 }, content: { x: 428 } },
      { start: 10, end: 20, layout: "center", x: 302 },
    ],
  };

  it("slices a v2 plan and keeps the clip-level geometry", () => {
    const sliced = sliceCropPlan(v2, 5, 15);
    expect(sliced?.version).toBe(2);
    expect(sliced?.stream).toEqual(v2.stream);
    expect(sliced?.profile).toEqual(v2.profile);
    expect(sliced?.shots).toHaveLength(2);
    expect(sliced?.shots[0]).toEqual({
      start: 0,
      end: 5,
      layout: "stream",
      cam: { x: 34 },
      content: { x: 428 },
    });
  });

  it("counts stream shots", () => {
    expect(planLayoutCounts(v2)).toEqual({
      single: 0,
      split: 0,
      center: 1,
      stream: 1,
    });
  });

  it("still rejects an unknown version", () => {
    // Was 3, which the trajectory work turned into a real version; 4 is the
    // next unknown one.
    expect(sliceCropPlan({ ...v2, version: 4 as unknown as 2 }, 0, 10)).toBeNull();
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
      withTracks([track(100, 300), track(2800, 300), track(1550, 30)]),
      WIDE_W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 1984 } },
    ]);
  });

  it("treats the floor as exclusive, and places it to within a pixel", () => {
    // 0.06 * 1920 = 115.19999999999999. Only the floor as actually computed
    // separates >= from >; 115 and 116 answer identically under both, so they
    // pin the floor's POSITION while this case pins its INCLUSIVITY - which is
    // what spec §4 promises.
    const at = DEFAULT_PLAN_OPTIONS.faceSmallFrac * W;
    expect(
      buildCropPlan(oneShot, withTracks([track(900, at)]), W, H)?.shots[0].layout
    ).toBe("single");
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

describe("stream layout", () => {
  const SW = 1280;
  const SH = 720;
  // cropWidthFor(720) = 406, so the centered window sits at x = 438.
  const SW_CENTER_X = 438;
  const camRect: CamRect = { x: 0, y: 0, w: 428, h: 240, score: 4.7 };
  const camRes = { rect: camRect };
  const streamOpts = {
    faceSmallFrac: 0.06,
    faceLargeFrac: 0.1,
    stream: true,
    camShare: 0.4,
    // Every assertion in this block predates the motion layer and describes the
    // static window, so motion stays off here on purpose. Named rather than
    // omitted because PlanOptions no longer lets it be omitted - which is the
    // whole point of it being required.
    motion: false,
    camera: DEFAULT_CAMERA,
  };
  // Face measured on the fixture: 43x56 at (179,110), 3.4% of frame width.
  const insetFace: FaceTrack = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };
  const inInset = (x: number, id = 0): FaceTrack => ({
    ...insetFace,
    id,
    box: { ...insetFace.box, x },
  });

  it("emits a stream layout with the solved geometry", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([insetFace]),
      SW,
      SH,
      streamOpts,
      camRes
    );
    expect(plan?.version).toBe(2);
    expect(plan?.profile).toEqual({
      class: "stream",
      faceFrac: 43 / SW,
      camRectScore: 4.7,
    });
    expect(plan?.stream).toEqual({
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    });
    // Face centre 200.5, camCrop.w 336 -> ideal 32.5, even-rounded DOWN to 32.
    expect(plan?.shots[0]).toEqual({
      start: 0,
      end: 30,
      layout: "stream",
      cam: { x: 32 },
      content: { x: 428 },
    });
  });

  it("falls back to center when the killswitch is off", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([insetFace]),
      SW,
      SH,
      { ...streamOpts, stream: false },
      camRes
    );
    expect(plan?.shots[0].layout).toBe("center");
    expect(plan?.profile?.class).toBe("small_face");
    expect(plan?.profile?.reason).toBe("stream_disabled");
    // A v2 plan with no stream geometry is representable but invalid.
    expect(plan?.version).toBe(1);
    expect(plan?.stream).toBeUndefined();
  });

  it("propagates an unstable rect as its own reason, not as 'no rect'", () => {
    const plan = buildCropPlan(oneShot, withTracks([insetFace]), SW, SH, streamOpts, {
      rect: null,
      reason: "stream_rect_unstable",
    });
    expect(plan?.profile?.class).toBe("small_face");
    expect(plan?.profile?.reason).toBe("stream_rect_unstable");
    expect(plan?.version).toBe(1);
  });

  it("reports stream_no_rect when the resolver offers nothing at all", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([insetFace]),
      SW,
      SH,
      streamOpts,
      null
    );
    expect(plan?.profile?.reason).toBe("stream_no_rect");
  });

  it("classifies a clip with no surviving track as faceless", () => {
    const plan = buildCropPlan(oneShot, withTracks([]), SW, SH, streamOpts, camRes);
    expect(plan?.profile?.class).toBe("faceless");
    expect(plan?.shots[0].layout).toBe("center");
  });

  it("centres a shot that has no face inside the inset", () => {
    // Second shot's face sits in the game area, not in the webcam.
    const shots: Shot[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    const tracks: ShotTracks[] = [
      { shotIndex: 0, tracks: [insetFace], camRect },
      {
        shotIndex: 1,
        tracks: [{ ...insetFace, box: { x: 900, y: 400, w: 43, h: 56 } }],
        camRect,
      },
    ];
    const plan = buildCropPlan(shots, tracks, SW, SH, streamOpts, camRes);
    expect(plan?.shots[0].layout).toBe("stream");
    expect(plan?.shots[1]).toEqual({
      start: 10,
      end: 20,
      layout: "center",
      x: SW_CENTER_X,
    });
  });

  it("never mixes stream and split in one plan", () => {
    // Two halves of the same invariant.
    // (1) A clip whose widest face clears the floor is never classified
    //     `stream`, so the pair below drags the WHOLE clip to normal_face and
    //     the small inset face gets center, not a stream tile.
    // 1728x720 is 2.4:1 - wide enough for two 810px tiles to sit apart, which
    // a 1280-wide stream source never is.
    const ULTRA_W = 1728;
    const wide: FaceTrack[] = [
      { ...insetFace, box: { x: 40, y: 200, w: 200, h: 260 } },
      { ...insetFace, id: 1, box: { x: 1500, y: 200, w: 200, h: 260 } },
    ];
    const shots: Shot[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    const withWide = buildCropPlan(
      shots,
      [
        { shotIndex: 0, tracks: [insetFace], camRect },
        { shotIndex: 1, tracks: wide, camRect },
      ],
      ULTRA_W,
      SH,
      streamOpts,
      camRes
    );
    expect(withWide?.profile?.class).toBe("normal_face");
    const wideKinds = new Set(withWide!.shots.map((s) => s.layout));
    expect(wideKinds.has("split")).toBe(true);

    // (2) On a clip that DOES emit stream shots, the stream branch returns
    //     before any single/split can be produced.
    const streamPlan = buildCropPlan(
      shots,
      [
        { shotIndex: 0, tracks: [insetFace], camRect },
        {
          shotIndex: 1,
          tracks: [{ ...insetFace, box: { x: 900, y: 400, w: 43, h: 56 } }],
          camRect,
        },
      ],
      SW,
      SH,
      streamOpts,
      camRes
    );
    const streamKinds = new Set(streamPlan!.shots.map((s) => s.layout));
    expect(streamKinds.has("stream")).toBe(true);

    for (const kinds of [wideKinds, streamKinds]) {
      expect(kinds.has("stream") && kinds.has("split")).toBe(false);
    }
  });

  it("declines the stream layout when no share fits the free band", () => {
    const centred: CamRect = { x: 320, y: 0, w: 640, h: 360, score: 4 };
    const plan = buildCropPlan(
      oneShot,
      withTracks([{ ...insetFace, box: { x: 600, y: 150, w: 43, h: 56 } }]),
      SW,
      SH,
      streamOpts,
      { rect: centred }
    );
    expect(plan?.shots[0].layout).toBe("center");
    expect(plan?.profile?.reason).toBe("stream_no_fit");
    expect(plan?.profile?.camRectScore).toBe(4);
    expect(plan?.version).toBe(1);
  });

  it("merges adjacent stream shots when the cam window barely moves", () => {
    // cam x 32 then 42; |dx| 10 <= 4% of 1280 (51.2). First geometry wins.
    const plan = buildCropPlan(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ],
      [
        { shotIndex: 0, tracks: [insetFace], camRect },
        { shotIndex: 1, tracks: [inInset(189)], camRect },
      ],
      SW,
      SH,
      streamOpts,
      camRes
    );
    expect(plan?.shots).toEqual([
      { start: 0, end: 20, layout: "stream", cam: { x: 32 }, content: { x: 428 } },
    ]);
  });

  it("keeps stream shots separate when the cam window moves for real", () => {
    // Second face sits at the inset's right edge: cam x clamps to 92, and
    // |92 - 32| = 60 > 51.2.
    const plan = buildCropPlan(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ],
      [
        { shotIndex: 0, tracks: [insetFace], camRect },
        { shotIndex: 1, tracks: [inInset(380)], camRect },
      ],
      SW,
      SH,
      streamOpts,
      camRes
    );
    expect(plan?.shots).toHaveLength(2);
    expect(plan?.shots.every((s) => s.layout === "stream")).toBe(true);
    expect(plan?.shots[1]).toMatchObject({ cam: { x: 92 }, content: { x: 428 } });
  });

  it("leaves podcast and facecam sources on the existing path, killswitch ON", () => {
    // The classifier misfiring on a source that already works would be the
    // worst outcome of this change, so pin it with the stream layout enabled
    // and a rect available - the conditions most likely to trip it.
    const podcastRect: CamRect = { x: 0, y: 0, w: 640, h: 360, score: 4.7 };
    const opts = { ...streamOpts };
    const facecam = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H, opts, {
      rect: podcastRect,
    });
    expect(facecam?.profile?.class).toBe("normal_face");
    expect(facecam?.version).toBe(1);
    expect(facecam?.shots).toEqual([
      { start: 0, end: 30, layout: "single", x: 496 },
    ]);

    // The 16:9 duet no longer stacks (the tiles cannot be disjoint at 1920) -
    // it anchors on the larger face, centre 1560. What this test pins is the
    // CLASSIFIER: a podcast must stay normal_face on the v1 path.
    const podcast = buildCropPlan(
      oneShot,
      withTracks([track(1450, 220, { id: 1 }), track(200, 150)]),
      W,
      H,
      opts,
      { rect: podcastRect }
    );
    expect(podcast?.profile?.class).toBe("normal_face");
    expect(podcast?.version).toBe(1);
    expect(podcast?.shots).toEqual([
      { start: 0, end: 30, layout: "single", x: 1256 },
    ]);
  });
});

describe("selectGroupForShot", () => {
  const t = (id: number, x: number, w = 60) => ({
    id, box: { x, y: 0, w, h: 60 }, score: 0.9, samples: 10, mouthActivity: 0.05,
  });

  it("returns every anchorable face when they all fit one window", () => {
    const group = selectGroupForShot([t(0, 100), t(1, 200)], 40, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([0, 1]);
  });

  it("falls back to bestFaceGroup when they do not fit", () => {
    const group = selectGroupForShot([t(0, 0), t(1, 600), t(2, 660)], 40, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([1, 2]);
  });

  it("returns null when no face clears the min-face guard", () => {
    expect(selectGroupForShot([t(0, 100, 10)], 40, 406, 1280)).toBeNull();
  });

  it("drops the tracks the per-shot noise floor drops", () => {
    // survivingTracks runs FIRST, and both of its clauses matter. Each noise
    // track here sits close enough to the dominant face to fit one window with
    // it, so keeping either one would widen the group from [0] to two faces -
    // the window would then frame a detector artefact as if it were a person.
    const dominant = { ...t(0, 600), samples: 10 };
    const oneSample = { ...t(1, 700), samples: 1 };
    // 2 clears MIN_TRACK_SAMPLES but not 30% of the dominant track's 10.
    const transient = { ...t(2, 800), samples: 2 };
    expect(
      selectGroupForShot([dominant, oneSample], 40, 406, 1280)!.map((g) => g.id)
    ).toEqual([0]);
    expect(
      selectGroupForShot([dominant, transient], 40, 406, 1280)!.map((g) => g.id)
    ).toEqual([0]);
  });

  it("does not move when mouthActivity moves", () => {
    // engine-notes 7c's invariant, restated on the extracted function so it
    // cannot be lost now that the measurement script reuses this selection.
    const quiet = [t(0, 0), t(1, 600), t(2, 660)];
    const loud = quiet.map((x, i) => ({ ...x, mouthActivity: i === 0 ? 0.9 : 0.01 }));
    expect(selectGroupForShot(loud, 40, 406, 1280)!.map((g) => g.id)).toEqual(
      selectGroupForShot(quiet, 40, 406, 1280)!.map((g) => g.id)
    );
  });
});

describe("buildTargetSamples", () => {
  const trackWithPath = (id: number, xs: number[]) => ({
    id,
    box: { x: xs[0], y: 0, w: 100, h: 100 },
    score: 0.9,
    samples: xs.length,
    mouthActivity: 0.05,
    path: xs.map((x, i) => ({ t: i * 0.5, x, y: 0, w: 100, h: 100 })),
  });

  it("takes the midpoint of the group bounding box at each sample time", () => {
    const samples = buildTargetSamples(
      [trackWithPath(0, [100, 120]), trackWithPath(1, [300, 320])], 0, 1
    );
    expect(samples[0]).toEqual({ t: 0, cx: 250 });
    expect(samples[1]).toEqual({ t: 0.5, cx: 270 });
  });

  it("carries a missing member forward rather than dropping it", () => {
    // Dropping an absent member shrinks the bbox and moves the target with no
    // change of selection - the confound the frozen-anchor rule forbids.
    const a = trackWithPath(0, [100, 120, 140]);
    const b = trackWithPath(1, [300]);
    const samples = buildTargetSamples([a, b], 0, 2);
    expect(samples[1]).toEqual({ t: 0.5, cx: 260 });
  });

  it("returns nothing when no member has a path", () => {
    const noPath = {
      id: 0, box: { x: 10, y: 0, w: 100, h: 100 },
      score: 0.9, samples: 3, mouthActivity: 0,
    };
    expect(buildTargetSamples([noPath], 0, 2)).toEqual([]);
  });

  it("ignores samples outside the span", () => {
    const samples = buildTargetSamples([trackWithPath(0, [100, 120, 140])], 0.4, 0.6);
    expect(samples.map((s) => s.t)).toEqual([0.5]);
  });
});

describe("attachTrajectories", () => {
  const track = (id: number, xs: number[], step = 0.5, from = 0) => ({
    id,
    box: { x: xs[0], y: 0, w: 60, h: 60 },
    score: 0.9,
    samples: xs.length,
    mouthActivity: 0.05,
    path: xs.map((x, i) => ({ t: from + i * step, x, y: 0, w: 60, h: 60 })),
  });
  const moving = (n: number, from = 0, x0 = 100, dx = 40) =>
    track(0, Array.from({ length: n }, (_, i) => x0 + i * dx), 0.5, from);

  it("leaves center, split and stream layouts untouched", () => {
    const merged = [
      { start: 0, end: 5, layout: "center" as const, x: 100 },
      { start: 5, end: 10, layout: "split" as const, top: { x: 0 }, bottom: { x: 500 } },
    ];
    const shots = [{ start: 0, end: 5 }, { start: 5, end: 10 }];
    expect(attachTrajectories(merged, shots, new Map(), 406, 1280, DEFAULT_CAMERA))
      .toEqual(merged);
  });

  it("leaves x untouched when it adds a trajectory", () => {
    // The whole rollback story rests on this.
    const groups = new Map([[0, [moving(20)]]]);
    const merged = [{ start: 0, end: 10, layout: "single" as const, x: 437 }];
    const out = attachTrajectories(merged, [{ start: 0, end: 10 }], groups, 406, 1280, DEFAULT_CAMERA);
    expect(out[0].x).toBe(437);
  });

  it("omits xs entirely when the camera does not move", () => {
    const groups = new Map([[0, [track(0, Array.from({ length: 20 }, () => 640))]]]);
    const merged = [{ start: 0, end: 10, layout: "single" as const, x: 437 }];
    const out = attachTrajectories(merged, [{ start: 0, end: 10 }], groups, 406, 1280, DEFAULT_CAMERA);
    expect("xs" in out[0]).toBe(false);
  });

  it("uses every detector shot inside a merged span, not only the first", () => {
    // This is the defect the order-of-operations rule exists to prevent: the
    // merge keeps the FIRST shot's geometry, so a trajectory built per shot and
    // then merged would lose the second half entirely.
    const groups = new Map([
      [0, [track(0, [300, 300, 300, 300, 300, 300, 300, 300, 300, 300])]],
      [1, [track(1, Array.from({ length: 10 }, (_, i) => 300 + i * 60), 0.5, 5)]],
    ]);
    const shots = [{ start: 0, end: 5 }, { start: 5, end: 10 }];
    const merged = [{ start: 0, end: 10, layout: "single" as const, x: 100 }];
    const out = attachTrajectories(merged, shots, groups, 406, 1280, DEFAULT_CAMERA);
    expect(out[0].xs).toBeDefined();
    // Movement must occur in the SECOND half, which only shot 1 supplies.
    const late = out[0].xs!.filter((k) => k.t > 5);
    expect(late.length).toBeGreaterThan(0);
  });

  it("does not let a face from another shot widen the target", () => {
    // Carry-forward is per detector shot. Pooling all groups would place shot
    // 1's face into shot 0's bounding box at a time it was never on screen.
    const groups = new Map([
      [0, [track(0, Array.from({ length: 10 }, (_, i) => 100 + i * 40))]],
      [1, [track(1, Array.from({ length: 10 }, () => 1200), 0.5, 5)]],
    ]);
    const shots = [{ start: 0, end: 5 }, { start: 5, end: 10 }];
    const merged = [{ start: 0, end: 5, layout: "single" as const, x: 0 }];
    const out = attachTrajectories(merged, shots, groups, 406, 1280, DEFAULT_CAMERA);
    // The bound is derived, not picked. Only shot 0 overlaps [0,5): its face
    // runs cx 130..490, so the window can never ask for more than 490 - 203 =
    // 287. Measured under the pooling mutant, shot 1's face at 1200 is carried
    // BACKWARD into the bbox at times it was never on screen, the target runs
    // cx 680..860 and the emitted trajectory reaches x = 500 - held down only
    // by the follow-speed cap, which is why a threshold up at 700 let the
    // mutant live. 300 sits between 287 and 500.
    expect(out[0].xs).toBeDefined();
    expect(Math.max(...out[0].xs!.map((k) => k.x))).toBeLessThanOrEqual(300);
  });
});

describe("buildCropPlan with motion on", () => {
  // The only place the flag is exercised end to end. Without it the wiring
  // inside buildCropPlan - the order of merge and attach, and the v3 rule - is
  // dead code in the whole suite, which is what mutation testing found.
  const motionOpts = { ...DEFAULT_PLAN_OPTIONS, motion: true };
  const pathOf = (from: number, count: number, x0: number, dx: number) =>
    Array.from({ length: count }, (_, i) => ({
      t: from + i * 0.5,
      x: x0 + i * dx,
      y: 200,
      w: 400,
      h: 520,
    }));

  it("keeps the second detector shot's motion after the two shots merge", () => {
    // Shot 0 holds still at centre 800 -> x 496. Shot 1's MEDIAN centre is 870
    // -> x 566, and |566 - 496| = 70 <= 4% of 1920, so the two merge into one
    // [0,20] span carrying shot 0's x. The subject moves only during shot 1.
    // Attaching before the merge would hang the trajectory on shot 1's layout,
    // which the merge then discards along with the rest of its geometry.
    const plan = buildCropPlan(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ],
      [
        {
          shotIndex: 0,
          tracks: [track(600, 400, { path: pathOf(0, 20, 600, 0) })],
          camRect: null,
        },
        {
          shotIndex: 1,
          tracks: [track(670, 400, { id: 1, path: pathOf(10, 21, 600, 7) })],
          camRect: null,
        },
      ],
      W,
      H,
      motionOpts
    );
    expect(plan!.shots).toHaveLength(1);
    const span = plan!.shots[0];
    if (span.layout !== "single") throw new Error(`expected single, got ${span.layout}`);
    expect(span).toMatchObject({ start: 0, end: 20, x: 496 });
    expect(span.xs).toBeDefined();
    const late = span.xs!.filter((k) => k.t > 10);
    expect(late.length).toBeGreaterThan(0);
    expect(Math.max(...late.map((k) => k.x))).toBeGreaterThan(496);
  });

  it("reports v3 only when a trajectory is actually emitted", () => {
    // Moving: centre travels 800 -> 1080, well past the deadzone.
    const moving = buildCropPlan(
      [{ start: 0, end: 20 }],
      withTracks([track(600, 400, { path: pathOf(0, 41, 600, 7) })]),
      W,
      H,
      motionOpts
    );
    expect(moving!.version).toBe(3);

    // Still: motion is ON and the path is present, but the camera never moves,
    // so the plan must stay byte-identical to the legacy one - v1, no xs.
    const still = buildCropPlan(
      oneShot,
      withTracks([track(600, 400, { path: pathOf(0, 20, 600, 0) })]),
      W,
      H,
      motionOpts
    );
    expect(still!.version).toBe(1);
    expect(still!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
    expect(still!.shots.every((s) => !("xs" in s))).toBe(true);
  });
});

describe("sliceCropPlan with trajectories", () => {
  const v3 = {
    version: 3 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [
      {
        start: 0,
        end: 20,
        layout: "single" as const,
        x: 100,
        xs: [
          { t: 0, x: 100 },
          { t: 10, x: 300 },
          { t: 20, x: 500 },
        ],
      },
    ],
  };

  it("accepts version 3", () => {
    expect(sliceCropPlan(v3, 5, 15)).not.toBeNull();
  });

  it("shifts keyframe times by the same offset as the shot bounds", () => {
    const out = sliceCropPlan(v3, 5, 15)!;
    const shot = out.shots[0] as { xs?: Array<{ t: number; x: number }> };
    expect(shot.xs!.map((k) => k.t)).toEqual([0, 5, 10]);
  });

  it("interpolates the boundary values rather than copying a neighbour", () => {
    // A slice landing mid-ramp must begin where the camera actually was at
    // that moment. Copying the nearest keyframe would open the trimmed clip
    // on a jump the original never had.
    const out = sliceCropPlan(v3, 5, 15)!;
    const shot = out.shots[0] as { xs?: Array<{ t: number; x: number }> };
    expect(shot.xs![0]).toEqual({ t: 0, x: 200 });
    expect(shot.xs!.at(-1)).toEqual({ t: 10, x: 400 });
  });

  it("leaves a v2 plan exactly as before", () => {
    const v2 = {
      version: 2 as const,
      engine: "faces" as const,
      source: { width: 1280, height: 720 },
      shots: [{ start: 0, end: 20, layout: "single" as const, x: 100 }],
    };
    expect(sliceCropPlan(v2, 5, 15)).toEqual({
      ...v2,
      shots: [{ start: 0, end: 10, layout: "single", x: 100 }],
    });
  });

  it("keeps a partially clipped shot's keyframes inside its own new bounds", () => {
    // The single-shot cases above all have the shot spanning the whole trim, so
    // the shot's new start is 0 and "re-window the trajectory" collapses to
    // "subtract the trim start". A shot that begins PART WAY into the trim is
    // the case that separates the two: keyframe `t` shares the shot's
    // clip-relative timebase, so the trajectory has to be re-windowed to the
    // slice AND pushed out to where the shot now sits, or it would run from
    // before the shot starts to before the shot ends.
    const twoShots = {
      version: 3 as const,
      engine: "faces" as const,
      source: { width: 1280, height: 720 },
      shots: [
        { start: 0, end: 10, layout: "center" as const, x: 400 },
        {
          start: 10,
          end: 30,
          layout: "single" as const,
          x: 100,
          xs: [
            { t: 10, x: 100 },
            { t: 20, x: 300 },
            { t: 30, x: 500 },
          ],
        },
      ],
    };
    const out = sliceCropPlan(twoShots, 5, 25)!;
    const shot = out.shots[1] as {
      start: number;
      end: number;
      xs?: Array<{ t: number; x: number }>;
    };
    expect([shot.start, shot.end]).toEqual([5, 20]);
    expect(shot.xs).toEqual([
      { t: 5, x: 100 },
      { t: 15, x: 300 },
      { t: 20, x: 400 }, // interpolated: 5s into the 20->30 ramp of 300->500
    ]);
  });

  it("does not attach an xs key to a shot that never had one", () => {
    const mixed = {
      version: 3 as const,
      engine: "faces" as const,
      source: { width: 1280, height: 720 },
      shots: [{ start: 0, end: 20, layout: "center" as const, x: 437 }],
    };
    const out = sliceCropPlan(mixed, 5, 15)!;
    expect("xs" in out.shots[0]).toBe(false);
  });
});
