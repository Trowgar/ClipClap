import { describe, expect, it } from "vitest";
import { needsNormalization, parseTimelineProbe } from "../processors/normalize";

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
