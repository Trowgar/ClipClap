import { describe, expect, it } from "vitest";
import {
  attachTrajectories,
  bisectionSeverity,
  buildCropPlan,
  buildTargetSamples,
  canAnchor,
  centerXForShot,
  cropWidthFor,
  evenClamp,
  faceVisibility,
  hasNormalSizedFace,
  isInsideInset,
  placeWindow,
  planLayoutCounts,
  saliencyShadowFor,
  selectGroupForShot,
  sliceCropPlan,
  synthesizeVirtualCamRect,
  tileWidthFor,
  VIRTUAL_CAM_CHIN_FRAC,
  VIRTUAL_CAM_HEADROOM_FRAC,
  widestFaceInInset,
  windowXFor,
} from "../reframe/plan";
// DEFAULT_CAMERA lives in camera.ts and plan.ts does not re-export it, so this
// is a second import statement by necessity, not by preference.
import { DEFAULT_CAMERA } from "../reframe/camera";
import type {
  CamRect,
  CropPlan,
  FaceBox,
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
    // Per shot, not per clip: shot 1 is an establishing wide with no face at
    // all, and must keep the centre crop while shot 0 anchors.
    //
    // Shot 1 used to carry a 40px face and still centre, because the min-face
    // guard refused every face below 6% on every source. That is the defect the
    // anchor policy removes: on a `normal_face` clip a sub-guard face is now an
    // anchor, and that case has moved to its own test below. What is under test
    // HERE is only that the degrade is decided per shot and not per clip.
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
        { shotIndex: 1, tracks: [], camRect: null },
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 10, layout: "single", x: 1146 },
      { start: 10, end: 20, layout: "center", x: 656 },
    ]);
  });

  it("anchors a sub-guard face on a normal_face clip instead of centring on furniture", () => {
    // The measured defect, at the level that ships it: 298 seconds of 1679
    // delivered framed on nothing while a person was on screen. Shot 0 puts the
    // clip in `normal_face`; shot 1's only face is 40px - 2.1% of a 1920 frame,
    // below the 115.2px guard - and used to be refused outright, leaving that
    // shot centred at 656 on whatever sat between the people.
    //
    // Face 900..940, centre 920, so the window lands at 920 - 304 = 616.
    //
    // ASSERT THE EXACT x, not `layout === "single"`. Mutation testing: reverting
    // `buildCropPlan`'s set to the strict filter while `selectGroupForShot` keeps
    // the relaxed one does not restore the old behaviour, it emits `x: NaN` -
    // the group is non-empty so the layout is still `single`, but the caller's
    // own set is empty and `Math.min(...[])` is `Infinity`. A layout assertion
    // passes on a plan that would put NaN in the filtergraph.
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
      { start: 10, end: 20, layout: "single", x: 616 },
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
    // 2, 3, and 4 are now supported plan versions; 5 is genuinely unknown and must
    // still be rejected. This probe has to move up with every version we learn
    // to read - the assertion under test is "unknown is refused", not "3 is".
    expect(sliceCropPlan({ ...plan, version: 5 as unknown as 1 }, 0, 10)).toBeNull();
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

  it("counts safe-fit shots without adding a zero key to legacy plans", () => {
    expect(planLayoutCounts(v2)).not.toHaveProperty("safe-fit");
    const safeFit = {
      ...v2,
      version: 4 as const,
      shots: [
        { start: 0, end: 10, layout: "safe-fit" as const, reason: "coverage" as const },
        { start: 10, end: 20, layout: "safe-fit" as const, reason: "invalid_evidence" as const },
      ],
    };
    expect(planLayoutCounts(safeFit)).toEqual({
      single: 0,
      split: 0,
      center: 0,
      stream: 0,
      "safe-fit": 2,
    });
  });

  it("still rejects an unknown version", () => {
    // Was 3, which the trajectory work turned into a real version; 5 is the
    // next unknown one.
    expect(sliceCropPlan({ ...v2, version: 5 as unknown as 2 }, 0, 10)).toBeNull();
  });

  it("accepts and trims a v4 safe-fit plan", () => {
    const plan: CropPlan = {
      version: 4,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 10, layout: "safe-fit", reason: "coverage" }],
    };
    expect(sliceCropPlan(plan, 2, 8)?.shots).toEqual([
      { start: 0, end: 6, layout: "safe-fit", reason: "coverage" },
    ]);
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

  it("keeps a speck invisible while a face above the guard exists", () => {
    // The fallback boundary, and the load-bearing half of the anchor policy:
    // the relaxed set is reached ONLY when the strict set is empty, so a shot
    // that already had an anchorable face is bit-for-bit what it was.
    //
    // 300px face at 200..500 anchors at (200 + 500) / 2 - 304 = 46. The 30px
    // speck at 680..710 is 1.6% of the frame, below the 115.2px guard, and near
    // enough to fit the same 608 window: admitted, it would widen the bbox to
    // 200..710 and drag the window to 152, off the only real person in frame.
    // Both calls must give 46.
    const withoutSpeck = buildCropPlan(oneShot, withTracks([track(200, 300)]), W, H);
    const withSpeck = buildCropPlan(
      oneShot,
      withTracks([track(200, 300), track(680, 30, { id: 1 })]),
      W,
      H
    );
    expect(withoutSpeck!.shots).toEqual([
      { start: 0, end: 30, layout: "single", x: 46 },
    ]);
    expect(withSpeck!.shots).toEqual(withoutSpeck!.shots);
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

  // spec 2026-08-19-stream-reframe-v2 D5: rect-first under a ceiling. Below
  // `streamFaceCeiling`, a resolvable rect around the widest face wins
  // classification BEFORE the normal_face floor is even consulted - this is
  // what a corner-cam stream (measured strogo/tox 0.076-0.077, both above
  // faceSmallFrac 0.06) needs to ever reach `stream` at all.
  describe("D5 rect-first classification", () => {
    // 103/1280 = 0.0805625: clears the v1 normal_face floor (0.06 * 1280 =
    // 76.8) AND sits inside `camRect` (x+w = 253 <= 430).
    const eightPct: FaceTrack = {
      id: 0,
      box: { x: 150, y: 100, w: 103, h: 56 },
      score: 0.89,
      samples: 111,
      mouthActivity: 0.05,
    };

    it("fires on a face at 8% of frame width with a valid rect (v1 would say normal_face)", () => {
      expect(hasNormalSizedFace(103, 0.06 * SW)).toBe(true); // the v1 trap
      const plan = buildCropPlan(oneShot, withTracks([eightPct]), SW, SH, streamOpts, camRes);
      expect(plan?.profile?.class).toBe("stream");
      expect(plan?.profile?.faceFrac).toBe(103 / SW);
    });

    it("pins the ceiling as a strict less-than at exactly 0.15", () => {
      // 192/1280 = 0.15 exactly (verified: 192/1280 === 0.15 in IEEE754).
      const atCeiling: FaceTrack = { ...eightPct, box: { ...eightPct.box, w: 192 } };
      const atPlan = buildCropPlan(oneShot, withTracks([atCeiling]), SW, SH, streamOpts, camRes);
      expect(atPlan?.profile?.class).toBe("normal_face");

      // 191/1280 = 0.14921875, strictly under.
      const underCeiling: FaceTrack = { ...eightPct, box: { ...eightPct.box, w: 191 } };
      const underPlan = buildCropPlan(
        oneShot,
        withTracks([underCeiling]),
        SW,
        SH,
        streamOpts,
        camRes
      );
      expect(underPlan?.profile?.class).toBe("stream");
    });

    it("leaves a buster-shaped fullscreen face alone: no rect resolves, so the ceiling adds nothing", () => {
      // 114/1280 = 0.0890625 - between faceSmallFrac and the ceiling, same
      // shape as tw-buster (measured 0.089), but with NO rect at all: this is
      // the case D5's own rationale names as the one a bigger ceiling alone
      // would have broken (spec §2, §3 D5).
      const busterShaped: FaceTrack = {
        id: 0,
        box: { x: 400, y: 100, w: 114, h: 200 },
        score: 0.89,
        samples: 111,
        mouthActivity: 0.05,
      };
      const withDefaultCeiling = buildCropPlan(
        oneShot,
        withTracks([busterShaped]),
        SW,
        SH,
        streamOpts,
        null
      );
      expect(withDefaultCeiling?.profile?.class).toBe("normal_face");

      // Proves the fall-through adds nothing: with no rect to attempt,
      // shrinking the ceiling to 0 cannot change a single byte of the plan.
      const withZeroCeiling = buildCropPlan(
        oneShot,
        withTracks([busterShaped]),
        SW,
        SH,
        { ...streamOpts, streamFaceCeiling: 0 },
        null
      );
      expect(withZeroCeiling).toEqual(withDefaultCeiling);
    });

    it("still reports stream_no_rect for a sub-floor face with no rect, unchanged", () => {
      // 38/1280 = 0.029688, under faceSmallFrac - the pre-D5 population this
      // change must leave byte-for-byte alone.
      const subFloor: FaceTrack = {
        id: 0,
        box: { x: 400, y: 100, w: 38, h: 50 },
        score: 0.89,
        samples: 111,
        mouthActivity: 0.05,
      };
      const plan = buildCropPlan(oneShot, withTracks([subFloor]), SW, SH, streamOpts, null);
      expect(plan?.profile?.class).toBe("small_face");
      expect(plan?.profile?.reason).toBe("stream_no_rect");
    });

    it("keeps the killswitch as master over the rect-first path", () => {
      const plan = buildCropPlan(
        oneShot,
        withTracks([eightPct]),
        SW,
        SH,
        { ...streamOpts, stream: false },
        camRes
      );
      expect(plan?.profile?.class).toBe("normal_face");
    });
  });

  // D1b (spec 2026-08-19-stream-reframe-v2): a detector face box may
  // legitimately overhang a correctly-resolved camRect by real pixels and
  // still BE the webcam inset - `isInsideInset`'s old hardcoded 2px-per-edge
  // floor (sized for median-vs-median jitter) rejected strogo's own dead-on
  // rect for exactly this reason: `widestFaceInInset` said false, D5's
  // rect-first branch never fired, and strogo stayed `normal_face`. Fixture
  // is strogo's OWN measured numbers (python agent, 2026-08-19): GT rect src
  // 0,0,350,160 on the corpus's real 1280x720 source; widest surviving face
  // track (163.56, 73.04, 98.82, 93.52), bottom 166.56 - 6.56px (7% of face
  // height) past the rect's bottom edge.
  describe("D1b overhang tolerance", () => {
    const strogoRect: CamRect = { x: 0, y: 0, w: 350, h: 160, score: 6.1 };
    const strogoFace: FaceTrack = {
      id: 0,
      box: { x: 163.56, y: 73.04, w: 98.82, h: 93.52 },
      score: 0.9,
      samples: 40,
      mouthActivity: 0.05,
    };

    it("strogo-shaped: a 7%-of-face-height overhang is contained, and the clip classifies stream with stream-layout shots", () => {
      expect(
        widestFaceInInset([strogoFace], strogoFace.box.w, strogoRect)
      ).toBe(true);

      const plan = buildCropPlan(
        oneShot,
        [{ shotIndex: 0, tracks: [strogoFace], camRect: strogoRect }],
        SW,
        SH,
        streamOpts,
        { rect: strogoRect }
      );
      expect(plan?.profile?.class).toBe("stream");
      expect(plan?.version).toBe(2);
      expect(plan?.stream).toEqual({
        camCrop: { w: 224, h: 160, y: 0 },
        contentCrop: { w: 676, h: 720 },
        outCamH: 770,
        outContentH: 1150,
      });
      expect(plan?.shots[0]).toEqual({
        start: 0,
        end: 30,
        layout: "stream",
        cam: { x: 100 },
        content: { x: 350 },
      });
    });

    it("bound pin: a 25%-of-face-height overhang still fails - the duet-podcast protection holds", () => {
      // Same face, shifted down so its bottom clears the rect by 25% of its
      // own height (23.38px) instead of 7% - well beyond what a 10% shrink
      // plus the 2px floor can cover.
      // box.y chosen so box.y + box.h = rect.bottom(160) + 0.25*box.h(93.52):
      // 160 + 23.38 - 93.52 = 89.86.
      const farOverhang: FaceTrack = {
        ...strogoFace,
        box: { ...strogoFace.box, y: 89.86 },
      };
      // Sanity: bottom really is rect.bottom + 25% of face height.
      expect(farOverhang.box.y + farOverhang.box.h).toBeCloseTo(
        strogoRect.y + strogoRect.h + 0.25 * farOverhang.box.h,
        6
      );
      expect(
        widestFaceInInset([farOverhang], farOverhang.box.w, strogoRect)
      ).toBe(false);

      const plan = buildCropPlan(
        oneShot,
        [{ shotIndex: 0, tracks: [farOverhang], camRect: strogoRect }],
        SW,
        SH,
        streamOpts,
        { rect: strogoRect }
      );
      // D5's branch is the ONLY path that can promote a normal_face-sized
      // widest face (98.82 >= the 76.8 floor) to `stream` - the legacy
      // final-else branch further down the chain is reserved for sub-floor
      // faces and is never reached once `hasNormalSizedFace` is true. So a
      // failed join here does not fall through to a different route to
      // `stream`; it falls all the way through to `normal_face`, exactly the
      // duet-podcast protection `widestFaceInInset` exists for.
      expect(plan?.profile?.class).toBe("normal_face");
    });
  });

  // spec 2026-08-19-stream-reframe-v2 D4: the virtual cam tile. Only mechanism
  // that can ever serve a borderless/chroma-key cam - edge detection has
  // nothing to find on that class (tox's true sides measured 0.31/0.62 vs
  // edge_min 4.0). Self-contained at tox's own scale (640x360) rather than
  // reusing this file's 1280x720 fixtures above, so the synthesized rect's
  // numbers below are the real corpus numbers, not a rescale of them.
  describe("D4 virtual cam tile", () => {
    const VSW = 640;
    const VSH = 360;
    const vStreamOpts = {
      faceSmallFrac: 0.06,
      faceLargeFrac: 0.1,
      stream: true,
      camShare: 0.4,
      motion: false,
      camera: DEFAULT_CAMERA,
    };
    // Real tox_4X88jJU.mp4 GT face box (.corpus/stream-v2/README.md):
    // ~49x55 at (575,285) on a 640x360 source, 49/640 = 0.0765625.
    const toxFace: FaceTrack = {
      id: 0,
      box: { x: 575, y: 285, w: 49, h: 55 },
      score: 0.89,
      samples: 111,
      mouthActivity: 0.05,
    };

    it("flag off (default) matches a run with the option omitted entirely, byte for byte", () => {
      const omitted = buildCropPlan(oneShot, withTracks([toxFace]), VSW, VSH, vStreamOpts, null);
      const explicitOff = buildCropPlan(
        oneShot,
        withTracks([toxFace]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: false },
        null
      );
      expect(omitted?.profile?.class).toBe("normal_face");
      expect(omitted?.profile?.virtualCam).toBeUndefined();
      expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicitOff));
    });

    it("classifies stream with a virtualCam marker when the flag is on, cam crop containing the face with headroom, content excluding its band", () => {
      const plan = buildCropPlan(
        oneShot,
        withTracks([toxFace]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: true },
        null
      );
      expect(plan?.profile?.class).toBe("stream");
      expect(plan?.profile?.virtualCam).toBe(true);
      expect(plan?.profile?.camRectScore).toBe(0); // synthesized: no edge evidence
      expect(plan?.version).toBe(2);
      // Full geometry, pinned like the sibling "emits a stream layout" test
      // above: 3.2x face width centred on the face, height covers both the
      // 16:9-of-width derivation AND the chin-coverage floor (whichever is
      // taller), clamped to the frame (face right edge sits flush at 624,
      // close to the 640 edge). Headroom 0.75 (owner-reviewed 2026-08-19,
      // was 0.55 - the pompadour on the real tox render got cut by the tile
      // edge): the chin floor still dominates the bottom (unaffected by
      // headroom), so raising headroom only pushes the top up and grows h to
      // match - w is untouched.
      expect(plan?.stream).toEqual({
        camCrop: { w: 120, h: 86, y: 254 },
        contentCrop: { w: 338, h: 360 },
        outCamH: 770,
        outContentH: 1150,
      });
      expect(plan?.shots[0]).toEqual({
        start: 0,
        end: 30,
        layout: "stream",
        cam: { x: 520 },
        content: { x: 152 },
      });

      // The synthesized rect itself: contains the face box, with headroom
      // above it (>= VIRTUAL_CAM_HEADROOM_FRAC*faceHeight, modulo even-
      // snapping) AND chin clearance below it (>=
      // VIRTUAL_CAM_CHIN_FRAC*faceHeight, modulo snapping) - this is the
      // exact containment that broke on the real tox probe before the chin
      // floor existed (spec: synthesized bottom 314 sat 11px above the real
      // face bottom 325.3), and the hair-clipping owner feedback the
      // headroom bump exists for.
      const rect = synthesizeVirtualCamRect(toxFace.box, VSW, VSH);
      expect(rect).toEqual({ x: 520, y: 242, w: 120, h: 108, score: 0 });
      expect(rect.x).toBeLessThanOrEqual(toxFace.box.x);
      expect(rect.x + rect.w).toBeGreaterThanOrEqual(toxFace.box.x + toxFace.box.w);
      expect(rect.y).toBeLessThanOrEqual(toxFace.box.y);
      expect(rect.y + rect.h).toBeGreaterThanOrEqual(toxFace.box.y + toxFace.box.h);
      expect(toxFace.box.y - rect.y).toBeGreaterThanOrEqual(
        VIRTUAL_CAM_HEADROOM_FRAC * toxFace.box.h - 2
      );
      expect(rect.y + rect.h - (toxFace.box.y + toxFace.box.h)).toBeGreaterThanOrEqual(
        VIRTUAL_CAM_CHIN_FRAC * toxFace.box.h - 2
      );
      // And the per-shot loop's OWN containment check - the exact predicate
      // that silently failed before this fix - must agree.
      expect(isInsideInset(toxFace, rect)).toBe(true);

      // freeBand semantics: the content tile and the cam rect never overlap
      // horizontally.
      const shot = plan!.shots[0];
      if (shot.layout !== "stream") throw new Error("expected a stream shot");
      const contentRight = shot.content.x + plan!.stream!.contentCrop.w;
      const overlapsRect = shot.content.x < rect.x + rect.w && contentRight > rect.x;
      expect(overlapsRect).toBe(false);
    });

    it("leaves a face at the ceiling untouched: normal_face, no virtualCam key", () => {
      // 96/640 = 0.15 exactly - same strict-less-than boundary as D5.
      const atCeiling: FaceTrack = { ...toxFace, box: { ...toxFace.box, w: 96 } };
      const plan = buildCropPlan(
        oneShot,
        withTracks([atCeiling]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: true },
        null
      );
      expect(plan?.profile?.class).toBe("normal_face");
      expect(plan?.profile?.virtualCam).toBeUndefined();
    });

    it("a real, resolvable camRect wins via D5 - no virtualCam key, real score preserved", () => {
      // Same geometry as the previous test's synthesized rect, so it is
      // known to contain toxFace and to solve - only the score (5.2, not 0)
      // marks it as a REAL rect this time.
      const realRect: CamRect = { x: 520, y: 254, w: 120, h: 90, score: 5.2 };
      const plan = buildCropPlan(
        oneShot,
        withTracks([toxFace]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: true },
        { rect: realRect }
      );
      expect(plan?.profile?.class).toBe("stream");
      expect(plan?.profile?.virtualCam).toBeUndefined();
      expect(plan?.profile?.camRectScore).toBe(5.2);
    });

    it("does not synthesize without a face: faceless stays faceless", () => {
      const plan = buildCropPlan(
        oneShot,
        withTracks([]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: true },
        null
      );
      expect(plan?.profile?.class).toBe("faceless");
      expect(plan?.profile?.virtualCam).toBeUndefined();
    });

    it("frame-edge safety: a corner face synthesizes a rect fully inside the frame, even, positive", () => {
      // Bottom-right corner, flush against both edges - the shape that broke
      // resolveCamRect before its own clamp (cam-rect.ts's closing comment).
      const cornerFace: FaceBox = { x: 620, y: 340, w: 20, h: 20 };
      const rect = synthesizeVirtualCamRect(cornerFace, VSW, VSH);
      // Headroom 0.75 (owner-reviewed 2026-08-19, was 0.55): top moves up,
      // so y drops and h grows to compensate.
      expect(rect).toEqual({ x: 598, y: 324, w: 42, h: 36, score: 0 });
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(VSW);
      expect(rect.y + rect.h).toBeLessThanOrEqual(VSH);
      expect(rect.w).toBeGreaterThan(0);
      expect(rect.h).toBeGreaterThan(0);
      expect(rect.x % 2).toBe(0);
      expect(rect.y % 2).toBe(0);
      expect(rect.w % 2).toBe(0);
      expect(rect.h % 2).toBe(0);
      // The frame clamp cannot break containment (per the headroom-bump
      // instructions: it only ever ADDS top coverage, and clamping only cuts
      // at an edge the face itself cannot extend past) - checked directly,
      // not assumed.
      expect(isInsideInset({ id: 0, box: cornerFace, score: 0.9, samples: 5, mouthActivity: 0.05 }, rect))
        .toBe(true);

      // Top-left corner too: both axes' `Math.max(0, ...)` floor matter
      // independently.
      const tlFace: FaceBox = { x: 0, y: 0, w: 40, h: 40 };
      const tlRect = synthesizeVirtualCamRect(tlFace, VSW, VSH);
      // At headroom 0.75, the top clamps to 0 (already did at 0.55) but the
      // UNCLAMPED top is now further above the frame, so the 16:9-derived
      // bottom (top + fixed width-derived height) is correspondingly lower -
      // the chin floor (unaffected by headroom) now governs instead of the
      // aspect term, giving a SMALLER h here than at 0.55 (46 vs 50).
      // Investigated, not assumed: still contains tlFace, checked below.
      expect(tlRect).toEqual({ x: 0, y: 0, w: 84, h: 46, score: 0 });
      expect(tlRect.x).toBeGreaterThanOrEqual(0);
      expect(tlRect.y).toBeGreaterThanOrEqual(0);
      expect(isInsideInset({ id: 0, box: tlFace, score: 0.9, samples: 5, mouthActivity: 0.05 }, tlRect))
        .toBe(true);
    });

    it("fires below the normal_face floor too - the band is deliberate, not an accident", () => {
      // 25.6/640 = 0.04, well under faceSmallFrac (0.06): a tiny borderless
      // cam deserves the virtual tile even more than a bigger one, since it
      // is the LEAST likely shape to ever grow a detectable border. Placed
      // near the right edge (like tox itself) so the free band left over is
      // wide enough for solveStreamGeometry's content tile to actually fit -
      // a face too close to centre starves both sides and the geometry
      // legitimately fails to solve, which is a different thing entirely
      // from the band being denied.
      const tinyFace: FaceTrack = {
        id: 0,
        box: { x: 600, y: 250, w: 25.6, h: 30 },
        score: 0.89,
        samples: 60,
        mouthActivity: 0.05,
      };
      expect(hasNormalSizedFace(25.6, 0.06 * VSW)).toBe(false); // confirms sub-floor

      const on = buildCropPlan(
        oneShot,
        withTracks([tinyFace]),
        VSW,
        VSH,
        { ...vStreamOpts, streamVirtualCam: true },
        null
      );
      expect(on?.profile?.class).toBe("stream");
      expect(on?.profile?.virtualCam).toBe(true);

      const off = buildCropPlan(
        oneShot,
        withTracks([tinyFace]),
        VSW,
        VSH,
        vStreamOpts,
        null
      );
      expect(off?.profile?.class).toBe("small_face");
      expect(off?.profile?.reason).toBe("stream_no_rect");
      expect(off?.profile?.virtualCam).toBeUndefined();
    });
  });

  // Orchestrator review 2026-08-19: the tox live-acceptance run classified
  // `stream` but rendered its one shot `center` - the synthesized rect's
  // unclamped bottom sat 11px above the real face's bottom edge, so the
  // per-shot loop's OWN containment check (`isInsideInset`, 2px tolerance)
  // silently failed. This grid is the test that would have caught it: it
  // replicates that exact predicate - not a looser one invented for the
  // test - across a spread of face aspect ratios and frame positions.
  describe("D4 chin-coverage invariant: the synthesized rect always contains its own face", () => {
    const GSW = 640;
    const GSH = 360;
    const FACE_W = 40;
    // h/w: 0.9 (wide) and 1.16 (near the pre-chin-fix containment boundary,
    // ~1.161 - see synthesizeVirtualCamRect's comment) do not need the chin
    // term to be contained; 1.35 and 1.6 (tox itself measured 1.32) do -
    // the mutation check below drops the chin term and expects exactly
    // those two to redden.
    const ASPECTS = [0.9, 1.16, 1.35, 1.6];
    const POSITIONS: Array<{
      label: string;
      place: (w: number, h: number) => { x: number; y: number };
    }> = [
      { label: "centre", place: () => ({ x: 300, y: 150 }) },
      { label: "near top-left corner", place: () => ({ x: 4, y: 4 }) },
      {
        label: "near bottom-right corner",
        place: (w, h) => ({ x: GSW - w - 4, y: GSH - h - 4 }),
      },
    ];

    for (const aspect of ASPECTS) {
      for (const pos of POSITIONS) {
        it(`contains a h/w=${aspect} face ${pos.label}`, () => {
          const h = FACE_W * aspect;
          const { x, y } = pos.place(FACE_W, h);
          const box: FaceBox = { x, y, w: FACE_W, h };
          const track: FaceTrack = {
            id: 0,
            box,
            score: 0.9,
            samples: 20,
            mouthActivity: 0.05,
          };
          const rect = synthesizeVirtualCamRect(box, GSW, GSH);

          // Frame safety, unconditionally - the same discipline as the
          // corner tests above, now swept across every aspect.
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.w).toBeLessThanOrEqual(GSW);
          expect(rect.y + rect.h).toBeLessThanOrEqual(GSH);
          expect(rect.w).toBeGreaterThan(0);
          expect(rect.h).toBeGreaterThan(0);
          expect(rect.x % 2).toBe(0);
          expect(rect.y % 2).toBe(0);
          expect(rect.w % 2).toBe(0);
          expect(rect.h % 2).toBe(0);

          // The invariant: the exact predicate the per-shot loop uses to
          // decide "does this shot show the streamer" must hold for the
          // face the rect was built around.
          expect(isInsideInset(track, rect)).toBe(true);
        });
      }
    }
  });
});

// Written before the anchor policy existed, when the second argument was the
// bare `minFaceWidth` number and the guard applied to every source. They are
// unchanged in substance: `normal_face` with no resolved rect is the case the
// relaxation cannot alter for a face at or above the guard, so this policy
// reproduces exactly what each of these was testing.
describe("selectGroupForShot", () => {
  const policy = {
    minFaceWidth: 40,
    sourceClass: "normal_face" as const,
    camRect: null,
  };
  const t = (id: number, x: number, w = 60) => ({
    id, box: { x, y: 0, w, h: 60 }, score: 0.9, samples: 10, mouthActivity: 0.05,
  });

  it("returns every anchorable face when they all fit one window", () => {
    const group = selectGroupForShot([t(0, 100), t(1, 200)], policy, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([0, 1]);
  });

  it("falls back to bestFaceGroup when they do not fit", () => {
    const group = selectGroupForShot([t(0, 0), t(1, 600), t(2, 660)], policy, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([1, 2]);
  });

  it("returns null when no face clears the min-face guard", () => {
    // A `small_face` clip, because on a `normal_face` clip with no inset the
    // relaxed rule now lets a 10px face anchor - which is the point of the
    // change, and is pinned in "selectGroupForShot under the anchor policy".
    expect(
      selectGroupForShot([t(0, 100, 10)], { ...policy, sourceClass: "small_face" }, 406, 1280)
    ).toBeNull();
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
      selectGroupForShot([dominant, oneSample], policy, 406, 1280)!.map((g) => g.id)
    ).toEqual([0]);
    expect(
      selectGroupForShot([dominant, transient], policy, 406, 1280)!.map((g) => g.id)
    ).toEqual([0]);
  });

  it("does not move when mouthActivity moves", () => {
    // engine-notes 7c's invariant, restated on the extracted function so it
    // cannot be lost now that the measurement script reuses this selection.
    const quiet = [t(0, 0), t(1, 600), t(2, 660)];
    const loud = quiet.map((x, i) => ({ ...x, mouthActivity: i === 0 ? 0.9 : 0.01 }));
    expect(selectGroupForShot(loud, policy, 406, 1280)!.map((g) => g.id)).toEqual(
      selectGroupForShot(quiet, policy, 406, 1280)!.map((g) => g.id)
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

  it("does not carry a later face backward before its first observation", () => {
    const early: FaceTrack = {
      id: 0,
      box: { x: 100, y: 0, w: 100, h: 100 },
      score: 0.9,
      samples: 2,
      mouthActivity: 0,
      path: [
        { t: 0, x: 100, y: 0, w: 100, h: 100 },
        { t: 1, x: 120, y: 0, w: 100, h: 100 },
      ],
    };
    const late: FaceTrack = {
      id: 1,
      box: { x: 1000, y: 0, w: 100, h: 100 },
      score: 0.9,
      samples: 1,
      mouthActivity: 0,
      path: [{ t: 1, x: 1000, y: 0, w: 100, h: 100 }],
    };
    expect(buildTargetSamples([early, late], 0, 1)).toEqual([
      { t: 0, cx: 150 },
      { t: 1, cx: 610 },
    ]);
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

describe("isInsideInset", () => {
  const rect = { x: 100, y: 50, w: 200, h: 150, score: 5 };
  const face = (x: number, y: number, w = 40, h = 40) => ({
    id: 0, box: { x, y, w, h }, score: 0.9, samples: 5, mouthActivity: 0.05,
  });

  it("accepts a face wholly inside", () => {
    expect(isInsideInset(face(150, 80), rect)).toBe(true);
  });

  it("rejects a face wholly outside", () => {
    expect(isInsideInset(face(900, 80), rect)).toBe(false);
  });

  it("rejects a face that only half overlaps", () => {
    expect(isInsideInset(face(280, 80), rect)).toBe(false);
  });

  it("tolerates 2px of slop on every edge, because both boxes are medians", () => {
    // exactly 2px outside on the left and top, and 2px past the right and bottom.
    // Unaffected by the D1b shrink below: shrinking only pulls a box further
    // IN, so anything already inside the old 2px floor stays inside it -
    // this case does not need a tiny face to isolate the floor.
    expect(isInsideInset({ ...face(98, 48), box: { x: 98, y: 48, w: 204, h: 154 } }, rect))
      .toBe(true);
  });

  // D1b (spec 2026-08-19-stream-reframe-v2): the box is now shrunk
  // FACE_CONTAIN_SLOP_FRAC (10%) per edge toward its own centre BEFORE the
  // 2px floor is applied - see plan.ts's comment on the constant (strogo's
  // widest face overhangs a dead-on rect by 7% of its own height, and the
  // old floor alone rejected it). A face sized close to the RECT itself (as
  // the two tests above use, ~200-206px on a 200px rect) makes that 10%
  // shrink tens of pixels - it would swamp a boundary test aimed at the 2px
  // floor specifically. So these two use a TINY face (6x6, "sub-pixel
  // jitter" scale per the constant's own comment: shrink is 0.6px per edge)
  // to isolate the floor from the shrink and pin that the floor still bites.
  describe("2px floor, isolated from the D1b shrink with a tiny (6x6) face", () => {
    const tinyFace = (x: number, y: number) => ({
      id: 0,
      box: { x, y, w: 6, h: 6 },
      score: 0.9,
      samples: 5,
      mouthActivity: 0.05,
    });

    it("tolerates 2px outside on one edge", () => {
      // Left edge 2px outside the rect (98 = rect.x - 2); comfortably inside
      // vertically so only the left edge is in play.
      expect(isInsideInset(tinyFace(98, 100), rect)).toBe(true);
    });

    it("rejects 3px outside on one edge", () => {
      expect(isInsideInset(tinyFace(97, 100), rect)).toBe(false);
    });
  });

  // The other half of D1b: a face proportionally large relative to ITS OWN
  // size, not the rect's, gets real tolerance from the shrink - this is the
  // strogo shape (a detector box may legitimately overhang a correctly-
  // resolved rect and still BE the inset).
  it("tolerates an overhang up to FACE_CONTAIN_SLOP_FRAC of the face's own size, from the shrink alone", () => {
    // Face is 100x100, positioned so it overhangs the rect's bottom edge by
    // exactly 10% of its own height (10px) - the shrink does the heavy
    // lifting (90px vs. the old floor's 2px), leaving just the ordinary 2px
    // floor margin, same as any other contained case.
    const overhangingFace = {
      id: 0,
      box: { x: 150, y: 110, w: 100, h: 100 }, // bottom = 210 = rect.bottom(200) + 10
      score: 0.9,
      samples: 5,
      mouthActivity: 0.05,
    };
    expect(isInsideInset(overhangingFace, rect)).toBe(true);
  });

  it("still rejects an overhang well beyond FACE_CONTAIN_SLOP_FRAC", () => {
    // Same face, bottom now 30px (30% of its height) past the rect - more
    // than the 10% shrink plus the 2px floor can cover.
    const farOverhangingFace = {
      id: 0,
      box: { x: 150, y: 130, w: 100, h: 100 }, // bottom = 230 = rect.bottom(200) + 30
      score: 0.9,
      samples: 5,
      mouthActivity: 0.05,
    };
    expect(isInsideInset(farOverhangingFace, rect)).toBe(false);
  });
});

describe("hasNormalSizedFace", () => {
  it("is true at and above the guard", () => {
    expect(hasNormalSizedFace(115, 115)).toBe(true);
    expect(hasNormalSizedFace(300, 115)).toBe(true);
  });
  it("is false below it", () => {
    expect(hasNormalSizedFace(114, 115)).toBe(false);
    expect(hasNormalSizedFace(0, 115)).toBe(false);
  });
});

describe("canAnchor", () => {
  const rect = { x: 0, y: 0, w: 300, h: 200, score: 5 };
  const face = (x: number, w: number) => ({
    id: 0, box: { x, y: 10, w, h: w }, score: 0.9, samples: 9, mouthActivity: 0.05,
  });
  const GUARD = 115;

  it("accepts any face at or above the guard, whatever the class", () => {
    for (const cls of ["normal_face", "small_face", "stream", "faceless"] as const) {
      expect(canAnchor(face(500, 200), GUARD, cls, null)).toBe(true);
    }
  });

  it("accepts a small face on a normal_face clip with no inset", () => {
    // The measured defect: two men at 5.2% and 5.5% of a 1920 frame, both
    // refused, so the window centred on the table between them.
    expect(canAnchor(face(435, 101), GUARD, "normal_face", null)).toBe(true);
  });

  it("refuses a small face on a small_face clip", () => {
    // Stream-shaped. Both small_face clips in the corpus are stream_no_rect,
    // including the Booster CS2 source, and this is what stops the streamer's
    // 3.1% webcam face becoming an anchor.
    expect(canAnchor(face(435, 60), GUARD, "small_face", null)).toBe(false);
  });

  it("refuses a small face on a stream clip", () => {
    expect(canAnchor(face(435, 60), GUARD, "stream", null)).toBe(false);
  });

  it("refuses a small face that sits inside the inset, even on normal_face", () => {
    expect(canAnchor(face(20, 60), GUARD, "normal_face", rect)).toBe(false);
  });

  it("accepts a small face outside the inset on a normal_face clip", () => {
    expect(canAnchor(face(900, 60), GUARD, "normal_face", rect)).toBe(true);
  });
});

describe("selectGroupForShot under the anchor policy", () => {
  const t = (id: number, x: number, w = 60) => ({
    id, box: { x, y: 0, w, h: 60 }, score: 0.9, samples: 10, mouthActivity: 0.05,
  });
  const strict = { minFaceWidth: 115, sourceClass: "small_face" as const, camRect: null };
  const relaxed = { minFaceWidth: 115, sourceClass: "normal_face" as const, camRect: null };

  it("returns null on a stream-shaped clip whose faces are all small", () => {
    expect(selectGroupForShot([t(0, 435, 101), t(1, 1481, 106)], strict, 608, 1920)).toBeNull();
  });

  it("anchors on those same faces when the clip is normal_face", () => {
    const group = selectGroupForShot([t(0, 435, 101), t(1, 1481, 106)], relaxed, 608, 1920);
    expect(group).not.toBeNull();
    expect(group!.length).toBeGreaterThan(0);
  });

  it("still returns null when there are no tracks at all", () => {
    expect(selectGroupForShot([], relaxed, 608, 1920)).toBeNull();
  });
});

describe("faceVisibility", () => {
  const face = (x: number, w: number) => ({
    id: 0, box: { x, y: 0, w, h: 100 }, score: 0.9, samples: 5, mouthActivity: 0.05,
  });

  it("is 1 when the face is wholly inside", () => {
    expect(faceVisibility(face(700, 100), 600, 608)).toBe(1);
  });

  it("is 0 when the face is wholly outside", () => {
    expect(faceVisibility(face(1500, 100), 0, 608)).toBe(0);
    expect(faceVisibility(face(0, 100), 700, 608)).toBe(0);
  });

  it("is the overlapping fraction when the face straddles an edge", () => {
    // window 600..1208, face 1158..1258 -> 50 of 100 px inside
    expect(faceVisibility(face(1158, 100), 600, 608)).toBeCloseTo(0.5, 6);
    // window 600..1208, face 550..650 -> 50 of 100 px inside
    expect(faceVisibility(face(550, 100), 600, 608)).toBeCloseTo(0.5, 6);
  });

  it("is 0 for a face touching the edge with zero width of overlap", () => {
    expect(faceVisibility(face(1208, 100), 600, 608)).toBe(0);
  });
});

describe("bisectionSeverity", () => {
  it("is exactly zero for a face wholly inside or wholly outside", () => {
    // This is what removes the need for a threshold anywhere in this design:
    // "nobody is cut" is severity 0, not a band someone has to choose.
    expect(bisectionSeverity(0)).toBe(0);
    expect(bisectionSeverity(1)).toBe(0);
  });

  it("peaks at exactly half showing", () => {
    expect(bisectionSeverity(0.5)).toBe(1);
  });

  it("is symmetric about a half", () => {
    expect(bisectionSeverity(0.2)).toBeCloseTo(bisectionSeverity(0.8), 9);
  });

  it("rises monotonically toward a half from either side", () => {
    expect(bisectionSeverity(0.1)).toBeLessThan(bisectionSeverity(0.3));
    expect(bisectionSeverity(0.9)).toBeLessThan(bisectionSeverity(0.7));
  });

  it("treats a barely-clipped face as barely cut", () => {
    // 99% showing is a hair off the edge, not a bisected person.
    expect(bisectionSeverity(0.99)).toBeCloseTo(0.02, 6);
  });
});

describe("placeWindow", () => {
  const CROP = 608;
  const W = 1920;
  const f = (id: number, x: number, w: number) => ({
    id, box: { x, y: 0, w, h: w }, score: 0.9, samples: 9, mouthActivity: 0.05,
  });

  it("returns today's position when there is nothing to avoid", () => {
    // No other faces at all: the tie-break is the only term, so the answer is
    // exactly what the planner computes now. This is the invariant that makes
    // "unchanged where there was no defect" a property rather than a hope.
    const group = [f(0, 700, 200)];
    expect(placeWindow(group, [], CROP, W)).toBe(
      evenClamp(700 + 100 - CROP / 2, CROP, W)
    );
  });

  it("returns today's position when the other face is already whole", () => {
    const group = [f(0, 700, 200)];
    const others = [f(1, 750, 100)];
    expect(placeWindow(group, others, CROP, W)).toBe(
      placeWindow(group, [], CROP, W)
    );
  });

  it("does not move when today's window already cuts nobody, even where framing more face is possible", () => {
    // Stage 1, pinned directly. Shaped after the min-face-guard fixture that
    // caught its absence: a 300px face at 200..500 anchors at x=46, and a 30px
    // speck at 680..710 sits wholly OUTSIDE that window - severity 0, so this
    // shot is not the defect. The speck could be framed whole from x=102
    // (102 + 608 = 710), and the total-visible term would walk the window there
    // if it ran, off the only real person in the shot. It must not run.
    const group = [f(0, 200, 300)];
    const others = [f(1, 680, 30)];
    expect(bisectionSeverity(faceVisibility(others[0], 46, CROP))).toBe(0);
    expect(faceVisibility(others[0], 102, CROP)).toBe(1);
    expect(placeWindow(group, others, CROP, W)).toBe(windowXFor(group, CROP, W));
  });

  it("prefers a position that shows a whole face to one that evicts it", () => {
    // Stage 3, and the reason it exists. Wholly inside and wholly outside are
    // BOTH exactly severity 0 - that zero is what keeps this design free of a
    // threshold, and it is also why the severity score alone cannot choose
    // between framing the listening host and deleting him.
    //
    // Measured on the owner's clip: group 614..864, other 986..1217, cropW 608,
    // today's x 436. The candidate range is [256, 614] and 65 of its 180
    // positions score exactly 0, in two disjoint bands - EVICT [256, 378],
    // where the other face is wholly out, and INCLUDE [610, 614], where it is
    // wholly in. Proximity alone picks eviction: |378 - 436| = 58 against
    // |610 - 436| = 174. That 58-against-174 is the whole reason for stage 3.
    const group = [f(0, 614, 250)];
    const others = [f(1, 986, 231)];
    const x = placeWindow(group, others, CROP, W);
    expect(faceVisibility(others[0], x, CROP)).toBe(1);
    // The evicting alternative was legal AND nearer, so nothing but stage 3
    // could have rejected it.
    expect(bisectionSeverity(faceVisibility(others[0], 378, CROP))).toBe(0);
    expect(Math.abs(378 - 436)).toBeLessThan(Math.abs(x - 436));
  });

  it("shifts to take in a neighbour that fits, rather than slicing it", () => {
    // The measured defect: two faces spanning 603px in a 608px window.
    const group = [f(0, 614, 250)];
    const others = [f(1, 986, 231)];
    const x = placeWindow(group, others, CROP, W);
    expect(x).toBeLessThanOrEqual(614);
    expect(x + CROP).toBeGreaterThanOrEqual(1217);
  });

  it("shifts to push a neighbour fully out when it cannot fit", () => {
    const group = [f(0, 200, 200)];
    const others = [f(1, 760, 300)];
    const x = placeWindow(group, others, CROP, W);
    expect(bisectionSeverity(faceVisibility(others[0], x, CROP))).toBe(0);
    expect(x).toBeLessThanOrEqual(200);
    expect(x + CROP).toBeGreaterThanOrEqual(400);
  });

  it("keeps every group member whole even when that costs a cleaner score", () => {
    const group = [f(0, 600, 200), f(1, 900, 200)];
    const others = [f(2, 1150, 200)];
    const x = placeWindow(group, others, CROP, W);
    // Exact, and that exactness is stage 4. The group is whole on [492, 600];
    // the outsider at 1150..1350 is wholly out for x <= 542 and unreachable
    // whole (it would need x >= 742), so every x in [492, 542] scores an
    // identical (worst 0, seen 0) and only distance from today's 546 separates
    // them. Proximity gives 542; drop it and the first-wins scan gives 492.
    // The wholeness assertions below are true of BOTH, so they cannot tell the
    // two apart - this line is the only thing that pins stage 4 anywhere.
    expect(x).toBe(542);
    for (const g of group) {
      expect(g.box.x).toBeGreaterThanOrEqual(x);
      expect(g.box.x + g.box.w).toBeLessThanOrEqual(x + CROP);
    }
  });

  it("takes the least-bad slice when no position spares everyone", () => {
    const group = [f(0, 800, 200)];
    const others = [f(1, 300, 200), f(2, 600, 120), f(3, 1100, 120), f(4, 1400, 200)];
    const x = placeWindow(group, others, CROP, W);
    const worst = Math.max(
      ...others.map((o) => bisectionSeverity(faceVisibility(o, x, CROP)))
    );
    for (let c = 0; c <= W - CROP; c += 2) {
      if (!(group[0].box.x >= c && group[0].box.x + group[0].box.w <= c + CROP)) continue;
      const alt = Math.max(
        ...others.map((o) => bisectionSeverity(faceVisibility(o, c, CROP)))
      );
      expect(worst).toBeLessThanOrEqual(alt + 1e-9);
    }
  });

  it("falls back to today's position when the group is wider than the window", () => {
    // A close-up. No window holds it whole, so there is no candidate range and
    // the existing clamp stands - which is what 7c already does for this case.
    const group = [f(0, 400, 900)];
    const others = [f(1, 1500, 100)];
    expect(placeWindow(group, others, CROP, W)).toBe(
      placeWindow(group, [], CROP, W)
    );
  });

  it("always returns an even x inside the frame", () => {
    const group = [f(0, 1700, 200)];
    const others = [f(1, 0, 100)];
    const x = placeWindow(group, others, CROP, W);
    expect(x % 2).toBe(0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(W - CROP);
  });

  it("is deterministic", () => {
    const group = [f(0, 614, 250)];
    const others = [f(1, 986, 231), f(2, 300, 90)];
    const first = placeWindow(group, others, CROP, W);
    for (let i = 0; i < 5; i += 1) {
      expect(placeWindow(group, others, CROP, W)).toBe(first);
    }
  });
});

describe("buildCropPlan window placement", () => {
  it("stops the second face being sliced in the measured defect", () => {
    // The owner's clip, reproduced.
    const shots = [{ start: 0, end: 10 }];
    const tracks = [{
      shotIndex: 0,
      camRect: null,
      tracks: [
        { id: 0, box: { x: 614, y: 300, w: 250, h: 250 }, score: 0.9, samples: 12, mouthActivity: 0.05 },
        { id: 1, box: { x: 986, y: 300, w: 231, h: 231 }, score: 0.93, samples: 7, mouthActivity: 0.05 },
      ],
    }];
    const plan = buildCropPlan(shots, tracks, 1920, 1080, DEFAULT_PLAN_OPTIONS, null);
    const shot = plan!.shots[0] as { layout: string; x: number };
    expect(shot.layout).toBe("single");
    expect(shot.x).toBeLessThanOrEqual(614);
    expect(shot.x + 608).toBeGreaterThanOrEqual(1217);
  });

  it("spares an outsider on the FIT branch too, not only the group branch", () => {
    // This test exists because the FIT branch was otherwise unpinned, and for
    // an accidental reason worth knowing before you add cases here. The owner's
    // clip spans 603px, past the 547.2px fit margin, so it routes through the
    // GROUP branch - and every other fixture that reaches FIT has no outsider
    // at all. Reverting FIT's `others` to `[]` therefore changed nothing any
    // test could see, while reverting GROUP's died immediately. Which branch
    // got covered was decided by which defect was reported first, not by the
    // code. So: one face at 800..1000 (span 200, comfortably inside the margin,
    // hence FIT) and one outsider.
    //
    // The outsider is a 40px speck, and it has to be. On the FIT branch
    // `others` is EXACTLY the tracks that failed the min-face guard, because
    // `anchorableTracks` returns the strict set whenever that set is non-empty,
    // so everything above the guard is in `anchorable` and `anchorable` IS the
    // group here. A speck straddling the window edge is the only outsider this
    // branch can ever have - and a person too small to anchor a window is still
    // a person when the edge halves them, which is the whole of stage 3.
    //
    // Arithmetic: today's x is (800 + 1000) / 2 - 304 = 596, so the window is
    // 596..1204 and the speck at 1180..1220 is 24 of its 40px visible - 60%,
    // severity 0.8. Stage 1 does not fire. The speck fits whole from x = 612
    // (612 + 608 = 1220), which is where this lands. With `others` emptied it
    // stays at 596 and the speck stays halved.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(800, 200), track(1180, 40, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 612 }]);
  });
});

// spec 2026-08-23-music-shorts v1.1: owner diagnosis on the Believer corpus
// render - a faceless (center) shot's geometric-centre crop put a
// frame-edge silhouette (starfield subject) half out of the window. Every
// test here passes `musicMode: true` explicitly, so the whole suite above
// this point - every one of which omits it - is the proof that not passing
// it leaves buildCropPlan byte-identical to before this task.
describe("music-mode saliency anchoring (spec 2026-08-23-music-shorts v1.1)", () => {
  const musicOpts = { ...DEFAULT_PLAN_OPTIONS, musicMode: true };

  it("centerXForShot anchors on the saliency centroid, clamped and even-snapped like centerX", () => {
    expect(centerXForShot({ x: 1000, spreadFrac: 0.2 }, 656, 608, W)).toBe(696);
    expect(centerXForShot(null, 656, 608, W)).toBe(656);
    expect(centerXForShot(undefined, 656, 608, W)).toBe(656);
  });

  it("a faceless shot anchors its centre crop on saliency.x, pinned numbers", () => {
    // centerX for 1920x1080 is 656 (cropW 608); saliency.x=1000 moves the
    // window's CENTRE there: 1000 - 304 = 696, already even, inside
    // [0, 1312] - no clamping needed.
    const tracks: ShotTracks[] = [
      { shotIndex: 0, tracks: [], camRect: null, saliency: { x: 1000, spreadFrac: 0.2 } },
    ];
    const plan = buildCropPlan(oneShot, tracks, W, H, musicOpts, null);
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "center", x: 696, spreadFrac: 0.2 },
    ]);
  });

  it("without musicMode, the same saliency data changes nothing - byte-identical to today", () => {
    const tracks: ShotTracks[] = [
      { shotIndex: 0, tracks: [], camRect: null, saliency: { x: 1000, spreadFrac: 0.2 } },
    ];
    const withSaliency = buildCropPlan(oneShot, tracks, W, H, DEFAULT_PLAN_OPTIONS, null);
    const withoutSaliency = buildCropPlan(oneShot, withTracks([]), W, H, DEFAULT_PLAN_OPTIONS, null);
    expect(withSaliency).toEqual(withoutSaliency);
    expect(withSaliency!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("a null saliency (shot had no sampled frames) falls back to centerX even under musicMode", () => {
    const tracks: ShotTracks[] = [{ shotIndex: 0, tracks: [], camRect: null, saliency: null }];
    const plan = buildCropPlan(oneShot, tracks, W, H, musicOpts, null);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("a shot with an anchorable face ignores saliency for x, but still carries spreadFrac", () => {
    // Same face as "screenshot 1 regression" above (x: 496 unmoved) - the
    // saliency centroid (50) sits nowhere near the face and must not be used.
    const tracks: ShotTracks[] = [
      {
        shotIndex: 0,
        tracks: [track(600, 400)],
        camRect: null,
        saliency: { x: 50, spreadFrac: 0.4 },
      },
    ];
    const plan = buildCropPlan(oneShot, tracks, W, H, musicOpts, null);
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "single", x: 496, spreadFrac: 0.4 },
    ]);
  });

  it("a face shot with no saliency data carries no spreadFrac key even under musicMode", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H, musicOpts, null);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });
});

// spec 2026-08-24-camera-visual-anchoring, mechanism B: SHADOW TELEMETRY
// ONLY, gated by `opts.saliencyShadow` (threaded from ReframeConfig's
// REFRAME_SALIENCY_SHADOW). Never changes a shot's `x`/`layout`/`start`/
// `end` - it only ever ADDS a `saliencyShadow` field recording what an
// ACTIVE anchor would have computed. Every test in the two music-mode
// describe blocks above passes `saliencyShadow` unset (falsy), so those are
// the "flag off means nothing changed" proof for this mechanism too.
describe("saliency shadow telemetry (spec 2026-08-24-camera-visual-anchoring mechanism B)", () => {
  const shadowOpts = { ...DEFAULT_PLAN_OPTIONS, saliencyShadow: true };
  const shadowMusicOpts = {
    ...DEFAULT_PLAN_OPTIONS,
    saliencyShadow: true,
    musicMode: true,
  };
  const salientTracks: ShotTracks[] = [
    { shotIndex: 0, tracks: [], camRect: null, saliency: { x: 1000, spreadFrac: 0.2 } },
  ];

  it("saliencyShadowFor packages the raw centroid/spreadFrac plus what centerXForShot would have returned; null when saliency is null or absent", () => {
    expect(saliencyShadowFor({ x: 1000, spreadFrac: 0.2 }, 656, 608, W)).toEqual({
      centroidX: 1000,
      spreadFrac: 0.2,
      suggestedX: 696,
      deltaPx: 40,
    });
    expect(saliencyShadowFor(null, 656, 608, W)).toBeNull();
    expect(saliencyShadowFor(undefined, 656, 608, W)).toBeNull();
  });

  it("(a) flag ON, standard mode: a faceless shot's x/layout/start/end stay exactly what flag-off produces, plus a correct saliencyShadow field", () => {
    const withShadow = buildCropPlan(oneShot, salientTracks, W, H, shadowOpts, null);
    const flagOff = buildCropPlan(oneShot, salientTracks, W, H, DEFAULT_PLAN_OPTIONS, null);
    // Geometry identity: strip the shadow field and the two plans must match.
    const { saliencyShadow, ...withoutShadow } = withShadow!.shots[0] as any;
    expect(withoutShadow).toEqual(flagOff!.shots[0]);
    expect(withShadow!.shots).toEqual([
      {
        start: 0,
        end: 30,
        layout: "center",
        x: 656,
        saliencyShadow: { centroidX: 1000, spreadFrac: 0.2, suggestedX: 696, deltaPx: 40 },
      },
    ]);
  });

  it("a faceless shot with null saliency (no sampled frames) gets no saliencyShadow field even with the flag on", () => {
    const tracks: ShotTracks[] = [{ shotIndex: 0, tracks: [], camRect: null, saliency: null }];
    const plan = buildCropPlan(oneShot, tracks, W, H, shadowOpts, null);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("(b) a face-anchored (non-center) shot never carries a saliencyShadow field, flag on or off", () => {
    const tracks: ShotTracks[] = [
      {
        shotIndex: 0,
        tracks: [track(600, 400)],
        camRect: null,
        saliency: { x: 1000, spreadFrac: 0.2 },
      },
    ];
    const withFlag = buildCropPlan(oneShot, tracks, W, H, shadowOpts, null);
    const withoutFlag = buildCropPlan(oneShot, tracks, W, H, DEFAULT_PLAN_OPTIONS, null);
    expect(withFlag!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
    expect(withFlag).toEqual(withoutFlag);
  });

  it("(c) flag ON + musicMode: music behaviour is unchanged and no shadow field appears anywhere", () => {
    const withShadowFlag = buildCropPlan(oneShot, salientTracks, W, H, shadowMusicOpts, null);
    const musicOnly = buildCropPlan(
      oneShot,
      salientTracks,
      W,
      H,
      { ...DEFAULT_PLAN_OPTIONS, musicMode: true },
      null
    );
    expect(withShadowFlag).toEqual(musicOnly);
    expect(withShadowFlag!.shots).toEqual([
      { start: 0, end: 30, layout: "center", x: 696, spreadFrac: 0.2 },
    ]);
    expect(withShadowFlag!.shots[0]).not.toHaveProperty("saliencyShadow");
  });

  it("(d) flag OFF: no saliencyShadow field anywhere, plan deep-equal to the pre-mechanism-B plan", () => {
    const flagOff = buildCropPlan(oneShot, salientTracks, W, H, DEFAULT_PLAN_OPTIONS, null);
    expect(flagOff!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
    expect(flagOff!.shots[0]).not.toHaveProperty("saliencyShadow");
  });
});
