import { describe, expect, it, vi } from "vitest";
import { needsNormalization, normalizeSource, parseTimelineProbe } from "../processors/normalize";
import { UnsupportedInputError } from "../processors/errors";

// normalizeSource shells out to ffprobe; only the probe leg matters here.
const ffprobeOutput = vi.hoisted(() => ({ json: "" }));
vi.mock("child_process", () => ({
  // promisify(execFile) always passes the callback LAST, so adding an options
  // object moves it from the 3rd argument to the 4th.
  execFile: (
    _cmd: string,
    _args: string[],
    ...rest: unknown[]
  ) => {
    const cb = rest.find((a) => typeof a === "function") as (
      err: Error | null,
      res: { stdout: string; stderr: string }
    ) => void;
    return cb(null, { stdout: ffprobeOutput.json, stderr: "" });
  },
}));

const probeJson = (videoStart: string, audioStart: string, formatStart = "0.000000") =>
  JSON.stringify({
    format: { start_time: formatStart },
    streams: [
      { index: 0, codec_type: "video", start_time: videoStart },
      { index: 1, codec_type: "audio", start_time: audioStart },
    ],
  });

describe("parseTimelineProbe", () => {
  it("extracts per-stream and format start times", () => {
    const p = parseTimelineProbe(probeJson("0.000000", "0.400000"));
    expect(p.videoStart).toBeCloseTo(0);
    expect(p.audioStart).toBeCloseTo(0.4);
    expect(p.formatStart).toBeCloseTo(0);
    expect(p.hasAudio).toBe(true);
    expect(p.hasVideo).toBe(true);
  });
  it("handles N/A start times as unknown", () => {
    const p = parseTimelineProbe(probeJson("N/A", "0.000000"));
    expect(p.videoStart).toBeNull();
  });
  it("handles missing audio stream", () => {
    const p = parseTimelineProbe(
      JSON.stringify({ format: { start_time: "0" }, streams: [{ index: 0, codec_type: "video", start_time: "0" }] })
    );
    expect(p.hasAudio).toBe(false);
    expect(p.hasVideo).toBe(true);
  });
  it("flags audio-only input", () => {
    const p = parseTimelineProbe(
      JSON.stringify({ format: { start_time: "0" }, streams: [{ index: 0, codec_type: "audio", start_time: "0" }] })
    );
    expect(p.hasVideo).toBe(false);
  });
});

describe("normalizeSource", () => {
  it("rejects an audio-only file with UnsupportedInputError", async () => {
    // The download stage keys the UNSUPPORTED_INPUT tag off this exact class,
    // and that tag is what stops the UI promising an automatic retry for a file
    // no retry can fix. The stage test injects the class itself, so without this
    // assertion the production throw site could silently degrade to a plain
    // Error and audio-only uploads would start getting the retry copy.
    ffprobeOutput.json = JSON.stringify({
      format: { start_time: "0" },
      streams: [{ index: 0, codec_type: "audio", start_time: "0" }],
    });
    await expect(normalizeSource("/tmp/audio.m4a")).rejects.toBeInstanceOf(UnsupportedInputError);
  });

  it("passes a clean video through untouched", async () => {
    ffprobeOutput.json = probeJson("0.000000", "0.010000");
    await expect(normalizeSource("/tmp/clean.mp4")).resolves.toEqual({
      path: "/tmp/clean.mp4",
      action: "none",
    });
  });
});

describe("needsNormalization", () => {
  it("skips clean files (all starts within 50ms of zero)", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("0.000000", "0.023000")))).toBe(false);
  });
  it("normalizes when audio and video timelines diverge", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("0.000000", "0.400000")))).toBe(true);
  });
  it("normalizes when any start time is unknown (N/A)", () => {
    expect(needsNormalization(parseTimelineProbe(probeJson("N/A", "0")))).toBe(true);
  });
});
