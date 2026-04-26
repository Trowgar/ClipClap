import { describe, it, expect } from "vitest";
import { getPlanLimits, PLAN_LIMITS, getPlanFromPriceId } from "../plans";

describe("Plan Limits", () => {
  it("NONE plan has zero quotas", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.minutesPerPeriod).toBe(0);
    expect(limits.storageClips).toBe(0);
  });

  it("STARTER monthly: 270 min, 20 clips, 7d retention", () => {
    const limits = getPlanLimits("STARTER", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(270);
    expect(limits.storageClips).toBe(20);
    expect(limits.retentionDays).toBe(7);
    expect(limits.subtitlePresets).toEqual(["tiktok"]);
    expect(limits.concurrentJobsLimit).toBe(1);
  });

  it("STARTER weekly: 75 min, same features as monthly", () => {
    const limits = getPlanLimits("STARTER", "WEEKLY");
    expect(limits.minutesPerPeriod).toBe(75);
    expect(limits.storageClips).toBe(20);
  });

  it("PLUS monthly: 1000 min, 150 clips, 30d retention, 3 presets", () => {
    const limits = getPlanLimits("PLUS", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(1000);
    expect(limits.storageClips).toBe(150);
    expect(limits.retentionDays).toBe(30);
    expect(limits.subtitlePresets).toEqual(["tiktok", "minimal", "bold"]);
    expect(limits.concurrentJobsLimit).toBe(2);
  });

  it("MAX monthly: 3500 min, 1000 clips, 90d retention, all presets, priority", () => {
    const limits = getPlanLimits("MAX", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(3500);
    expect(limits.storageClips).toBe(1000);
    expect(limits.retentionDays).toBe(90);
    expect(limits.priorityQueue).toBe(true);
    expect(limits.concurrentJobsLimit).toBe(3);
  });

  it("PLUS and MAX do not have weekly cycles", () => {
    expect(() => getPlanLimits("PLUS", "WEEKLY")).toThrow(/no weekly/i);
    expect(() => getPlanLimits("MAX", "WEEKLY")).toThrow(/no weekly/i);
  });

  it("max source duration per upload is 180 min across all paid plans", () => {
    expect(getPlanLimits("STARTER", "MONTHLY").maxSourceDurationMinutes).toBe(180);
    expect(getPlanLimits("PLUS", "MONTHLY").maxSourceDurationMinutes).toBe(180);
    expect(getPlanLimits("MAX", "MONTHLY").maxSourceDurationMinutes).toBe(180);
  });

  it("max jobs per day scales with tier", () => {
    expect(getPlanLimits("STARTER", "MONTHLY").maxJobsPerDay).toBe(20);
    expect(getPlanLimits("PLUS", "MONTHLY").maxJobsPerDay).toBe(50);
    expect(getPlanLimits("MAX", "MONTHLY").maxJobsPerDay).toBe(100);
  });

  it("getPlanFromPriceId returns correct tuple", () => {
    process.env.STRIPE_STARTER_WEEKLY_PRICE_ID = "price_sw";
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID = "price_sm";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_pm";
    process.env.STRIPE_MAX_MONTHLY_PRICE_ID = "price_mm";

    expect(getPlanFromPriceId("price_sw")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
    expect(getPlanFromPriceId("price_sm")).toEqual({ plan: "STARTER", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_pm")).toEqual({ plan: "PLUS", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_mm")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_unknown")).toBeNull();
  });
});
