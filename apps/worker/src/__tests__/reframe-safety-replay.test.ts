import { describe, expect, it } from "vitest";
import { planDetected, type Detection } from "../reframe";
import type { ReframeConfig } from "../reframe/config";
import type { CropPlan, FaceBox, FaceTrack, ShotTracks } from "../reframe/types";
import { faceTracksToRegions } from "../reframe/regions";
import { evaluatePlanCoverage } from "../reframe/safety";
import { evaluateSafetyCapture } from "../scripts/eval-reframe-safety-shadow";

const source = { width: 3000, height: 1000 };

const camera = Object.freeze({
  deadzoneFrac: 0.12,
  settleFrac: 0.04,
  maxSpeedFrac: 0.25,
  maxKeyframes: 200,
});

const baseConfig: ReframeConfig = Object.freeze({
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  streamFaceCeiling: 0.15,
  streamVirtualCam: false,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4,
  motion: false,
  cutRecovery: false,
  tailKeep: false,
  saliencyShadow: false,
  safetyShadow: false,
  streamCoverageGate: false,
  camera,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function track(
  id: number,
  box: FaceBox,
  path: FaceTrack["path"] = [
    { t: 1, ...box },
    { t: 5, ...box },
    { t: 9, ...box },
  ],
  samples = path.length
): FaceTrack {
  return { id, box, score: 0.95, samples, mouthActivity: 0.2, path };
}

function detection(shots: Detection["shots"], tracks: ShotTracks[]): Detection {
  return deepFreeze({
    width: source.width,
    height: source.height,
    shots,
    candidates: [],
    tracksByShot: tracks,
  }) as Detection;
}

function shotTracks(shotIndex: number, tracks: FaceTrack[], camRect: ShotTracks["camRect"] = null): ShotTracks {
  return { shotIndex, tracks, camRect };
}

function regionsFor(d: Detection): ReturnType<typeof faceTracksToRegions> {
  return d.shots.flatMap((shot, index) => {
    const set = d.tracksByShot.find((candidate) => candidate.shotIndex === index);
    return set ? faceTracksToRegions(set.tracks, shot, `shot-${index}`) : [];
  });
}

function plansWithShadow(d: Detection, cfg: ReframeConfig = baseConfig) {
  const off = planDetected(d, { ...cfg, safetyShadow: false });
  const on = planDetected(d, { ...cfg, safetyShadow: true });
  expect(JSON.stringify(off.plan)).toBe(JSON.stringify(on.plan));
  expect(off.safetyShadow).toBeUndefined();
  return { off, on };
}

describe("deterministic safety shadow replay", () => {
  it("keeps a normal single-face plan identical and passes coverage", () => {
    const d = detection(
      [{ start: 0, end: 10 }],
      [shotTracks(0, [track(101, { x: 760, y: 220, w: 240, h: 240 })])]
    );
    const { on } = plansWithShadow(d);

    expect(on.safetyShadow).toEqual({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 1,
      evaluatedSamples: 3,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
  });

  it("fails a fixed selected layout when a surviving face sample moves far away", () => {
    const d = detection(
      [{ start: 0, end: 10 }],
      [
        shotTracks(0, [
          track(102, { x: 100, y: 220, w: 220, h: 220 }, [
            { t: 1, x: 100, y: 220, w: 220, h: 220 },
            { t: 9, x: 1700, y: 220, w: 220, h: 220 },
          ]),
        ]),
      ]
    );
    const { off, on } = plansWithShadow(d);

    expect(off.plan?.shots[0].layout).toBe("single");
    expect(on.safetyShadow).toEqual({
      status: "fail",
      threshold: 0.9,
      minimumCoverage: 0,
      evaluatedSamples: 2,
      rejectedSamples: 1,
      unmappedSamples: 0,
    });
  });

  it("passes a split layout when each mandatory face is complete in one tile", () => {
    const d = detection(
      [{ start: 0, end: 10 }],
      [
        shotTracks(0, [
          track(103, { x: 100, y: 180, w: 220, h: 260 }),
          track(104, { x: 2600, y: 180, w: 220, h: 260 }),
        ]),
      ]
    );
    const { off, on } = plansWithShadow(d);

    expect(off.plan?.shots[0].layout).toBe("split");
    expect(on.safetyShadow).toEqual({
      status: "pass",
      threshold: 0.9,
      minimumCoverage: 1,
      evaluatedSamples: 6,
      rejectedSamples: 0,
      unmappedSamples: 0,
    });
  });

  it("measures the final gated plan for a historical short virtual-camera stream shape", () => {
    const d = detection(
      [
        { start: 0, end: 1 },
        { start: 1, end: 10 },
      ],
      [
        shotTracks(0, [track(105, { x: 100, y: 100, w: 100, h: 100 }, [
          { t: 0.2, x: 100, y: 100, w: 100, h: 100 },
          { t: 0.8, x: 100, y: 100, w: 100, h: 100 },
        ])]),
        shotTracks(1, []),
      ]
    );
    const gated = {
      ...baseConfig,
      stream: true,
      streamVirtualCam: true,
      streamCoverageGate: true,
    };
    const historical = planDetected(d, { ...gated, streamCoverageGate: false });
    expect(historical.plan?.profile?.virtualCam).toBe(true);
    expect(historical.plan?.shots.some((shot) => shot.layout === "stream")).toBe(true);

    const { off, on } = plansWithShadow(d, gated);
    expect(off.plan?.shots.every((shot) => shot.layout !== "stream")).toBe(true);
    expect(JSON.stringify(off.plan)).toBe(JSON.stringify(on.plan));
    expect(on.safetyShadow).toEqual(
      evaluatePlanCoverage(on.plan as CropPlan, regionsFor(d))
    );
  });
});

describe("private safety-shadow capture reader", () => {
  it("evaluates an aligned capture and rejects duplicate or missing shot indexes", () => {
    const d = detection(
      [{ start: 0, end: 10 }],
      [shotTracks(0, [track(106, { x: 760, y: 220, w: 240, h: 240 })])]
    );
    const planned = planDetected(d, baseConfig);
    const capture = {
      shots: d.shots,
      tracks: d.tracksByShot,
      plan: planned.plan,
      source,
      clip: { start: 0, end: 10 },
    };
    expect(evaluateSafetyCapture(capture)).toMatchObject({ status: "pass" });
    expect(
      evaluateSafetyCapture({ ...capture, tracks: [{ ...capture.tracks[0] }, { ...capture.tracks[0] }] })
    ).toMatchObject({ status: "not_evaluable", minimumCoverage: null });
    expect(
      evaluateSafetyCapture({ ...capture, tracks: [{ ...capture.tracks[0], shotIndex: 1 }] })
    ).toMatchObject({ status: "not_evaluable", minimumCoverage: null });
  });
});
