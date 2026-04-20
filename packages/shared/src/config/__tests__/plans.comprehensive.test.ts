import { describe, it, expect } from "vitest";
import { getPlanLimits, PLAN_LIMITS, type PlanLimits } from "../plans";

describe("Plan Limits — comprehensive", () => {
  describe("structure", () => {
    it("has exactly 3 plans", () => {
      expect(Object.keys(PLAN_LIMITS)).toHaveLength(3);
    });

    it("plans are FREE, STARTER, PRO in order", () => {
      expect(Object.keys(PLAN_LIMITS)).toEqual(["FREE", "STARTER", "PRO"]);
    });

    it("every plan has all required fields", () => {
      const requiredKeys: (keyof PlanLimits)[] = [
        "videosPerWeek",
        "maxDurationMinutes",
        "subtitlePresets",
        "telegramBot",
        "watermark",
        "priceWeekly",
      ];
      for (const plan of Object.values(PLAN_LIMITS)) {
        for (const key of requiredKeys) {
          expect(plan).toHaveProperty(key);
        }
      }
    });
  });

  describe("pricing hierarchy", () => {
    it("FREE costs $0", () => {
      expect(getPlanLimits("FREE").priceWeekly).toBe(0);
    });

    it("price increases with tier: FREE < STARTER < PRO", () => {
      const free = getPlanLimits("FREE").priceWeekly;
      const starter = getPlanLimits("STARTER").priceWeekly;
      const pro = getPlanLimits("PRO").priceWeekly;
      expect(free).toBeLessThan(starter);
      expect(starter).toBeLessThan(pro);
    });
  });

  describe("video limits hierarchy", () => {
    it("videos per week increases with tier", () => {
      const free = getPlanLimits("FREE").videosPerWeek;
      const starter = getPlanLimits("STARTER").videosPerWeek;
      const pro = getPlanLimits("PRO").videosPerWeek;
      expect(free).toBeLessThan(starter);
      expect(starter).toBeLessThan(pro);
    });

    it("max duration increases with tier", () => {
      const free = getPlanLimits("FREE").maxDurationMinutes;
      const starter = getPlanLimits("STARTER").maxDurationMinutes;
      const pro = getPlanLimits("PRO").maxDurationMinutes;
      expect(free).toBeLessThan(starter);
      expect(starter).toBeLessThan(pro);
    });

    it("all limits are positive integers", () => {
      for (const plan of Object.values(PLAN_LIMITS)) {
        expect(plan.videosPerWeek).toBeGreaterThan(0);
        expect(plan.maxDurationMinutes).toBeGreaterThan(0);
        expect(Number.isInteger(plan.videosPerWeek)).toBe(true);
        expect(Number.isInteger(plan.maxDurationMinutes)).toBe(true);
      }
    });
  });

  describe("subtitle presets", () => {
    it("every plan has at least tiktok preset", () => {
      for (const plan of Object.values(PLAN_LIMITS)) {
        expect(plan.subtitlePresets).toContain("tiktok");
      }
    });

    it("higher tiers have more or equal presets than lower", () => {
      const free = getPlanLimits("FREE").subtitlePresets.length;
      const starter = getPlanLimits("STARTER").subtitlePresets.length;
      const pro = getPlanLimits("PRO").subtitlePresets.length;
      expect(starter).toBeGreaterThanOrEqual(free);
      expect(pro).toBeGreaterThanOrEqual(starter);
    });

    it("paid plans include bold preset", () => {
      expect(getPlanLimits("STARTER").subtitlePresets).toContain("bold");
      expect(getPlanLimits("PRO").subtitlePresets).toContain("bold");
    });

    it("FREE plan has only one preset", () => {
      expect(getPlanLimits("FREE").subtitlePresets).toHaveLength(1);
    });
  });

  describe("feature flags", () => {
    it("FREE has watermark, paid plans do not", () => {
      expect(getPlanLimits("FREE").watermark).toBe(true);
      expect(getPlanLimits("STARTER").watermark).toBe(false);
      expect(getPlanLimits("PRO").watermark).toBe(false);
    });

    it("FREE has no telegram bot access", () => {
      expect(getPlanLimits("FREE").telegramBot).toBe(false);
    });

    it("paid plans have telegram bot access", () => {
      expect(getPlanLimits("STARTER").telegramBot).toBe(true);
      expect(getPlanLimits("PRO").telegramBot).toBe(true);
    });
  });

  describe("specific plan values", () => {
    it("FREE: 2 videos, 10 min, $0", () => {
      const l = getPlanLimits("FREE");
      expect(l.videosPerWeek).toBe(2);
      expect(l.maxDurationMinutes).toBe(10);
      expect(l.priceWeekly).toBe(0);
    });

    it("STARTER: 10 videos, 60 min, $3", () => {
      const l = getPlanLimits("STARTER");
      expect(l.videosPerWeek).toBe(10);
      expect(l.maxDurationMinutes).toBe(60);
      expect(l.priceWeekly).toBe(3);
    });

    it("PRO: 30 videos, 180 min, $5", () => {
      const l = getPlanLimits("PRO");
      expect(l.videosPerWeek).toBe(30);
      expect(l.maxDurationMinutes).toBe(180);
      expect(l.priceWeekly).toBe(5);
    });
  });

  describe("getPlanLimits function", () => {
    it("returns correct object for each valid plan", () => {
      expect(getPlanLimits("FREE")).toBe(PLAN_LIMITS.FREE);
      expect(getPlanLimits("STARTER")).toBe(PLAN_LIMITS.STARTER);
      expect(getPlanLimits("PRO")).toBe(PLAN_LIMITS.PRO);
    });

    it("returns undefined for invalid plan", () => {
      // @ts-expect-error testing invalid input
      expect(getPlanLimits("INVALID")).toBeUndefined();
    });
  });
});
