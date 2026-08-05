import { describe, it, expect } from "vitest";
import { solveCamera, DEFAULT_CAMERA, type TargetSample } from "../reframe/camera";

// A 1280x720 source: cropW is 406, so the window can sit anywhere in [0, 874].
const W = 1280;
const CROP = 406;

/** Targets one per half second, at a constant centre. */
const still = (cx: number, n = 20): TargetSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.5, cx }));

describe("solveCamera", () => {
  it("returns null when the target never leaves the deadzone", () => {
    // The control case the locked-off corpus item exists to protect: a static
    // subject must not acquire a camera move.
    const x0 = 437; // window centred at 640
    expect(solveCamera(still(640), x0, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("returns null for a target that jitters inside the deadzone", () => {
    // 2 fps YuNet boxes wobble by a few pixels. That must not become pan.
    const targets = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      cx: 640 + (i % 2 === 0 ? 6 : -6),
    }));
    expect(solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("moves when the target leaves the deadzone", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA);
    expect(keys).not.toBeNull();
    expect(keys!.length).toBeGreaterThan(1);
    expect(keys!.at(-1)!.x).toBeGreaterThan(600);
  });

  it("never exceeds the speed cap between consecutive keyframes", () => {
    const targets: TargetSample[] = [
      { t: 0, cx: 200 },
      ...Array.from({ length: 19 }, (_, i) => ({ t: 0.5 + i * 0.5, cx: 1100 })),
    ];
    const keys = solveCamera(targets, 0, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    const cap = DEFAULT_CAMERA.maxSpeedFrac * CROP;
    for (let i = 1; i < keys.length; i++) {
      const dt = keys[i].t - keys[i - 1].t;
      const dx = Math.abs(keys[i].x - keys[i - 1].x);
      expect(dx / dt).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it("keeps every keyframe inside the frame", () => {
    const targets: TargetSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      cx: i < 10 ? -500 : 5000,
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    for (const k of keys) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(W - CROP);
    }
  });

  it("emits keyframes with strictly increasing times", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i].t).toBeGreaterThan(keys[i - 1].t);
    }
  });

  it("spans the whole shot, so the expression is total", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    expect(keys[0].t).toBe(0);
    expect(keys.at(-1)!.t).toBe(10);
  });

  it("starts at the legacy x, so the first frame is unchanged", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    expect(keys[0].x).toBe(437);
  });

  it("returns null when fewer than two samples are available", () => {
    expect(solveCamera([{ t: 0, cx: 900 }], 437, CROP, W, 0, 10, DEFAULT_CAMERA))
      .toBeNull();
    expect(solveCamera([], 437, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("returns null rather than truncating when it would exceed the cap", () => {
    const targets: TargetSample[] = Array.from({ length: 4000 }, (_, i) => ({
      t: i * 0.01,
      cx: i % 2 === 0 ? 100 : 1180,
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 40, {
      ...DEFAULT_CAMERA,
      maxKeyframes: 20,
    });
    expect(keys).toBeNull();
  });

  it("comes to rest rather than crawling forever", () => {
    // Hysteresis: settle is tighter than deadzone, so a target parked just
    // outside the settle band must not produce a permanent creep.
    const targets: TargetSample[] = Array.from({ length: 40 }, (_, i) => ({
      t: i * 0.5,
      cx: i < 4 ? 640 : 700,
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 20, DEFAULT_CAMERA);
    if (keys) {
      expect(keys.at(-1)!.x).toBe(keys.at(-2)!.x);
    }
  });
});
