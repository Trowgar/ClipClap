import { describe, expect, it } from "vitest";
import { recoverCuts, sliceTracks, TURNOVER_SAMPLES } from "../reframe/cut-recovery";
import type { CutCandidate } from "../reframe/shots";
import type { FaceTrack, PathSample, Shot, ShotTracks } from "../reframe/types";

const CFG = { minShotSec: 1.0, sampleFps: 2, maxPlanShots: 90 };

/** A track seen at 2 fps from `from` (inclusive) to `to` (exclusive) at a fixed x. */
function track(id: number, from: number, to: number, x: number): FaceTrack {
  const path: PathSample[] = [];
  for (let t = from; t < to - 1e-9; t += 0.5) path.push({ t, x, y: 100, w: 200, h: 200 });
  return {
    id,
    box: { x, y: 100, w: 200, h: 200 },
    score: 0.9,
    samples: path.length,
    mouthActivity: 0.1,
    path,
  };
}

const shot = (start: number, end: number): Shot => ({ start, end });
const st = (shotIndex: number, tracks: FaceTrack[]): ShotTracks => ({
  shotIndex,
  tracks,
  camRect: null,
});
const cand = (t: number, score = 0.22): CutCandidate => ({ t, score });

describe("recoverCuts", () => {
  it("splits a shot at a candidate where the live face set changes wholesale", () => {
    // A is on screen 0-5, B 5-10: two camera angles scdet under-scored.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10)]);
    expect(r.tracksByShot.map((s) => s.shotIndex)).toEqual([0, 1]);
    // Each side keeps ONLY the face that is on screen there, with its own median.
    expect(r.tracksByShot[0].tracks.map((t) => [t.id, t.box.x, t.samples])).toEqual([[1, 100, 10]]);
    expect(r.tracksByShot[1].tracks.map((t) => [t.id, t.box.x, t.samples])).toEqual([[2, 1200, 10]]);
    expect(r.telemetry).toEqual({
      candidates: 1,
      confirmed: 1,
      rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
      capHit: 0,
    });
  });

  it("does not split when a face continues across the candidate", () => {
    // A is on screen throughout; B joins at 5. A zoom or a gesture, not a cut.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 10, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots); // same reference: nothing changed
    expect(r.tracksByShot).toBe(tracks);
    expect(r.telemetry.rejected.noTurnover).toBe(1);
    expect(r.telemetry.confirmed).toBe(0);
  });

  it("does not split when one side has no face", () => {
    // Face then b-roll: the whole-shot median already sits on the face.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots);
    expect(r.telemetry.rejected.oneSideEmpty).toBe(1);
  });

  it("does not create a sub-shot shorter than minShotSec, on either side", () => {
    // Both tracks clear the noise floor (3 and 5 samples against a max of 5),
    // the turnover is real, but one segment would be 1.5s under a 2.0s floor.
    // (A track that is on screen for only one sample is already gone at the
    // noise floor and lands in oneSideEmpty - that is the tracker's floor, not
    // this rule's, which is why the floor here is raised instead.)
    const short = { ...CFG, minShotSec: 2.0 };
    const left = recoverCuts(
      [shot(0, 4)],
      [st(0, [track(1, 0, 1.5, 100), track(2, 1.5, 4, 1200)])],
      [cand(1.5)],
      short
    );
    expect(left.shots).toEqual([shot(0, 4)]);
    expect(left.telemetry.rejected.tooShort).toBe(1);

    const right = recoverCuts(
      [shot(0, 4)],
      [st(0, [track(1, 0, 2.5, 100), track(2, 2.5, 4, 1200)])],
      [cand(2.5)],
      short
    );
    expect(right.shots).toEqual([shot(0, 4)]);
    expect(right.telemetry.rejected.tooShort).toBe(1);
  });

  it("splits twice in one shot and renumbers the shots that follow", () => {
    const shots = [shot(0, 15), shot(15, 20)];
    const tracks = [
      st(0, [track(1, 0, 5, 100), track(2, 5, 10, 700), track(3, 10, 15, 1300)]),
      st(1, [track(9, 15, 20, 400)]),
    ];

    const r = recoverCuts(shots, tracks, [cand(10), cand(5)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10), shot(10, 15), shot(15, 20)]);
    expect(r.tracksByShot.map((s) => s.shotIndex)).toEqual([0, 1, 2, 3]);
    expect(r.tracksByShot[3].tracks.map((t) => t.id)).toEqual([9]);
    expect(r.telemetry.confirmed).toBe(2);
    // The untouched shot's tracks are the same object, just under a new index.
    expect(r.tracksByShot[3].tracks).toBe(tracks[1].tracks);
  });

  it("returns the inputs untouched when a track has no path", () => {
    const noPath: FaceTrack = { ...track(1, 0, 5, 100), path: undefined };
    const shots = [shot(0, 10)];
    const tracks = [st(0, [noPath, track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots);
    expect(r.telemetry.rejected.noPath).toBe(1);
  });

  it("stops confirming at the plan-shot cap and counts the rest", () => {
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], { ...CFG, maxPlanShots: 1 });

    expect(r.shots).toBe(shots);
    expect(r.telemetry.capHit).toBe(1);
    expect(r.telemetry.confirmed).toBe(0);
  });

  it("ignores candidates that sit on a shot boundary or outside every shot", () => {
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(0), cand(10), cand(12)], CFG);

    expect(r.telemetry.candidates).toBe(0);
    expect(r.shots).toBe(shots);
  });

  it("tests turnover on LIVE samples, so a revived track still counts as a change", () => {
    // Track 1 is seen 0-5 AND again 7-10 (the sidecar revives a stale track by
    // IoU against its last box). Around t=5 the live sets are {1} and {2}:
    // disjoint, a real change. Around t=7 they are {2} and {1,2}: not disjoint.
    const revived: FaceTrack = {
      ...track(1, 0, 5, 100),
      path: [...track(1, 0, 5, 100).path!, ...track(1, 7, 10, 100).path!],
      samples: 16,
    };
    const shots = [shot(0, 10)];
    const tracks = [st(0, [revived, track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5), cand(7)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10)]);
    expect(r.telemetry.confirmed).toBe(1);
    expect(r.telemetry.rejected.noTurnover).toBe(1);
  });

  it("uses TURNOVER_SAMPLES samples on each side of the candidate", () => {
    // Sanity on the exported knob so a change to it is a visible diff.
    expect(TURNOVER_SAMPLES).toBe(2);
  });
});

describe("sliceTracks", () => {
  it("keeps the last sample of the final segment (inclusive end)", () => {
    const tr = track(1, 0, 10, 100); // samples 0 .. 9.5
    const tail = sliceTracks([tr], 9.5, 10, true);
    expect(tail).toHaveLength(1);
    expect(tail[0].samples).toBe(1);
  });

  it("takes a per-coordinate median of the sub-range samples", () => {
    const tr: FaceTrack = {
      id: 1,
      box: { x: 0, y: 0, w: 0, h: 0 },
      score: 0.9,
      samples: 4,
      mouthActivity: 0,
      path: [
        { t: 0, x: 100, y: 10, w: 50, h: 50 },
        { t: 0.5, x: 300, y: 10, w: 50, h: 50 },
        { t: 1.0, x: 900, y: 10, w: 50, h: 50 },
        { t: 1.5, x: 950, y: 10, w: 50, h: 50 },
      ],
    };
    // [0, 1) -> x 100, 300 -> median 200; [1, 2) -> 900, 950 -> 925
    expect(sliceTracks([tr], 0, 1, false)[0].box.x).toBe(200);
    expect(sliceTracks([tr], 1, 2, true)[0].box.x).toBe(925);
  });

  it("drops a track with no sample in the range", () => {
    expect(sliceTracks([track(1, 0, 5, 100)], 5, 10, true)).toEqual([]);
  });
});
