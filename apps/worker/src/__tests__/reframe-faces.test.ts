import { describe, expect, it } from "vitest";
import { parseDetectorOutput } from "../reframe/faces";

const validTrack = {
  id: 0,
  box: { x: 100, y: 50, w: 200, h: 260 },
  score: 0.92,
  samples: 12,
  mouthActivity: 0.04,
};

describe("parseDetectorOutput", () => {
  it("parses a valid document", () => {
    const raw = JSON.stringify({
      shots: [
        { shotIndex: 0, tracks: [validTrack] },
        { shotIndex: 1, tracks: [] },
      ],
    });
    const parsed = parseDetectorOutput(raw, 2);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].tracks[0].box.w).toBe(200);
    expect(parsed[1].tracks).toEqual([]);
  });

  it("throws detector_invalid_json on non-JSON", () => {
    expect(() => parseDetectorOutput("not json", 1)).toThrow("detector_invalid_json");
  });

  it("throws when the shot count does not match", () => {
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [] }] });
    expect(() => parseDetectorOutput(raw, 2)).toThrow("detector_invalid_json");
  });

  it("throws on a track with a missing/invalid field", () => {
    const bad = { ...validTrack, box: { x: 1, y: 2, w: "wide", h: 4 } };
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [bad] }] });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });

  it("throws on NaN smuggled through as null", () => {
    const bad = { ...validTrack, mouthActivity: null };
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [bad] }] });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });
});

describe("camRect in the sidecar contract", () => {
  const track = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };

  it("parses a camRect when present", () => {
    const raw = JSON.stringify({
      shots: [
        {
          shotIndex: 0,
          tracks: [track],
          camRect: { x: 0, y: 0, w: 428, h: 240, score: 4.7 },
        },
      ],
    });
    const parsed = parseDetectorOutput(raw, 1);
    expect(parsed[0].camRect).toEqual({ x: 0, y: 0, w: 428, h: 240, score: 4.7 });
  });

  it("treats an absent camRect as null, not as a violation", () => {
    const raw = JSON.stringify({
      shots: [{ shotIndex: 0, tracks: [track] }],
    });
    expect(parseDetectorOutput(raw, 1)[0].camRect).toBeNull();
  });

  it("rejects a malformed camRect", () => {
    const raw = JSON.stringify({
      shots: [
        { shotIndex: 0, tracks: [track], camRect: { x: 0, y: 0, w: "wide" } },
      ],
    });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });
});
