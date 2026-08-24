import { beforeEach, describe, expect, it, vi } from "vitest";

// A separate file from reframe-shots.test.ts on purpose: that one tests the
// pure functions and must stay free of module mocks. Here the ffmpeg boundary
// is mocked so the ONE-pass contract can be asserted: scdet is asked once, at
// the candidate floor, and cuts / retry / candidates are read off that list.

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
import { DEFAULT_CAMERA } from "../reframe/camera";

/** Threshold used by each scdet invocation, read back out of the -vf argument. */
const thresholds = () =>
  h.calls.map((args) => {
    const vf = args[args.indexOf("-vf") + 1];
    return Number(/gte\(scene,([0-9.]+)\)/.exec(vf)![1]);
  });

/** ffmpeg stderr as `metadata=print` writes it. */
const scored = (rows: Array<[number, number]>) =>
  rows
    .map(
      ([t, s]) =>
        `[Parsed_metadata_2 @ 0x1] frame:0    pts:1   pts_time:${t}\n` +
        `[Parsed_metadata_2 @ 0x1] lavfi.scene_score=${s}\n`
    )
    .join("");

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
  motion: false,
  cutRecovery: false,
  tailKeep: false,
  saliencyShadow: false,
  streamVirtualCam: false,
  camera: DEFAULT_CAMERA,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

describe("detectShots single pass", () => {
  beforeEach(() => {
    h.calls = [];
    h.stderrQueue = [];
  });

  it("asks scdet once at the candidate floor and keeps cuts at the configured threshold", async () => {
    h.stderrQueue = [scored([[12.4, 0.41], [20.0, 0.22], [31.0, 0.35]])];

    const r = await detectShots("/x.mp4", 0, 40, cfg, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 12.4 },
      { start: 12.4, end: 31.0 },
      { start: 31.0, end: 40 },
    ]);
    expect(r.candidates).toEqual([{ t: 20.0, score: 0.22 }]);
  });

  it("uses metadata=print and drops the progress line", async () => {
    h.stderrQueue = [""];
    await detectShots("/x.mp4", 0, 10, cfg, 5000);
    const args = h.calls[0];
    expect(args).toContain("-nostats");
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale=320:-2,select='gte(scene,0.15)',metadata=print"
    );
  });

  it("promotes half-threshold cuts on a long zero-cut window without a second pass", async () => {
    // 0.4 halves to 0.2, clear of the 0.15 floor - so this asserts the halving
    // itself: 0.25 becomes a cut, 0.16 stays a candidate.
    h.stderrQueue = [scored([[20.0, 0.25], [30.0, 0.16]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.4 }, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 40 },
    ]);
    expect(r.candidates).toEqual([{ t: 30.0, score: 0.16 }]);
  });

  it("does not lower the bar for a window shorter than the long-take bar", async () => {
    h.stderrQueue = [scored([[7.0, 0.25]])];

    const r = await detectShots("/x.mp4", 0, 14.9, cfg, 5000);

    expect(r.shots).toEqual([{ start: 0, end: 14.9 }]);
    expect(r.candidates).toEqual([{ t: 7.0, score: 0.25 }]);
  });

  it("lowers the bar for a window exactly at the long-take bar", async () => {
    h.stderrQueue = [scored([[7.0, 0.25]])];

    const r = await detectShots("/x.mp4", 600, 615, cfg, 5000);

    expect(r.shots).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 15 },
    ]);
    expect(r.candidates).toEqual([]);
  });

  it("never lets the retry threshold fall below the floor", async () => {
    // 0.1 would be the half; the floor holds it at 0.15, so 0.16 IS a cut and
    // 0.12 is neither cut nor candidate.
    h.stderrQueue = [scored([[10.0, 0.16], [20.0, 0.12]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.2 }, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
    expect(r.candidates).toEqual([]);
  });

  it("moves the pass down with a configured threshold below the floor", async () => {
    h.stderrQueue = [scored([[10.0, 0.12]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.1 }, 5000);

    expect(thresholds()).toEqual([0.1]);
    expect(r.shots).toHaveLength(2);
    expect(r.candidates).toEqual([]);
  });

  it("passes the absolute window to ffmpeg and gets clip-relative shots back", async () => {
    // -ss before -i is what makes the timestamps clip-relative; the shot list
    // is in clip time even though the window is not.
    h.stderrQueue = [scored([[10.0, 0.5]])];

    const r = await detectShots("/x.mp4", 600, 640, cfg, 5000);

    expect(h.calls[0].slice(0, 7)).toEqual([
      "-nostdin",
      "-nostats",
      "-ss",
      "600",
      "-to",
      "640",
      "-i",
    ]);
    expect(r.shots).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
  });

  it("rejects when a selected frame carries no score", async () => {
    h.stderrQueue = ["[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:10.0\n"];

    await expect(detectShots("/x.mp4", 0, 40, cfg, 5000)).rejects.toThrow(
      /scdet_score_missing/
    );
  });

  // spec 2026-08-24-camera-visual-anchoring mechanism C, cops reproduction:
  // a hard cut at 31.53s (score 0.493, above sceneThreshold) leaves a 0.77s
  // tail before the 32.3s window end - too short for minShotSec 1.0.
  it("threads cfg.tailKeep into cutsToShots: a real hard-cut tail survives as its own shot", async () => {
    h.stderrQueue = [
      scored([
        [1.668, 0.6],
        [8.642, 0.6],
        [9.81, 0.6],
        [12.813, 0.6],
        [15.282, 0.6],
        [17.017, 0.6],
        [24.458, 0.6],
        [31.5315, 0.493],
      ]),
    ];

    const r = await detectShots("/x.mp4", 0, 32.3, { ...cfg, tailKeep: true }, 5000);

    expect(r.shots[r.shots.length - 2]).toEqual({ start: 24.458, end: 31.5315 });
    expect(r.shots[r.shots.length - 1]).toEqual({ start: 31.5315, end: 32.3 });
  });

  it("cfg.tailKeep false (the default) keeps merging the tail backward", async () => {
    h.stderrQueue = [
      scored([
        [1.668, 0.6],
        [8.642, 0.6],
        [9.81, 0.6],
        [12.813, 0.6],
        [15.282, 0.6],
        [17.017, 0.6],
        [24.458, 0.6],
        [31.5315, 0.493],
      ]),
    ];

    const r = await detectShots("/x.mp4", 0, 32.3, cfg, 5000);

    expect(r.shots[r.shots.length - 1]).toEqual({ start: 24.458, end: 32.3 });
  });
});
