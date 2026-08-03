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

  it("declines when even the narrowest window will not fit the band", () => {
    // band.w = 480 (720 - 240), but the narrowest achievable contentW at the
    // floor share (0.3) is 578 - no share fits, for every share tried.
    const g = solveStreamGeometry({
      ...FIXTURE,
      sourceWidth: 720,
      sourceHeight: 720,
      camRect: { x: 0, y: 0, w: 240, h: 136, score: 4 },
    });
    expect(g).toBeNull();
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

  it("gives up rather than emitting a degenerate sub-pixel cam crop", () => {
    // ws=8, hs=6, camRect={x:2,y:0,w:2,h:2}: the cover-crop's cam dimensions
    // round to below 2px before any content-band check even applies.
    expect(
      solveStreamGeometry({
        sourceWidth: 8,
        sourceHeight: 6,
        camRect: { x: 2, y: 0, w: 2, h: 2, score: 4 },
        camShare: 0.4,
      })
    ).toBeNull();
  });

  it("rejects a rect whose left edge is outside the source", () => {
    expect(
      solveStreamGeometry({ ...FIXTURE, camRect: { x: -2, y: 0, w: 428, h: 240, score: 4 } })
    ).toBeNull();
  });

  it("rejects a rect whose top edge is outside the source", () => {
    expect(
      solveStreamGeometry({ ...FIXTURE, camRect: { x: 0, y: -2, w: 428, h: 240, score: 4 } })
    ).toBeNull();
  });

  it("rejects a rect whose right edge overflows the source", () => {
    expect(
      solveStreamGeometry({
        ...FIXTURE,
        camRect: { x: 1000, y: 0, w: 428, h: 240, score: 4 },
      })
    ).toBeNull();
  });

  it("rejects a rect whose bottom edge overflows the source", () => {
    // The Task 7 scenario that motivated this guard: a bottom-flush inset
    // whose independently-taken per-axis medians land 2px past the frame.
    expect(
      solveStreamGeometry({
        ...FIXTURE,
        camRect: { x: 0, y: 844, w: 428, h: 238, score: 4 },
      })
    ).toBeNull();
  });

  it("never emits a crop that leaves the source, over a swept space", () => {
    for (const ws of [640, 854, 1280, 1920]) {
      for (const hs of [360, 480, 720, 1080]) {
        for (const cx of [0, 2, 100, 101, Math.floor(ws / 2)]) {
          for (const cw of [120, 240, 427, 428, 640]) {
            for (const ch of [72, 136, 240, 360]) {
              const camRect = { x: cx, y: 0, w: cw, h: ch, score: 4 };
              if (cx + cw > ws || ch > hs) continue;
              const g = solveStreamGeometry({
                sourceWidth: ws,
                sourceHeight: hs,
                camRect,
                camShare: 0.4,
              });
              if (!g) continue;
              expect(g.camCrop.w).toBeLessThanOrEqual(camRect.w);
              expect(g.camCrop.y + g.camCrop.h).toBeLessThanOrEqual(
                camRect.y + camRect.h
              );
              expect(g.contentCrop.w).toBeLessThanOrEqual(ws);
              expect(g.outCamH + g.outContentH).toBe(1920);
              for (const v of [
                g.camCrop.w,
                g.camCrop.h,
                g.camCrop.y,
                g.contentCrop.w,
              ]) {
                expect(v % 2).toBe(0);
              }
              const band = freeBand(camRect, ws);
              const contentX = streamContentX(band, g.contentCrop.w, ws, ws / 2);
              expect(contentX + g.contentCrop.w).toBeLessThanOrEqual(ws);
              expect(contentX % 2).toBe(0);
              const camX = streamCamX(
                camRect,
                g.camCrop.w,
                camRect.x + camRect.w / 2
              );
              // The invariant that actually matters for ffmpeg safety: never
              // leaves the SOURCE frame. Proven to hold unconditionally,
              // including for a camRect.x that violates the CamRect contract
              // ("x/y even") - see the dedicated test below for why the
              // stricter inset-containment bound cannot always join it.
              expect(camX).toBeGreaterThanOrEqual(0);
              expect(camX + g.camCrop.w).toBeLessThanOrEqual(ws);
              expect(camX % 2).toBe(0);
              // Inset-containment is guaranteed only for a contract-compliant
              // (even-origin) rect - verified over this whole swept space.
              if (camRect.x % 2 === 0) {
                expect(camX).toBeGreaterThanOrEqual(camRect.x);
                expect(camX + g.camCrop.w).toBeLessThanOrEqual(
                  camRect.x + camRect.w
                );
              }
            }
          }
        }
      }
    }
  });

  it("tolerates an odd, out-of-contract inset origin by favouring frame safety over exact inset containment", () => {
    // CamRect documents x/y as always even; this rect violates that. With
    // camW landing at the full 120px (zero horizontal slack), no even camX
    // can sit at exactly camRect.x (101, odd) - one bound must give. The
    // fallback in clampEven resolves toward the bound closer to the frame
    // edge (never overshoot), so it can undershoot the inset's left edge by
    // one rounding step (2px) rather than ever risk exceeding the source.
    const camRect = { x: 101, y: 0, w: 120, h: 136, score: 4 };
    const g = solveStreamGeometry({
      sourceWidth: 640,
      sourceHeight: 360,
      camRect,
      camShare: 0.4,
    })!;
    expect(g.camCrop.w).toBe(120);
    const camX = streamCamX(camRect, g.camCrop.w, camRect.x + camRect.w / 2);
    expect(camX).toBe(100); // camRect.x - 1, rounded down to even - not 102.
    expect(camX).toBeGreaterThanOrEqual(0);
    expect(camX + g.camCrop.w).toBeLessThanOrEqual(640);
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

  it("clamps the content window against a right-hand inset, where the tight bound is the inset's left edge, not the frame", () => {
    const rightRect = { x: 852, y: 0, w: 428, h: 240, score: 1 };
    const g = solveStreamGeometry({ ...FIXTURE, camRect: rightRect })!;
    const band = freeBand(rightRect, 1280);
    expect(band).toEqual({ x: 0, w: 852 });
    // hi = camRect.x - contentW = 852 - 676 = 176, well short of the frame edge.
    expect(streamContentX(band, g.contentCrop.w, 1280, 9999)).toBe(176);
    expect(streamContentX(band, g.contentCrop.w, 1280, 0)).toBe(0);
  });
});
