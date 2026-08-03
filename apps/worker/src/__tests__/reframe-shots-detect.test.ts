import { beforeEach, describe, expect, it, vi } from "vitest";

// A separate file from reframe-shots.test.ts on purpose: that one tests the
// pure cutsToShots and must stay free of module mocks. Here the ffmpeg boundary
// is mocked so the scdet retry - a long window with zero cuts is probed a
// second time at half the threshold - can be asserted at all.

const h = vi.hoisted(() => ({
  /** The args of every ffmpeg invocation, in order. */
  calls: [] as string[][],
  /** One stderr body per invocation, consumed in order. */
  stderrQueue: [] as string[],
}));

vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    h.calls.push(args);
    cb(null, { stdout: "", stderr: h.stderrQueue.shift() ?? "" });
  },
}));

import { detectShots } from "../reframe/shots";
import type { ReframeConfig } from "../reframe/config";

/** Threshold used by each scdet invocation, read back out of the -vf argument. */
const thresholds = () =>
  h.calls.map((args) => {
    const vf = args[args.indexOf("-vf") + 1];
    return Number(/gte\(scene,([0-9.]+)\)/.exec(vf)![1]);
  });

const cfg: ReframeConfig = {
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

describe("detectShots retry", () => {
  beforeEach(() => {
    h.calls = [];
    h.stderrQueue = [];
  });

  it("retries a long zero-cut window at half the threshold", async () => {
    // 0.4 halves to 0.2, which is clear of the 0.15 floor - so this asserts the
    // halving itself and not merely that the retry lands on the floor.
    h.stderrQueue = ["", ""];

    await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.4 }, 5000);

    expect(thresholds()).toEqual([0.4, 0.2]);
  });

  it("uses the cuts the second pass finds", async () => {
    h.stderrQueue = ["", "pts_time:20.0"];

    const shots = await detectShots("/x.mp4", 0, 40, cfg, 5000);

    expect(thresholds()).toEqual([0.3, 0.15]);
    expect(shots).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 40 },
    ]);
  });

  it("does not retry when the first pass found cuts", async () => {
    h.stderrQueue = ["pts_time:12.4\npts_time:31.0"];

    const shots = await detectShots("/x.mp4", 0, 40, cfg, 5000);

    expect(thresholds()).toEqual([0.3]);
    expect(shots).toHaveLength(3);
  });

  it("does not retry a window shorter than the long-take bar", async () => {
    h.stderrQueue = ["", ""];

    await detectShots("/x.mp4", 0, 14.9, cfg, 5000);

    expect(thresholds()).toEqual([0.3]);
  });

  it("retries a window exactly at the long-take bar", async () => {
    h.stderrQueue = ["", ""];

    await detectShots("/x.mp4", 600, 615, cfg, 5000);

    expect(thresholds()).toEqual([0.3, 0.15]);
  });

  it("never lets the retry threshold fall below the floor", async () => {
    h.stderrQueue = ["", ""];

    await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.2 }, 5000);

    // 0.1 would be the half; the floor holds it at 0.15.
    expect(thresholds()).toEqual([0.2, 0.15]);
  });

  it("passes the absolute window to ffmpeg and gets clip-relative shots back", async () => {
    // -ss before -i is what makes showinfo timestamps clip-relative; the shot
    // list is in clip time even though the window is not.
    h.stderrQueue = ["pts_time:10.0"];

    const shots = await detectShots("/x.mp4", 600, 640, cfg, 5000);

    expect(h.calls[0].slice(0, 6)).toEqual([
      "-nostdin",
      "-ss",
      "600",
      "-to",
      "640",
      "-i",
    ]);
    expect(shots).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
  });
});
