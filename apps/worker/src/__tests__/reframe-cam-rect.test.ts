import { describe, expect, it } from "vitest";
import { resolveCamRect } from "../reframe/cam-rect";
import type { CamRect } from "../reframe/types";

const r = (x: number, w: number): CamRect => ({ x, y: 0, w, h: 240, score: 4 });

describe("resolveCamRect", () => {
  it("reports no rect when nothing was found", () => {
    expect(resolveCamRect([null, null, null], 1280, 720)).toEqual({
      rect: null,
      reason: "stream_no_rect",
    });
  });

  it("takes the median when the shots agree", () => {
    const got = resolveCamRect([r(0, 427), r(1, 428), r(0, 426)], 1280, 720);
    expect(got.rect).toMatchObject({ x: 0, w: 428 });
    expect(got.reason).toBeUndefined();
  });

  it("snaps outward to even so the crop never exceeds the inset", () => {
    const got = resolveCamRect([r(3, 427), r(3, 427), r(3, 427)], 1280, 720).rect!;
    expect(got.x % 2).toBe(0);
    expect(got.w % 2).toBe(0);
    expect(got.x).toBeLessThanOrEqual(3);
    expect(got.x + got.w).toBeGreaterThanOrEqual(3 + 427);
  });

  it("distinguishes a composition that MOVES from one that was never found", () => {
    // Half the shots put the inset left, half put it right: found, but unstable.
    expect(
      resolveCamRect([r(0, 428), r(0, 428), r(800, 428), r(800, 428)], 1280, 720)
    ).toEqual({ rect: null, reason: "stream_rect_unstable" });
  });

  it("reports no rect when fewer than half the shots found anything", () => {
    expect(resolveCamRect([r(0, 428), null, null, null], 1280, 720)).toEqual({
      rect: null,
      reason: "stream_no_rect",
    });
  });

  it("keeps the rect inside the frame on both axes", () => {
    const got = resolveCamRect([r(1200, 200), r(1200, 200)], 1280, 720).rect!;
    expect(got.x + got.w).toBeLessThanOrEqual(1280);
    expect(got.y + got.h).toBeLessThanOrEqual(720);
  });

  it("clamps a bottom edge that only the independent medians produce", () => {
    // Each input is in frame on a 1080-tall source, but the medians of y and h
    // are taken independently and the upper middle wins both: y=844 with h=238
    // is a bottom edge of 1082. Unclamped this reaches ffmpeg as crop past the
    // source and fails the encode with error -22, after every fallback.
    const bottomFlush = (y: number, h: number): CamRect => ({
      x: 0, y, w: 428, h, score: 4,
    });
    const got = resolveCamRect(
      [bottomFlush(842, 238), bottomFlush(844, 236)],
      1920,
      1080
    ).rect!;
    expect(got.y + got.h).toBeLessThanOrEqual(1080);
  });

  it("returns a rect that is integral, even, and no smaller than the fractional input on any side", () => {
    const frac: CamRect = { x: 10.5, y: 4.2, w: 426.9, h: 238.3, score: 4 };
    const got = resolveCamRect([frac, frac], 1280, 720).rect!;
    expect(Number.isInteger(got.x)).toBe(true);
    expect(Number.isInteger(got.y)).toBe(true);
    expect(Number.isInteger(got.w)).toBe(true);
    expect(Number.isInteger(got.h)).toBe(true);
    expect(got.x % 2).toBe(0);
    expect(got.y % 2).toBe(0);
    expect(got.w % 2).toBe(0);
    expect(got.h % 2).toBe(0);
    expect(got.x).toBeLessThanOrEqual(frac.x);
    expect(got.y).toBeLessThanOrEqual(frac.y);
    expect(got.x + got.w).toBeGreaterThanOrEqual(frac.x + frac.w);
    expect(got.y + got.h).toBeGreaterThanOrEqual(frac.y + frac.h);
  });
});
