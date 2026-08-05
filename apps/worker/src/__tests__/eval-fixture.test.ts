import { describe, expect, it } from "vitest";
import { toShape } from "./helpers/eval-fixture";
import type { V2Result } from "../analyze-v2/types";

describe("toShape", () => {
  it("reduces a result to a stable comparable shape", () => {
    const result = {
      highlights: [
        {
          start: 12.34567,
          end: 45.6789,
          title: "T",
          description: "D",
          score: 0.83,
          hookStart: 13,
          hookEnd: 15,
          payoffAt: 44,
          language: "ru",
          lowQuality: false,
          shortMoment: false,
        },
      ],
      telemetry: { tier: "strong", gateDropReasons: { no_clean_end: 2 }, kept: 1 },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(toShape(result)).toEqual({
      count: 1,
      tier: "strong",
      clips: [{ range: "12.3-45.7", score: 0.83, title: "T" }],
      dropReasons: { no_clean_end: 2 },
    });
  });

  it("carries the non-fatal evidence drift into the snapshot", () => {
    // The counter that used to be a dropReason. It has to stay visible HERE,
    // because the snapshot diff is how a prompt change that triples it gets
    // noticed - that is exactly how ca8dfec's 2 -> 9 was found.
    const result = {
      highlights: [],
      telemetry: {
        tier: "strong",
        gateDropReasons: {},
        evidenceOutOfRange: { description_evidence_out_of_range: 3 },
      },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(toShape(result)).toEqual({
      count: 0,
      tier: "strong",
      clips: [],
      dropReasons: {},
      outOfRange: { description_evidence_out_of_range: 3 },
    });
  });

  it("omits the drift block entirely when nothing drifted", () => {
    // Absent, not `{}`: an empty object in every snapshot is noise a reader
    // learns to skip, and this counter only means anything when it is non-zero.
    const result = {
      highlights: [],
      telemetry: { tier: "strong", gateDropReasons: {}, evidenceOutOfRange: {} },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(Object.keys(toShape(result))).not.toContain("outOfRange");
  });

  it("reports an empty result without throwing", () => {
    const result = {
      highlights: [],
      noClipsReason: "NO_VIABLE_MOMENTS",
      telemetry: {},
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(toShape(result)).toEqual({
      count: 0,
      tier: null,
      clips: [],
      dropReasons: {},
      noClipsReason: "NO_VIABLE_MOMENTS",
    });
  });
});
