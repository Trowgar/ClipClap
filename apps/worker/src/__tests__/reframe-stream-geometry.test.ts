import { describe, expect, it } from "vitest";
import {
  CAM_SHARE_MIN,
  evenRound,
  freeBand,
  solveStreamGeometry,
  streamCamX,
  streamContentX,
} from "../reframe/stream-geometry";

// The measured CS2 fixture: 1280x720, inset flush to the top-left corner,
// 427x240 in raw pixels, snapped outward to even.
const FIXTURE = {
  sourceWidth: 1280,
  sourceHeight: 720,
  camRect: { x: 0, y: 0, w: 428, h: 240, score: 4.7 },
  camShare: 0.4,
};

describe("evenRound", () => {
  it("matches evenClamp's rounding at halfway values", () => {
    expect(evenRound(675)).toBe(676);
    expect(evenRound(336.62)).toBe(336);
    expect(evenRound(1150.29)).toBe(1150);
  });
});

describe("freeBand", () => {
  it("takes the wider side of a left-hand inset", () => {
    expect(freeBand(FIXTURE.camRect, 1280)).toEqual({ x: 428, w: 852 });
  });

  it("takes the left side when the inset is on the right", () => {
    expect(freeBand({ x: 852, y: 0, w: 428, h: 240, score: 1 }, 1280)).toEqual({
      x: 0,
      w: 852,
    });
  });
});

describe("solveStreamGeometry", () => {
  it("solves the fixture to the numbers in the spec", () => {
    const g = solveStreamGeometry(FIXTURE);
    expect(g).not.toBeNull();
    expect(g!.contentCrop).toEqual({ w: 676, h: 720 });
    expect(g!.outContentH).toBe(1150);
    expect(g!.outCamH).toBe(770);
    expect(g!.camCrop).toEqual({ w: 336, h: 240, y: 0 });
  });

  it("always fills the output exactly", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    expect(g.outCamH + g.outContentH).toBe(1920);
  });

  it("emits only even dimensions", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    for (const v of [
      g.camCrop.w,
      g.camCrop.h,
      g.camCrop.y,
      g.contentCrop.w,
      g.outCamH,
      g.outContentH,
    ]) {
      expect(v % 2).toBe(0);
    }
  });

  it("never proposes a content window wider than the source", () => {
    const g = solveStreamGeometry({
      ...FIXTURE,
      sourceWidth: 720,
      sourceHeight: 720,
      camRect: { x: 0, y: 0, w: 240, h: 136, score: 4 },
    });
    if (g) expect(g.contentCrop.w).toBeLessThanOrEqual(720);
  });

  it("reduces the cam share when the free band is too narrow, never raises it", () => {
    // Inset eats the left half: only 640px of free band remains, and the
    // default share needs 676. A SMALLER cam tile needs a NARROWER window.
    const g = solveStreamGeometry({
      ...FIXTURE,
      camRect: { x: 0, y: 0, w: 640, h: 360, score: 4 },
    })!;
    expect(g.contentCrop.w).toBeLessThanOrEqual(640);
    expect(g.outCamH).toBeLessThan(770);
  });

  it("gives up rather than slicing the inset in half", () => {
    // Inset dead centre: the widest free band is 320px, which no allowed share
    // can fill without overlapping the inset.
    expect(
      solveStreamGeometry({
        ...FIXTURE,
        camRect: { x: 320, y: 0, w: 640, h: 360, score: 4 },
      })
    ).toBeNull();
  });

  it("cover-crops a 4:3 inset by width instead of height", () => {
    const g = solveStreamGeometry({
      ...FIXTURE,
      camRect: { x: 0, y: 0, w: 320, h: 240, score: 4 },
    })!;
    // 320/240 = 1.333 which is below 1080/outCamH, so width is the limit.
    expect(g.camCrop.w).toBe(320);
    expect(g.camCrop.h).toBeLessThan(240);
    expect(g.camCrop.y).toBeGreaterThan(0);
  });

  it("never crops outside the inset", () => {
    const rect = { x: 40, y: 30, w: 320, h: 240, score: 4 };
    const g = solveStreamGeometry({ ...FIXTURE, camRect: rect })!;
    expect(g.camCrop.w).toBeLessThanOrEqual(rect.w);
    expect(g.camCrop.h).toBeLessThanOrEqual(rect.h);
    expect(g.camCrop.y).toBeGreaterThanOrEqual(rect.y);
    expect(g.camCrop.y + g.camCrop.h).toBeLessThanOrEqual(rect.y + rect.h);
  });

  it("clamps a share above the ceiling instead of honouring it", () => {
    const g = solveStreamGeometry({ ...FIXTURE, camShare: 0.9 })!;
    expect(g.outCamH / 1920).toBeLessThanOrEqual(0.56);
  });

  it("clamps a share below the floor", () => {
    const g = solveStreamGeometry({ ...FIXTURE, camShare: 0.05 })!;
    expect(g.outCamH / 1920).toBeGreaterThanOrEqual(CAM_SHARE_MIN - 0.01);
  });
});

describe("per-shot x", () => {
  it("anchors the cam window on the face, clamped inside the inset", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 201)).toBe(34);
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 0)).toBe(0);
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 9999)).toBe(92);
  });

  it("clamps the content window into the free band", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    const band = freeBand(FIXTURE.camRect, 1280);
    // Ideal centring would start at 302, which is inside the inset.
    expect(streamContentX(band, g.contentCrop.w, 1280, 640)).toBe(428);
    expect(streamContentX(band, g.contentCrop.w, 1280, 9999)).toBe(604);
  });
});
