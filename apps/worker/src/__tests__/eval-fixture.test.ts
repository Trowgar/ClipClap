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
