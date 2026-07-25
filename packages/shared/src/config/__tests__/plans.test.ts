import { describe, it, expect, afterEach, vi } from "vitest";
import { getPlanLimits, PLAN_LIMITS, getPlanFromPriceId, FREE_TIER } from "../plans";

describe("Plan Limits", () => {
  // The free allowance exists so a new account can see one real result before
  // paying. Every field below has to be non-zero for that to be possible: a
  // zero anywhere is the wall that stopped 92 of 95 registered users.
  it("NONE plan can actually run one video", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.minutesPerPeriod).toBeGreaterThanOrEqual(
      limits.maxSourceDurationMinutes
    );
    expect(limits.storageClips).toBeGreaterThan(0);
    expect(limits.retentionDays).toBeGreaterThan(0);
    expect(limits.concurrentJobsLimit).toBeGreaterThan(0);
    expect(limits.maxJobsPerDay).toBeGreaterThan(0);
    expect(limits.maxFileSizeBytes).toBeGreaterThan(0);
    expect(limits.priceUsd).toBe(0);
  });

  it("NONE plan: 30 min source cap, 12 clips, 3d retention", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.maxSourceDurationMinutes).toBe(30);
    expect(limits.storageClips).toBe(12);
    expect(limits.retentionDays).toBe(3);
    expect(limits.concurrentJobsLimit).toBe(1);
    expect(limits.priorityQueue).toBe(false);
  });

  // The trial is a taste, not a tier: the free source cap must stay well under
  // the paid one or there is no duration reason left to pay for.
  it("free source cap is far below the paid cap", () => {
    expect(getPlanLimits("NONE").maxSourceDurationMinutes).toBeLessThan(
      getPlanLimits("STARTER", "WEEKLY").maxSourceDurationMinutes
    );
  });

  // Runs are the billable unit of the trial; attempts are the backstop that
  // bounds what empty runs can cost us. Attempts must exceed runs or a single
  // zero-clip video would end the trial without showing anything.
  it("FREE_TIER grants one run with a small attempt backstop", () => {
    expect(FREE_TIER.runs).toBe(1);
    expect(FREE_TIER.attempts).toBe(3);
    expect(FREE_TIER.attempts).toBeGreaterThan(FREE_TIER.runs);
  });

  // maxJobsPerDay must not be looser than the lifetime attempt backstop, or the
  // daily gate would let a user spend the whole lifetime budget and then some.
  it("free daily job cap does not exceed the lifetime attempt cap", () => {
    expect(getPlanLimits("NONE").maxJobsPerDay).toBeLessThanOrEqual(
      FREE_TIER.attempts
    );
  });

  it("STARTER monthly: 270 min, 20 clips, 7d retention", () => {
    const limits = getPlanLimits("STARTER", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(270);
    expect(limits.storageClips).toBe(20);
    expect(limits.retentionDays).toBe(7);
    expect(limits.concurrentJobsLimit).toBe(1);
  });

  it("STARTER weekly: 75 min, same features as monthly", () => {
    const limits = getPlanLimits("STARTER", "WEEKLY");
    expect(limits.minutesPerPeriod).toBe(75);
    expect(limits.storageClips).toBe(20);
  });

  it("PLUS monthly: 1000 min, 150 clips, 30d retention", () => {
    const limits = getPlanLimits("PLUS", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(1000);
    expect(limits.storageClips).toBe(150);
    expect(limits.retentionDays).toBe(30);
    expect(limits.concurrentJobsLimit).toBe(2);
  });

  it("MAX monthly: 3500 min, 1000 clips, 90d retention, priority", () => {
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

  describe("getPlanFromPriceId", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns correct tuple for each priceId", () => {
      vi.stubEnv("STRIPE_STARTER_WEEKLY_PRICE_ID", "price_sw");
      vi.stubEnv("STRIPE_STARTER_MONTHLY_PRICE_ID", "price_sm");
      vi.stubEnv("STRIPE_PLUS_MONTHLY_PRICE_ID", "price_pm");
      vi.stubEnv("STRIPE_MAX_MONTHLY_PRICE_ID", "price_mm");

      expect(getPlanFromPriceId("price_sw")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
      expect(getPlanFromPriceId("price_sm")).toEqual({ plan: "STARTER", cycle: "MONTHLY" });
      expect(getPlanFromPriceId("price_pm")).toEqual({ plan: "PLUS", cycle: "MONTHLY" });
      expect(getPlanFromPriceId("price_mm")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
      expect(getPlanFromPriceId("price_unknown")).toBeNull();
    });

    it("returns null for empty priceId even when env vars are unset", () => {
      vi.stubEnv("STRIPE_STARTER_WEEKLY_PRICE_ID", "");
      vi.stubEnv("STRIPE_STARTER_MONTHLY_PRICE_ID", "");
      expect(getPlanFromPriceId("")).toBeNull();
    });
  });
});
