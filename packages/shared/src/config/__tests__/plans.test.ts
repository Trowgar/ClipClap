import { describe, it, expect } from "vitest";
import { getPlanLimits, PLAN_LIMITS } from "../plans";

describe("Plan Limits", () => {
  it("FREE plan has watermark and 2 videos/week", () => {
    const limits = getPlanLimits("FREE");
    expect(limits.watermark).toBe(true);
    expect(limits.videosPerWeek).toBe(2);
    expect(limits.maxDurationMinutes).toBe(10);
  });

  it("STARTER plan has no watermark and 10 videos/week", () => {
    const limits = getPlanLimits("STARTER");
    expect(limits.watermark).toBe(false);
    expect(limits.videosPerWeek).toBe(10);
    expect(limits.subtitlePresets).toContain("bold");
  });

  it("PRO plan allows 30 videos/week and 3h max", () => {
    const limits = getPlanLimits("PRO");
    expect(limits.videosPerWeek).toBe(30);
    expect(limits.maxDurationMinutes).toBe(180);
  });

  it("all plans are defined", () => {
    expect(Object.keys(PLAN_LIMITS)).toEqual(["FREE", "STARTER", "PRO"]);
  });
});
