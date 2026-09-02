import { describe, expect, it } from "vitest";
import { bucketVideoEnvelopesBySecond } from "../video-envelopes";

describe("isolated video envelope parser", () => {
  it("is importable without constructing the transcription OpenAI client", () => {
    expect(bucketVideoEnvelopesBySecond([
      "frame:0 pts_time:0",
      "lavfi.signalstats.YAVG=10",
      "lavfi.signalstats.YDIF=1",
    ].join("\n"))).toEqual({ lumaEnvelope: [10], motionEnvelope: [1] });
  });

  it("rejects an extreme timestamp without an unbounded fill", () => {
    expect(bucketVideoEnvelopesBySecond([
      "frame:0 pts_time:999999999999",
      "lavfi.signalstats.YAVG=10",
      "lavfi.signalstats.YDIF=1",
    ].join("\n"))).toEqual({ lumaEnvelope: [], motionEnvelope: [] });
  });
});
