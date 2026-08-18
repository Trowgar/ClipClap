import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getPlanLimits,
  PLAN_LIMITS,
  getPlanFromPriceId,
  FREE_TIER,
  estimatedFreeCostUsd,
  SOURCE_FLOOR,
  isBelowSourceFloor,
  isShortSource,
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
    // 60 since 2026-08-18: at the 60s floor and 3600 lifetime seconds it is
    // the most jobs a free account can EVER create, so the day cap can no
    // longer bind before the ledger does (it had refused only good accounts).
    expect(limits.maxJobsPerDay).toBe(
      FREE_TIER.lifetimeSeconds / SOURCE_FLOOR.minDurationSec
    );
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
        "estimatedUsdPerRun",
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
      expect(FREE_TIER.estimatedUsdPerSourceMinute).toBe(0.012);
    });

    // The critic costs about the same on a three-minute clip as on a
    // thirty-minute one, so a purely per-minute estimate is worst exactly where
    // new users start. Reserving too little is the dangerous direction: the
    // reservation is all that bounds spend that has not finalized yet.
    it("charges a fixed component per run, not only per minute", () => {
      expect(FREE_TIER.estimatedUsdPerRun).toBe(0.03);
      // Measured: a 174-second source really cost 0.046 in cash. The old
      // per-minute-only model reserved 0.028 for it.
      expect(estimatedFreeCostUsd(174)).toBeGreaterThan(0.046);
      // ...and not wildly more than it, or short runs stop fitting the ceiling.
      expect(estimatedFreeCostUsd(174)).toBeLessThan(0.08);
    });

    // THE TABLE. Every prod job that carried cost telemetry on 2026-07-30, plus
    // the two short walk runs whose job rows were deleted with their projects.
    // `cash` is transcription + analysis; compute is deliberately not money.
    //
    // This is the assertion the docstring in plans.ts used to make in prose and
    // get wrong: with the old 0.020/0.010 the 3138-second/0.5870 row reserved
    // 0.5430 and the 188-second/0.0610 row reserved 0.0513. Add rows to it as
    // prod produces them; the direction of the inequality is the invariant.
    it("reserves at or above the real cash for every measured prod run", () => {
      const measured: Array<{ secs: number; cash: number; note: string }> = [
        { secs: 174, cash: 0.046, note: "walk 1, row deleted with its project" },
        { secs: 188, cash: 0.061, note: "walk 2, row deleted with its project" },
        { secs: 501, cash: 0.05, note: "cmpkb1o4v00015zbx4rfjy0zj" },
        { secs: 1789, cash: 0.233, note: "cmrkvyzln000113tcps7f5hv0" },
        { secs: 1790, cash: 0.18, note: "cmpg0xg2a0001nsy610003yxf" },
        { secs: 1790, cash: 0.271, note: "cmrv9t0x5000y9pvweq9c8j78" },
        { secs: 1790, cash: 0.18, note: "cmpfzi7jz00016olp9gr9p4ng" },
        { secs: 2385, cash: 0.241, note: "cmrj4sopj0001jqlzmsfl120l" },
        { secs: 3138, cash: 0.537, note: "cmrvawjxs00129pvw0oe1c1kv" },
        { secs: 3138, cash: 0.502, note: "cms7jhcbz0003nb7fkfdki0lp" },
        { secs: 3138, cash: 0.587, note: "cmrzcqhl6000138lkg41n8bs0" },
        { secs: 3138, cash: 0.471, note: "cms2c8ahm000droa7tcqh30ho" },
      ];
      for (const run of measured) {
        expect(
          estimatedFreeCostUsd(run.secs),
          `${run.secs}s (${run.note}) must reserve at least ${run.cash}`
        ).toBeGreaterThanOrEqual(run.cash);
      }
    });

    // The whole lifetime allowance is 60 minutes, so one account spending it in
    // a single run can cost at most this much. If that ever stops being small
    // relative to a plausible ceiling, the ceiling is no longer the thing
    // bounding the free tier.
    it("puts a whole free allowance well under a dollar", () => {
      const worstCaseUsd = estimatedFreeCostUsd(FREE_TIER.lifetimeSeconds);
      expect(worstCaseUsd).toBeCloseTo(0.75, 5);
      expect(worstCaseUsd).toBeLessThan(1);
    });

    it("bills exact seconds, not rounded-up minutes", () => {
      // 61 seconds is one minute and one second. A ceil to 2 minutes would
      // overstate the per-minute half by 64%, and the budget would close early
      // for no reason.
      expect(estimatedFreeCostUsd(61)).toBeCloseTo(0.03 + (61 / 60) * 0.012, 10);
    });

    // Every upload arrives here with the duration unknown (the web route does
    // not probe uploads), so 0 is a routine input, not an error case - and it
    // used to reserve 0.00 USD, which meant the in-flight bound was absent on
    // the one path that had already been seen letting six concurrent
    // submissions through. An unmeasured submission is still a run.
    it("reserves the flat per-run amount when the duration is unknown", () => {
      expect(estimatedFreeCostUsd(0)).toBe(FREE_TIER.estimatedUsdPerRun);
      expect(estimatedFreeCostUsd(Number.NaN)).toBe(FREE_TIER.estimatedUsdPerRun);
      expect(estimatedFreeCostUsd(-30)).toBe(FREE_TIER.estimatedUsdPerRun);
      expect(estimatedFreeCostUsd(0)).toBeGreaterThan(0);
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

    // maxJobsPerDay is deliberately LOOSER than the allowance can pay for.
    // It is a rate limit, not the allowance: the free_usage ledger is what
    // stops the sixty-first minute, and a daily cap tight enough to double as
    // the allowance would refuse the second short video of someone who has
    // minutes left - which the old cap of five did, to three real people.
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

describe("SOURCE_FLOOR", () => {
  // The numbers come from the 57-job corpus in the plans.ts comment; the
  // shape is what matters here: unknown is never judged, the floor is a strict
  // less-than, and the notice band is [floor, notice).
  it("refuses only a KNOWN duration under the floor", () => {
    expect(isBelowSourceFloor(SOURCE_FLOOR.minDurationSec - 1)).toBe(true);
    expect(isBelowSourceFloor(1)).toBe(true);
    expect(isBelowSourceFloor(SOURCE_FLOOR.minDurationSec)).toBe(false);
    expect(isBelowSourceFloor(0)).toBe(false);
    expect(isBelowSourceFloor(undefined)).toBe(false);
    expect(isBelowSourceFloor(null)).toBe(false);
    expect(isBelowSourceFloor(-5)).toBe(false);
  });

  it("notices a short source only inside [floor, notice)", () => {
    expect(isShortSource(SOURCE_FLOOR.minDurationSec)).toBe(true);
    expect(isShortSource(SOURCE_FLOOR.shortNoticeSec - 1)).toBe(true);
    expect(isShortSource(SOURCE_FLOOR.shortNoticeSec)).toBe(false);
    // Under the floor is a refusal, not a notice - the two must not overlap.
    expect(isShortSource(SOURCE_FLOOR.minDurationSec - 1)).toBe(false);
    expect(isShortSource(0)).toBe(false);
    expect(isShortSource(undefined)).toBe(false);
  });

  it("keeps the measured numbers", () => {
    expect(SOURCE_FLOOR.minDurationSec).toBe(60);
    expect(SOURCE_FLOOR.shortNoticeSec).toBe(300);
  });
});
