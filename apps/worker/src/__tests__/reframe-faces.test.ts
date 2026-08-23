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

describe("parseDetectorOutput path", () => {
  const track = (extra: string) =>
    `{"shots":[{"shotIndex":0,"tracks":[{"id":0,"box":{"x":1,"y":2,"w":3,"h":4},` +
    `"score":0.9,"samples":2,"mouthActivity":0.05${extra}}]}]}`;

  it("accepts a track with no path at all", () => {
    const out = parseDetectorOutput(track(""), 1);
    expect(out[0].tracks[0].path).toBeUndefined();
  });

  it("parses a well-formed path", () => {
    const out = parseDetectorOutput(
      track(`,"path":[{"t":0,"x":1,"y":2,"w":3,"h":4}]`),
      1
    );
    expect(out[0].tracks[0].path).toEqual([{ t: 0, x: 1, y: 2, w: 3, h: 4 }]);
  });

  it("rejects a path entry missing a field", () => {
    expect(() =>
      parseDetectorOutput(track(`,"path":[{"t":0,"x":1,"y":2,"w":3}]`), 1)
    ).toThrow("detector_invalid_json");
  });

  it("rejects a path that is not an array", () => {
    expect(() => parseDetectorOutput(track(`,"path":5`), 1)).toThrow(
      "detector_invalid_json"
    );
  });

  it("rejects a non-finite coordinate rather than passing NaN downstream", () => {
    expect(() =>
      parseDetectorOutput(track(`,"path":[{"t":0,"x":null,"y":2,"w":3,"h":4}]`), 1)
    ).toThrow("detector_invalid_json");
  });
});

// spec 2026-08-23-music-shorts v1.1: saliency parsing is TOLERANT, unlike
// camRect above - absent OR malformed both collapse to null and never throw,
// because this is a music-only anchoring hint (plan.ts/filtergraph.ts) that
// must not take down face detection for every other clip over a defect this
// narrow.
describe("saliency in the sidecar contract", () => {
  const track = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };

  it("parses a saliency object when present", () => {
    const raw = JSON.stringify({
      shots: [
        { shotIndex: 0, tracks: [track], saliency: { x: 512.5, spreadFrac: 0.3 } },
      ],
    });
    expect(parseDetectorOutput(raw, 1)[0].saliency).toEqual({ x: 512.5, spreadFrac: 0.3 });
  });

  it("treats an absent saliency key as null, not as a violation", () => {
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [track] }] });
    expect(parseDetectorOutput(raw, 1)[0].saliency).toBeNull();
  });

  it("treats an explicit null saliency (no sampled frames) as null", () => {
    const raw = JSON.stringify({
      shots: [{ shotIndex: 0, tracks: [track], saliency: null }],
    });
    expect(parseDetectorOutput(raw, 1)[0].saliency).toBeNull();
  });

  it("degrades a malformed saliency to null rather than throwing", () => {
    const raw = JSON.stringify({
      shots: [{ shotIndex: 0, tracks: [track], saliency: { x: "left", spreadFrac: 0.3 } }],
    });
    expect(() => parseDetectorOutput(raw, 1)).not.toThrow();
    expect(parseDetectorOutput(raw, 1)[0].saliency).toBeNull();
  });

  it("degrades a saliency missing spreadFrac to null", () => {
    const raw = JSON.stringify({
      shots: [{ shotIndex: 0, tracks: [track], saliency: { x: 512.5 } }],
    });
    expect(parseDetectorOutput(raw, 1)[0].saliency).toBeNull();
  });
});
