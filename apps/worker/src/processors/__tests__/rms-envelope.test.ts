import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmsEnvelope } from "../transcribe";

const execFileAsync = promisify(execFile);

// This file does NOT mock child_process - transcribe.test.ts does that for
// the rest of the suite, but rmsEnvelope's actual job is to parse REAL
// ffmpeg astats/ametadata output (see its comment for the measured format),
// so a mock would test the parser against a shape nobody verified.

let dir: string;
let fixturePath: string;

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
