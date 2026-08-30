import { describe, expect, it } from "vitest";
import { faceTracksToRegions } from "../reframe/regions";
import {
  coverageForBox,
  evaluatePlanCoverage,
} from "../reframe/safety";
import {
  formatLayoutTime,
  formatRampTime,
  interpolateRenderedTrajectory,
  roundLayoutTime,
  roundRampTime,
} from "../reframe/render-time";
import type {
  CropPlan,
  FaceTrack,
  FaceBox,
  Shot,
  ShotLayout,
} from "../reframe/types";
import type { FocalRegionTrack } from "../reframe/regions";

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

const box = (x: number, y: number, w: number, h: number): FaceBox => ({
  x,
  y,
  w,
  h,
});

const region = (
  id: string,
  priority: "mandatory" | "supporting",
  samples: Array<{ t: number; box: FaceBox }>
): FocalRegionTrack => ({
  id,
  kind: "face",
  priority,
  samples: samples.map((sample) => ({ ...sample, confidence: 1 })),
});

const plan = (
  shots: ShotLayout[],
  stream?: CropPlan["stream"],
  source = { width: 3000, height: 1000 }
): CropPlan => ({
  version: 3,
  engine: "faces",
  source,
  ...(stream ? { stream } : {}),
  shots,
});

describe("coverageForBox", () => {
  it("measures full, partial, and non-overlap area without mutating inputs", () => {
    const subject = box(10, 20, 100, 100);
    const original = { ...subject };
    expect(coverageForBox(subject, box(0, 0, 200, 200))).toBe(1);
    expect(coverageForBox(subject, box(60, 70, 100, 100))).toBeCloseTo(0.25);
    expect(coverageForBox(subject, box(200, 200, 10, 10))).toBe(0);
    expect(subject).toEqual(original);
  });

  it("returns zero for a non-positive region and preserves an exact .9 result", () => {
    expect(coverageForBox(box(0, 0, 0, 10), box(0, 0, 100, 100))).toBe(0);
    expect(coverageForBox(box(0, 0, 10, -1), box(0, 0, 100, 100))).toBe(0);
    expect(coverageForBox(box(Number.NaN, 0, 10, 10), box(0, 0, 100, 100))).toBe(0);
    expect(coverageForBox(box(0, 0, 10, 10), box(Number.POSITIVE_INFINITY, 0, 100, 100))).toBe(0);
    expect(coverageForBox(box(500, 0, 100, 100), box(28, 0, 562, 100))).toBe(0.9);
  });
});

describe("render-time semantics", () => {
  it("shares layout/ramp formatting and numeric rounding with the renderer", () => {
    expect(formatLayoutTime(1.236)).toBe("1.24");
    expect(roundLayoutTime(1.236)).toBe(1.24);
    expect(formatRampTime(1.2364)).toBe("1.236");
    expect(roundRampTime(1.2364)).toBe(1.236);
  });

  it("interpolates using rounded keyframe time and rounded minimum ramp duration", () => {
    expect(
      interpolateRenderedTrajectory(
        [{ t: 1.2364, x: 0 }, { t: 1.2368, x: 100 }],
        1.2365
      )
    ).toBeCloseTo(50);
  });
});

describe("evaluatePlanCoverage", () => {
  it("passes an exact .9 center and single containment but fails .899", () => {
    const center = plan([
      { start: 0, end: 10, layout: "center", x: 28 },
    ]);
    const single = plan([
      { start: 0, end: 10, layout: "single", x: 28 },
    ]);
    const exact = [region("exact", "mandatory", [{ t: 1, box: box(500, 0, 100, 100) }])];
    const below = [region("below", "mandatory", [{ t: 1, box: box(500.1, 0, 100, 100) }])];

    expect(evaluatePlanCoverage(center, exact)).toMatchObject({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 0.9,
      evaluatedSamples: 1,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
    expect(evaluatePlanCoverage(single, exact)).toMatchObject({
      status: "pass",
      minimumCoverage: 0.9,
      evaluatedSamples: 1,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
    const belowResult = evaluatePlanCoverage(single, below);
    expect(belowResult).toMatchObject({
      status: "fail",
      evaluatedSamples: 1,
      rejectedSamples: 1,
    });
    expect(belowResult.minimumCoverage).toBeCloseTo(0.899, 10);
  });

  it("interpolates a single xs trajectory at the sample midpoint", () => {
    const trajectory = plan([
      {
        start: 0,
        end: 10,
        layout: "single",
        x: 0,
        xs: [{ t: 0, x: 0 }, { t: 10, x: 400 }],
      },
    ]);
    const target = [region("moving", "mandatory", [{ t: 5, box: box(600, 0, 100, 100) }])];

    expect(evaluatePlanCoverage(trajectory, target)).toMatchObject({
      status: "pass",
      minimumCoverage: 1,
    });
  });

  it("uses the maximum tile coverage for split layouts, never their union", () => {
    const split = plan([
      {
        start: 0,
        end: 10,
        layout: "split",
        top: { x: 0 },
        bottom: { x: 1250 },
      },
    ]);
    const separateFaces = [
      region("top-face", "mandatory", [{ t: 1, box: box(100, 100, 100, 100) }]),
      region("bottom-face", "mandatory", [{ t: 1, box: box(1400, 100, 100, 100) }]),
    ];
    const straddlingFace = [
      region("straddling", "mandatory", [{ t: 1, box: box(1100, 100, 300, 100) }]),
    ];

    expect(evaluatePlanCoverage(split, separateFaces)).toMatchObject({
      status: "pass",
      evaluatedSamples: 2,
      minimumCoverage: 1,
    });
    expect(evaluatePlanCoverage(split, straddlingFace)).toMatchObject({
      status: "fail",
      minimumCoverage: 0.5,
      rejectedSamples: 1,
    });
  });

  it("recognizes both stream windows and reports missing geometry as unmapped", () => {
    const streamGeometry = {
      camCrop: { w: 300, h: 200, y: 20 },
      contentCrop: { w: 800, h: 1000 },
      outCamH: 500,
      outContentH: 1420,
    };
    const stream = plan(
      [{ start: 0, end: 10, layout: "stream", cam: { x: 100 }, content: { x: 1000 } }],
      streamGeometry
    );
    expect(
      evaluatePlanCoverage(stream, [
        region("cam", "mandatory", [{ t: 1, box: box(120, 210, 100, 10) }]),
        region("content", "mandatory", [{ t: 1, box: box(1100, 100, 100, 100) }]),
      ])
    ).toMatchObject({ status: "pass", evaluatedSamples: 2, unmappedSamples: 0 });

    const missingGeometry = plan([
      { start: 0, end: 10, layout: "stream", cam: { x: 100 }, content: { x: 1000 } },
    ]);
    expect(
      evaluatePlanCoverage(missingGeometry, [
        region("missing", "mandatory", [{ t: 1, box: box(120, 30, 100, 100) }]),
      ])
    ).toMatchObject({
      status: "not_evaluable",
      evaluatedSamples: 0,
      minimumCoverage: null,
      unmappedSamples: 1,
    });
  });

  it("ignores supporting regions and treats no mandatory samples as not evaluable", () => {
    const staticPlan = plan([{ start: 0, end: 10, layout: "center", x: 0 }]);
    expect(
      evaluatePlanCoverage(staticPlan, [
        region("supporting", "supporting", [{ t: 1, box: box(2900, 0, 100, 100) }]),
      ])
    ).toMatchObject({
      status: "not_evaluable",
      evaluatedSamples: 0,
      rejectedSamples: 0,
      unmappedSamples: 0,
      minimumCoverage: null,
    });
  });

  it("uses the next shot at a shared boundary and includes the final end", () => {
    const twoShots = plan([
      { start: 0, end: 5, layout: "single", x: 0 },
      { start: 5, end: 10, layout: "single", x: 400 },
    ]);
    const samples = [
      { t: 5, box: box(700, 0, 100, 100) },
      { t: 10, box: box(700, 0, 100, 100) },
    ];
    expect(evaluatePlanCoverage(twoShots, [region("seam", "mandatory", samples)])).toMatchObject({
      status: "pass",
      evaluatedSamples: 2,
      unmappedSamples: 0,
    });
  });

  it("uses rounded half-open boundaries like the renderer", () => {
    const roundedBoundary = plan([
      { start: 0, end: 1.236, layout: "single", x: 0 },
      { start: 1.236, end: 2, layout: "single", x: 400 },
    ]);
    const regionAtRoundedEnd = [
      region("rounded", "mandatory", [{ t: 1.24, box: box(700, 0, 100, 100) }]),
    ];
    expect(evaluatePlanCoverage(roundedBoundary, regionAtRoundedEnd)).toMatchObject({
      status: "pass",
      minimumCoverage: 1,
    });
  });

  it("uses the base crop in a gap rather than inventing missing video", () => {
    const gapped = plan([
      { start: 0, end: 4, layout: "single", x: 0 },
      { start: 6, end: 10, layout: "single", x: 400 },
    ]);
    expect(
      evaluatePlanCoverage(gapped, [
        region("gap", "mandatory", [{ t: 5, box: box(700, 0, 100, 100) }]),
      ])
    ).toMatchObject({ status: "pass", evaluatedSamples: 1, unmappedSamples: 0 });
  });

  it("uses global ramp trajectory for the base crop during a gap", () => {
    const movingThenGapped = plan([
      {
        start: 0,
        end: 1,
        layout: "single",
        x: 0,
        xs: [{ t: 0, x: 0 }, { t: 1, x: 400 }],
      },
      { start: 3, end: 4, layout: "center", x: 1220 },
    ]);
    expect(
      evaluatePlanCoverage(movingThenGapped, [
        region("global-ramp", "mandatory", [{ t: 2, box: box(810, 0, 100, 100) }]),
      ])
    ).toMatchObject({ status: "pass", evaluatedSamples: 1, minimumCoverage: 1 });
  });

  it("rejects samples in rounded-overlap and malformed timelines", () => {
    const overlap = plan([
      { start: 0, end: 1.236, layout: "single", x: 0 },
      { start: 1.234, end: 2, layout: "single", x: 400 },
    ]);
    const sample = [region("overlap", "mandatory", [{ t: 1.235, box: box(700, 0, 100, 100) }])];
    expect(evaluatePlanCoverage(overlap, sample)).toMatchObject({
      status: "not_evaluable",
      evaluatedSamples: 0,
      unmappedSamples: 1,
    });

    const compositeOverlap = plan([
      { start: 0, end: 2, layout: "split", top: { x: 0 }, bottom: { x: 1250 } },
      { start: 1, end: 3, layout: "stream", cam: { x: 0 }, content: { x: 1250 } },
    ], {
      camCrop: { w: 300, h: 200, y: 20 },
      contentCrop: { w: 800, h: 1000 },
      outCamH: 500,
      outContentH: 1420,
    });
    expect(evaluatePlanCoverage(compositeOverlap, sample)).toMatchObject({
      status: "not_evaluable",
      evaluatedSamples: 0,
      unmappedSamples: 1,
    });

    const malformed = plan([
      { start: Number.NaN, end: 2, layout: "single", x: 0 },
    ]);
    expect(evaluatePlanCoverage(malformed, sample)).toMatchObject({
      status: "not_evaluable",
      evaluatedSamples: 0,
      unmappedSamples: 1,
    });
  });

  it("fails closed for malformed threshold, regions, layouts, trajectories, and stream geometry", () => {
    const staticPlan = plan([{ start: 0, end: 10, layout: "single", x: 0 }]);
    const sample = region("invalid", "mandatory", [{ t: 1, box: box(100, 0, 100, 100) }]);
    expect(evaluatePlanCoverage(staticPlan, [sample], Number.NaN)).toMatchObject({
      status: "not_evaluable",
      unmappedSamples: 1,
    });
    expect(
      evaluatePlanCoverage(staticPlan, [region("bad-box", "mandatory", [{ t: 1, box: box(Number.NaN, 0, 100, 100) }])])
    ).toMatchObject({ status: "not_evaluable", unmappedSamples: 1 });
    expect(
      evaluatePlanCoverage(plan([{ start: 0, end: 10, layout: "single", x: Number.NaN }]), [sample])
    ).toMatchObject({ status: "not_evaluable", unmappedSamples: 1 });
    expect(
      evaluatePlanCoverage(
        plan([{ start: 0, end: 10, layout: "single", x: 0, xs: [{ t: 0, x: Number.POSITIVE_INFINITY }] }]),
        [sample]
      )
    ).toMatchObject({ status: "not_evaluable", unmappedSamples: 1 });
    expect(
      evaluatePlanCoverage(
        plan(
          [{ start: 0, end: 10, layout: "stream", cam: { x: 0 }, content: { x: 0 } }],
          {
            camCrop: { w: 300, h: 200, y: Number.NaN },
            contentCrop: { w: 800, h: 1000 },
            outCamH: 500,
            outContentH: 1420,
          }
        ),
        [sample]
      )
    ).toMatchObject({ status: "not_evaluable", unmappedSamples: 1 });
  });

  it("uses the base crop at the exact final end of split and stream overlays", () => {
    const split = plan([
      { start: 0, end: 10, layout: "split", top: { x: 0 }, bottom: { x: 1250 } },
    ]);
    expect(
      evaluatePlanCoverage(split, [
        region("split-final", "mandatory", [{ t: 10, box: box(100, 100, 100, 100) }]),
      ])
    ).toMatchObject({ status: "fail", evaluatedSamples: 1, rejectedSamples: 1 });

    const geometry = {
      camCrop: { w: 300, h: 200, y: 20 },
      contentCrop: { w: 800, h: 1000 },
      outCamH: 500,
      outContentH: 1420,
    };
    const stream = plan(
      [{ start: 0, end: 10, layout: "stream", cam: { x: 100 }, content: { x: 1000 } }],
      geometry
    );
    expect(
      evaluatePlanCoverage(stream, [
        region("stream-final", "mandatory", [{ t: 10, box: box(120, 210, 100, 10) }]),
      ])
    ).toMatchObject({ status: "fail", evaluatedSamples: 1, rejectedSamples: 1 });
  });

  it("fails the whole plan when one mandatory sample is below threshold and counts it", () => {
    const staticPlan = plan([{ start: 0, end: 10, layout: "single", x: 28 }]);
    const result = evaluatePlanCoverage(staticPlan, [
      region("face", "mandatory", [
        { t: 1, box: box(500, 0, 100, 100) },
        { t: 2, box: box(500.1, 0, 100, 100) },
      ]),
    ]);
    expect(result).toMatchObject({
      status: "fail",
      evaluatedSamples: 2,
      rejectedSamples: 1,
      unmappedSamples: 0,
    });
    expect(result.minimumCoverage).toBeCloseTo(0.899, 10);
  });
});
