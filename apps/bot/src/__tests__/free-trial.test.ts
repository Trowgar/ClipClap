import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two things are under test here, and they are the same product decision seen
 * from two sides.
 *
 * 1. The ONBOARDING COPY. The first screen used to open with "1. Pick a plan",
 *    which asked for money before the user had any evidence the thing works.
 *    Nobody outside the owner has ever seen this product's output, so the copy
 *    now leads with the action that produces evidence: send a video.
 *
 * 2. The BLOCK COPY. getSubmissionBlocker used to return a bare English
 *    sentence - "Active subscription required to process videos." - straight
 *    past the EN/RU dictionary, to an audience whose largest single locale is
 *    Russian. It now renders through the dict, so this suite drives the real
 *    getSubmissionBlocker against a faked prisma and asserts on what a Russian
 *    user would actually read.
 */

const mocks = vi.hoisted(() => ({
  userFindUniqueOrThrow: vi.fn(),
  jobCount: vi.fn(),
  jobAggregate: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    job: { count: mocks.jobCount, aggregate: mocks.jobAggregate },
  },
}));

import { FREE_TIER, getPlanLimits } from "@clipclap/shared";
import { getSubmissionBlocker } from "../handlers";
import { t } from "../i18n";

const FREE = getPlanLimits("NONE");

describe("free trial onboarding copy", () => {
  // The wall being removed was literally step 1. What matters is what the
  // numbered instructions tell a new user to DO first: send a video, not pay.
  it("makes sending a video the first instruction", () => {
    const step1 = { en: /^1\..*/m, ru: /^1\..*/m };
    for (const loc of ["en", "ru"] as const) {
      const first = t(loc).welcomeFirstChoice.match(step1[loc])?.[0] ?? "";
      expect(first).toMatch(loc === "en" ? /send a video/i : /пришли видео/i);
      expect(first).not.toMatch(loc === "en" ? /plan/i : /тариф/i);
    }
  });

  it("states the trial plainly on the first screen, with the real cap", () => {
    expect(t("en").welcomeFirstChoice).toMatch(/free/i);
    expect(t("en").welcomeFirstChoice).toContain(String(FREE.maxSourceDurationMinutes));
    expect(t("ru").welcomeFirstChoice).toMatch(/бесплатн/i);
    expect(t("ru").welcomeFirstChoice).toContain(String(FREE.maxSourceDurationMinutes));
  });

  it("no longer opens by asking for a plan", () => {
    expect(t("en").welcomeFirstChoice).not.toMatch(/1\.\s*Pick a plan/i);
    expect(t("ru").welcomeFirstChoice).not.toMatch(/1\.\s*Выбери тариф/i);
  });

  it("newAccountCreated points at the free run, not at the Plans button", () => {
    expect(t("en").newAccountCreated).toMatch(/free/i);
    expect(t("en").newAccountCreated).not.toMatch(/to enable processing/i);
    expect(t("ru").newAccountCreated).toMatch(/бесплатн/i);
    expect(t("ru").newAccountCreated).not.toMatch(/чтобы запустить обработку/i);
  });

  it("welcomeNeedsPlan offers the free run instead of demanding a plan first", () => {
    expect(t("en").welcomeNeedsPlan).toMatch(/free/i);
    expect(t("ru").welcomeNeedsPlan).toMatch(/бесплатн/i);
  });

  it("keeps the Russian copy in Russian", () => {
    for (const s of [
      t("ru").welcomeFirstChoice,
      t("ru").newAccountCreated,
      t("ru").welcomeNeedsPlan,
      t("ru").freeTrialUsed(1, 75, 3),
      t("ru").freeTrialAttemptsUsed(FREE_TIER.attempts, 75, 3),
      t("ru").freeSourceTooLong(FREE.maxSourceDurationMinutes, 180),
    ]) {
      expect(s).toMatch(/[а-яё]/i);
      // The old bug was an English sentence leaking into a Russian chat.
      expect(s).not.toMatch(/subscription required/i);
    }
  });

  it("the exhausted message says what was used AND what a plan gives", () => {
    for (const loc of ["en", "ru"] as const) {
      const s = t(loc).freeTrialUsed(1, 75, 3);
      // what they used
      expect(s).toMatch(loc === "en" ? /free run/i : /бесплатн/i);
      // what a plan gives: concrete minutes and price, not "upgrade"
      expect(s).toContain("75");
      expect(s).toContain("3");
    }
  });

  it("the too-long message names both the free cap and the paid cap", () => {
    for (const loc of ["en", "ru"] as const) {
      const s = t(loc).freeSourceTooLong(30, 180);
      expect(s).toContain("30");
      expect(s).toContain("180");
    }
  });
});

describe("getSubmissionBlocker on the free tier", () => {
  beforeEach(() => {
    // mockReset, not mockClear: these tests queue mockResolvedValueOnce values
    // and a blocked submission deliberately leaves some unconsumed. clearAllMocks
    // would carry that queue into the next test and quietly answer the wrong
    // question there.
    mocks.jobCount.mockReset();
    mocks.userFindUniqueOrThrow.mockReset();
    mocks.jobAggregate.mockReset();
    mocks.jobAggregate.mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
  });

  function freeUser(overrides: Record<string, unknown> = {}) {
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      ...overrides,
    });
  }

  /**
   * getFreeTrialStatus asks for [runs, attempts]; getSubmissionBlocker then
   * asks for [jobsToday, inFlight]. Queue them in that order.
   */
  function counts(runs: number, attempts: number, today = 0, inFlight = 0) {
    mocks.jobCount
      .mockResolvedValueOnce(runs)
      .mockResolvedValueOnce(attempts)
      .mockResolvedValueOnce(today)
      .mockResolvedValueOnce(inFlight);
  }

  it("lets a brand-new Russian user through with no message at all", async () => {
    freeUser();
    counts(0, 0);
    expect(await getSubmissionBlocker("u1", t("ru"), 600)).toBeNull();
  });

  it("renders the exhausted trial in Russian, not in English", async () => {
    freeUser();
    counts(FREE_TIER.runs, FREE_TIER.runs);

    const msg = await getSubmissionBlocker("u1", t("ru"), 600);

    expect(msg).not.toBeNull();
    expect(msg).toMatch(/[а-яё]/i);
    expect(msg).not.toMatch(/Active subscription required/i);
  });

  it("renders the exhausted trial in English for an English user", async () => {
    freeUser();
    counts(FREE_TIER.runs, FREE_TIER.runs);

    const msg = await getSubmissionBlocker("u1", t("en"), 600);

    expect(msg).toMatch(/free run/i);
  });

  it("refuses an over-long free source with the free cap, in the user's language", async () => {
    freeUser();
    counts(0, 0);

    const tooLong = (FREE.maxSourceDurationMinutes + 30) * 60;
    const msg = await getSubmissionBlocker("u1", t("ru"), tooLong);

    expect(msg).toContain(String(FREE.maxSourceDurationMinutes));
    expect(msg).toMatch(/[а-яё]/i);
  });

  it("explains the spent attempt backstop when nothing ever produced clips", async () => {
    freeUser();
    counts(0, FREE_TIER.attempts);

    const msg = await getSubmissionBlocker("u1", t("en"), 600);

    // This user got nothing, so the copy must not talk as if they had clips.
    expect(msg).toMatch(/none of them produced clips/i);
    expect(msg).not.toMatch(/clips from it are yours/i);
  });

  it("does not block a paying subscriber", async () => {
    freeUser({
      plan: "STARTER",
      billingCycle: "WEEKLY",
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
    });
    // No trial counters are consulted; only jobsToday and inFlight.
    mocks.jobCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    // 60 min is over the free cap and well inside STARTER's.
    expect(await getSubmissionBlocker("u1", t("en"), 3600)).toBeNull();
  });
});
