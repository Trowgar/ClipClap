import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bucketVideoEnvelopesBySecond,
  lumaEnvelope,
  rmsEnvelope,
  videoEnvelopes,
} from "../transcribe";

const execFileAsync = promisify(execFile);

// This file does NOT mock child_process - transcribe.test.ts does that for
// the rest of the suite, but rmsEnvelope's (and videoEnvelopes') actual job
// is to parse REAL ffmpeg astats/signalstats+ametadata output (see each
// function's own comment for the measured format), so a mock would test
// the parser against a shape nobody verified.

let dir: string;
let fixturePath: string;
let videoFixturePath: string;
let movingVideoFixturePath: string;
let staticVideoFixturePath: string;
let audioOnlyFixturePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipclap-rmstest-"));
  fixturePath = join(dir, "sine-then-silence.wav");
  // 3s of a 440Hz tone followed by 2s of true digital silence, concatenated
  // into one 5s mono wav - the loud/quiet split a hook detector needs to
  // distinguish.
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
    "-map", "[out]",
    fixturePath,
  ]);

  videoFixturePath = join(dir, "black-then-white.mp4");
  // 2s of solid black followed by 2s of solid white, concatenated into one
  // 4s video at 1fps - the dark/bright split lumaEnvelope needs to
  // distinguish, sized one frame per second so the fixture's own buckets
  // are unambiguous.
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=black:s=64x64:d=2:r=1",
    "-f", "lavfi", "-i", "color=white:s=64x64:d=2:r=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[out]",
    "-map", "[out]",
    videoFixturePath,
  ]);

  movingVideoFixturePath = join(dir, "moving.mp4");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1:duration=4",
    movingVideoFixturePath,
  ]);

  staticVideoFixturePath = join(dir, "static.mp4");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=gray:s=64x64:r=1:d=4",
    staticVideoFixturePath,
  ]);

  // The corpus's real degenerate case: an audio-only file handed to a
  // function that reads a video stream.
  audioOnlyFixturePath = join(dir, "audio-only.m4a");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    audioOnlyFixturePath,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("rmsEnvelope", () => {
  // If ffmpeg is missing this test cannot say anything, and a silent skip is
  // how a guard becomes decorative. Fail loudly instead: worker containers
  // have ffmpeg, and that is where this suite is meant to run.
  it("has ffmpeg available", async () => {
    await expect(execFileAsync("ffmpeg", ["-version"])).resolves.toBeDefined();
  });

  it("buckets a 5s clip into ~5 per-second values", async () => {
    const envelope = await rmsEnvelope(fixturePath);
    expect(envelope.length).toBeGreaterThanOrEqual(4);
    expect(envelope.length).toBeLessThanOrEqual(6);
  });

  it("scores the sine seconds at least 30dB louder than the silent ones", async () => {
    const envelope = await rmsEnvelope(fixturePath);
    // Bucket 0 is unambiguously inside the 3s tone, and the last bucket is
    // unambiguously inside the trailing silence - true regardless of exactly
    // how many one-second buckets the 5s clip lands as.
    const sineDb = envelope[0];
    const silenceDb = envelope[envelope.length - 1];
    expect(sineDb - silenceDb).toBeGreaterThanOrEqual(30);
  });

  it("maps true silence near -90dB, not literal -Infinity", async () => {
    const envelope = await rmsEnvelope(fixturePath);
    const silenceDb = envelope[envelope.length - 1];
    expect(silenceDb).toBeGreaterThanOrEqual(-91);
    expect(silenceDb).toBeLessThanOrEqual(-85);
  });
});

describe("lumaEnvelope", () => {
  it("buckets a 4s black-then-white clip into ~4 per-second values", async () => {
    const envelope = await lumaEnvelope(videoFixturePath);
    expect(envelope.length).toBeGreaterThanOrEqual(3);
    expect(envelope.length).toBeLessThanOrEqual(5);
  });

  it("separates near-black from near-white seconds (~16 vs ~235)", async () => {
    const envelope = await lumaEnvelope(videoFixturePath);
    // First bucket is unambiguously inside the 2s black half, last bucket
    // unambiguously inside the 2s white half - true regardless of exactly
    // how many one-second buckets the 4s clip lands as.
    const blackLuma = envelope[0];
    const whiteLuma = envelope[envelope.length - 1];
    expect(blackLuma).toBeGreaterThanOrEqual(0);
    expect(blackLuma).toBeLessThan(40);
    expect(whiteLuma).toBeGreaterThan(200);
    expect(whiteLuma).toBeLessThanOrEqual(255);
  });

  it("returns [] for an audio-only source (no video stream to read)", async () => {
    const envelope = await lumaEnvelope(audioOnlyFixturePath);
    expect(envelope).toEqual([]);
  });

  it("returns [] for a source ffmpeg cannot open at all", async () => {
    const envelope = await lumaEnvelope(join(dir, "does-not-exist.mp4"));
    expect(envelope).toEqual([]);
  });
});

describe("videoEnvelopes", () => {
  it("extracts non-empty motion for a synthetic moving 4s source", async () => {
    const { lumaEnvelope: luma, motionEnvelope: motion } =
      await videoEnvelopes(movingVideoFixturePath);

    expect(luma).toHaveLength(4);
    expect(motion).toHaveLength(4);
    expect(Math.max(...motion.slice(1))).toBeGreaterThan(1);
  });

  it("keeps static-source motion near zero after the first sample", async () => {
    const { motionEnvelope: motion } = await videoEnvelopes(staticVideoFixturePath);

    expect(motion.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...motion.slice(1))).toBeLessThan(0.5);
  });

  it("returns both video arrays empty for an audio-only source", async () => {
    await expect(videoEnvelopes(audioOnlyFixturePath)).resolves.toEqual({
      lumaEnvelope: [],
      motionEnvelope: [],
    });
  });
});

describe("bucketVideoEnvelopesBySecond", () => {
  it("keeps dense absolute-second indexing and parses signed scientific PTS", () => {
    const result = bucketVideoEnvelopesBySecond([
      "frame:0 pts_time:+0e0",
      "lavfi.signalstats.YAVG=10.14",
      "lavfi.signalstats.YDIF=0.04",
      "frame:1 pts_time:+1e0",
      "lavfi.signalstats.YAVG=20.26",
      "lavfi.signalstats.YDIF=4.36",
    ].join("\n"));

    expect(result).toEqual({
      lumaEnvelope: [10.1, 20.3],
      motionEnvelope: [0, 4.4],
    });
  });

  it.each([
    ["nonzero PTS", "frame:0 pts_time:1\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1"],
    ["gap", "frame:0 pts_time:0\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1\nframe:2 pts_time:2\nlavfi.signalstats.YAVG=20\nlavfi.signalstats.YDIF=2"],
    ["missing YAVG", "frame:0 pts_time:0\nlavfi.signalstats.YDIF=1"],
    ["missing YDIF", "frame:0 pts_time:0\nlavfi.signalstats.YAVG=10"],
    ["NaN signal", "frame:0 pts_time:0\nlavfi.signalstats.YAVG=NaN\nlavfi.signalstats.YDIF=1"],
    ["nonfinite signal", "frame:0 pts_time:0\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=Infinity"],
    ["NaN PTS", "frame:0 pts_time:NaN\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1"],
    ["nonfinite PTS", "frame:0 pts_time:Infinity\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1"],
  ])("returns empty arrays for %s", (_reason, stderr) => {
    expect(bucketVideoEnvelopesBySecond(stderr)).toEqual({
      lumaEnvelope: [],
      motionEnvelope: [],
    });
  });
});
