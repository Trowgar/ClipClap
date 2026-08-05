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
    // Pinned as a literal, and the cap below is hard-coded rather than read
    // back from the config that was passed in. Deriving the bound from the
    // object under test asserts nothing: mutation testing raised this default
    // to 100 and the camera teleported at a measured 1748 px/s against a
    // 101.5 px/s cap while this test stayed green, because the assertion moved
    // with the mutation.
    expect(DEFAULT_CAMERA.maxSpeedFrac).toBe(0.25);
    const cap = 0.25 * CROP;
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

  it("settles centred on the target, not merely inside the deadzone", () => {
    // "comes to rest" above proves the camera stops. It does NOT prove it
    // stopped in the right place: its target at cx=700 is reached by a single
    // capped step that lands inside BOTH bands, so it passes whatever settle
    // is. cx=720 separates them - desired x is 518, the first 50.75px step
    // from 437 lands at 488, which is inside the 48.7px deadzone but outside
    // the 16.2px settle band.
    //
    // Measured: with settle tighter than deadzone the camera keeps easing and
    // comes to rest at 518, dead centre on the target. With settle raised to
    // equal deadzone it stops at 488 and stays 30px off-centre for the rest of
    // the shot - the subject sits permanently off to one side, and a sustained
    // move becomes a stop-start step per sample instead of one smooth ramp.
    //
    // The 518 and the bound below are literals on purpose. Written as
    // `DEFAULT_CAMERA.settleFrac * CROP` the bound would widen to 48.7 under
    // exactly the mutation this test exists to catch, and 30 would pass.
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 36 }, (_, i) => ({ t: 2 + i * 0.5, cx: 720 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 20, DEFAULT_CAMERA)!;
    expect(keys.at(-1)!.x).toBe(518);
    expect(Math.abs(keys.at(-1)!.x + CROP / 2 - 720)).toBeLessThanOrEqual(
      0.04 * CROP
    );
  });

  it("emits integer keyframes, even ones for every position it computes", () => {
    // The clamp in the moving step is redundant for range - `desired` is
    // already clamped and a step never overshoots it - so a mutation that
    // deletes it leaves every keyframe inside the frame and "keeps every
    // keyframe inside the frame" green. What it destroys is the rounding:
    // the mutant emitted x values of 507.5 and 690.75.
    //
    // A held keyframe carries the caller's legacy x through verbatim, and this
    // fixture passes a deliberately odd 437 to prove the controller does not
    // quietly reshape it. The real planner supplies an evenClamp'd value, so
    // in production every keyframe is even. Everything the controller computes
    // itself must be even here.
    const LEGACY = 437;
    const ramp: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const edges: TargetSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      cx: i < 10 ? -500 : 5000,
    }));
    for (const targets of [ramp, edges]) {
      const keys = solveCamera(targets, LEGACY, CROP, W, 0, 10, DEFAULT_CAMERA)!;
      for (const k of keys) {
        expect(Number.isInteger(k.x)).toBe(true);
        expect(k.x === LEGACY || k.x % 2 === 0).toBe(true);
      }
    }
  });
});
