import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getPlanLimits,
  PLAN_LIMITS,
  getPlanFromPriceId,
  FREE_TIER,
  estimatedFreeCostUsd,
} from "../plans";

// The free trial was zeroed on 2026-07-25 and turned back on 2026-07-29, once
// the three holes that forced the zeroing were closed (see the comment above
// NONE_LIMITS in ../plans.ts). The tests below assert the live shape directly -
// no config-reading gate any more, because a test that switches itself off is
// a test that cannot catch the switch being thrown by accident.

describe("Plan Limits", () => {
  // The free allowance exists so a new account can see one real result before
  // paying. Every field below has to be non-zero for that to be possible: a
  // zero anywhere is the wall that stopped 92 of 95 registered users.
  //
  // minutesPerPeriod is the one deliberate exception and is checked separately
  // below: the allowance is LIFETIME and is answered by the free_usage ledger,
  // and a per-period number here could only ever mean "inside this window".
  it("NONE plan can actually run one video", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.storageClips).toBeGreaterThan(0);
    expect(limits.retentionDays).toBeGreaterThan(0);
    expect(limits.concurrentJobsLimit).toBeGreaterThan(0);
    expect(limits.maxJobsPerDay).toBeGreaterThan(0);
    expect(limits.maxFileSizeBytes).toBeGreaterThan(0);
    expect(limits.priceUsd).toBe(0);
  });

  // Not an oversight and not a leftover zero from the disabled era: the free
  // allowance is lifetime seconds in FREE_TIER, spent against the ledger. A
  // non-zero minutesPerPeriod here would be a SECOND, renewing allowance
  // sitting beside the lifetime one.
  it("NONE plan has no per-period minute allowance", () => {
    expect(getPlanLimits("NONE").minutesPerPeriod).toBe(0);
  });

  it("NONE plan: 60 min source cap, 10 clips, 3d retention", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.maxSourceDurationMinutes).toBe(60);
    expect(limits.storageClips).toBe(10);
    expect(limits.retentionDays).toBe(3);
    expect(limits.concurrentJobsLimit).toBe(1);
    expect(limits.priorityQueue).toBe(false);
    expect(limits.maxJobsPerDay).toBe(5);
  });

  // The trial is a taste, not a tier: the free source cap must stay well under
  // the paid one or there is no duration reason left to pay for.
  it("free source cap is far below the paid cap", () => {
    expect(getPlanLimits("NONE").maxSourceDurationMinutes).toBeLessThan(
      getPlanLimits("STARTER", "WEEKLY").maxSourceDurationMinutes
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

  describe("free tier", () => {
    it("is a lifetime allowance measured in seconds of source", () => {
      expect(FREE_TIER.lifetimeSeconds).toBe(3600);
    });

    // The whole design rests on this: a free allowance that renews is farmable
    // for ever, so nothing in FREE_TIER may be per-period.
    it("has no period field of any kind", () => {
      expect(Object.keys(FREE_TIER)).toEqual([
        "lifetimeSeconds",
        "zeroClipRefunds",
        "estimatedUsdPerSourceMinute",
      ]);
    });

    it("forgives exactly one empty run", () => {
      expect(FREE_TIER.zeroClipRefunds).toBe(1);
    });

    // The reservation written at submit time is an estimate against the monthly
    // ceiling, so it has to be denominated the same way the ceiling is - USD -
    // and it has to be per source minute, which is the only unit the probe can
    // give us before a byte is downloaded.
    it("prices a source minute so a reservation can be made before the run", () => {
      expect(FREE_TIER.estimatedUsdPerSourceMinute).toBe(0.0095);
    });

    // The whole lifetime allowance is 60 minutes, so one account can cost at
    // most this much. If that ever stops being small relative to a plausible
    // ceiling, the ceiling is no longer the thing bounding the free tier.
    it("puts a whole free allowance well under a dollar", () => {
      const worstCaseUsd = estimatedFreeCostUsd(FREE_TIER.lifetimeSeconds);
      expect(worstCaseUsd).toBeCloseTo(0.57, 5);
    });

    it("bills exact seconds, not rounded-up minutes", () => {
      // 61 seconds is one minute and one second. A ceil to 2 minutes would
      // overstate this by 64%, and the budget would close early for no reason.
      expect(estimatedFreeCostUsd(61)).toBeCloseTo(
        (61 / 60) * 0.0095,
        10
      );
    });

    // Every upload arrives here with the duration unknown (the web route does
    // not probe uploads), so 0 is a routine input, not an error case.
    it("costs nothing for a duration we do not know yet", () => {
      expect(estimatedFreeCostUsd(0)).toBe(0);
      expect(estimatedFreeCostUsd(Number.NaN)).toBe(0);
      expect(estimatedFreeCostUsd(-30)).toBe(0);
    });

    it("stays clearly under one week of the entry tier", () => {
      const starterWeekly = getPlanLimits("STARTER", "WEEKLY").minutesPerPeriod;
      expect(FREE_TIER.lifetimeSeconds / 60).toBeLessThan(starterWeekly);
    });

    it("caps a single free source at the whole allowance, not more", () => {
      expect(getPlanLimits("NONE").maxSourceDurationMinutes).toBe(
        FREE_TIER.lifetimeSeconds / 60
      );
    });

    // The concurrency limit is the only thing holding the zero-clip cap race
    // shut - see the comment in NONE_LIMITS.
    it("keeps free concurrency at one", () => {
      expect(getPlanLimits("NONE").concurrentJobsLimit).toBe(1);
    });

    // maxJobsPerDay is deliberately LOOSER than the allowance can pay for -
    // five jobs a day against sixty lifetime minutes. It is a rate limit, not
    // the allowance: the free_usage ledger is what stops the sixty-first
    // minute, and a daily cap tight enough to double as the allowance would
    // refuse the second short video of someone who has minutes left.
    it("leaves the lifetime bound to the ledger, not to the daily cap", () => {
      const free = getPlanLimits("NONE");
      expect(free.maxJobsPerDay * free.maxSourceDurationMinutes).toBeGreaterThan(
        FREE_TIER.lifetimeSeconds / 60
      );
    });
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
