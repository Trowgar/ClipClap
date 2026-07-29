import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  userFindUnique: vi.fn(),
  jobCount: vi.fn(),
  jobAggregate: vi.fn(),
  freeUsageGroupBy: vi.fn(),
  freeUsageAggregate: vi.fn(),
  accountCount: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
      // The gate reads the anchor through findUnique.
      findUnique: mocks.userFindUnique,
    },
    job: { count: mocks.jobCount, aggregate: mocks.jobAggregate },
    // The free allowance is the free_usage ledger now, not a count of jobs:
    // groupBy is this account's balance, aggregate is the month's global spend
    // against the budget ceiling.
    freeUsage: {
      groupBy: mocks.freeUsageGroupBy,
      aggregate: mocks.freeUsageAggregate,
    },
    account: { count: mocks.accountCount },
  },
}));

import { FREE_TIER, getPlanLimits } from "@clipclap/shared";
import { getSubmissionBlocker } from "../handlers";
import { LOCALES, t } from "../i18n";

const FREE = getPlanLimits("NONE");
const LIFETIME_MINUTES = FREE_TIER.lifetimeSeconds / 60;

/** The free trial is switched off by zeroing NONE_LIMITS (see the comment above
 *  NONE_LIMITS in packages/shared/src/config/plans.ts). Tests that assert what a
 *  user sees while the trial is RUNNING cannot pass while it is off - every cap
 *  is 0, so the source-too-long refusal fires before any trial logic is reached.
 *  Gating them on the config rather than deleting them means they come back on
 *  their own the moment NONE_LIMITS is un-zeroed, which is exactly when their
 *  protection is wanted. The disabled state has its own always-on test below. */
const TRIAL_ENABLED = FREE.maxJobsPerDay > 0;

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
      t("ru").freeExhausted(0, LIFETIME_MINUTES, 75, 3),
      t("ru").freeNotAnchored(75, 3),
      t("ru").freeBudgetClosed(75, 3),
      t("ru").freeSourceTooLong(FREE.maxSourceDurationMinutes, 180),
    ]) {
      expect(s).toMatch(/[а-яё]/i);
      // The old bug was an English sentence leaking into a Russian chat.
      expect(s).not.toMatch(/subscription required/i);
    }
  });

  it("the exhausted message says what is LEFT and what a plan gives", () => {
    for (const loc of ["en", "ru"] as const) {
      const s = t(loc).freeExhausted(0, LIFETIME_MINUTES, 75, 3);
      // what they have left, out of what
      expect(s).toMatch(loc === "en" ? /free minutes/i : /бесплатн/i);
      expect(s).toContain(String(LIFETIME_MINUTES));
      // what a plan gives: concrete minutes and price, not "upgrade"
      expect(s).toContain("75");
      expect(s).toContain("3");
    }
  });

  /**
   * The gate grew two refusals that did not exist before - an account with no
   * anchor, and the month's global budget being spent - and the bot has to be
   * able to say both in every language it claims to speak. The Dict type makes
   * a MISSING translation a compile error; this makes an empty or
   * number-dropping one a test failure, in all six locales rather than the two
   * anyone reads by hand.
   */
  it("words all three free refusals in every locale, with the plan numbers", () => {
    for (const loc of LOCALES) {
      const messages = [
        t(loc).freeExhausted(0, LIFETIME_MINUTES, 75, 3),
        t(loc).freeNotAnchored(75, 3),
        t(loc).freeBudgetClosed(75, 3),
      ];
      for (const s of messages) {
        expect(s.length).toBeGreaterThan(40);
        // A refusal the user cannot act on is only a wall: every one of them
        // names the way out and what it costs.
        expect(s).toContain("75");
        expect(s).toContain("3");
      }
    }
  });

  /**
   * The budget refusal is the one the product is actually sitting on right
   * now, and it is not the user's fault. Copy that reads as "your allowance is
   * gone" would send someone to support over an account that is perfectly
   * fine, so every locale has to place the limit on our side.
   */
  it("blames the paused budget on us, not on the user's account", () => {
    expect(t("en").freeBudgetClosed(75, 3)).toMatch(/my side|not on your account/i);
    expect(t("ru").freeBudgetClosed(75, 3)).toMatch(/с моей стороны/i);
    for (const loc of LOCALES) {
      // and none of them may claim the user's own minutes are spent
      expect(t(loc).freeBudgetClosed(75, 3)).not.toBe(
        t(loc).freeExhausted(0, LIFETIME_MINUTES, 75, 3)
      );
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
  const ORIGINAL_BUDGET = process.env.FREE_TIER_MONTHLY_BUDGET_USD;

  beforeEach(() => {
    // mockReset, not mockClear: these tests queue mockResolvedValueOnce values
    // and a blocked submission deliberately leaves some unconsumed. clearAllMocks
    // would carry that queue into the next test and quietly answer the wrong
    // question there.
    mocks.jobCount.mockReset();
    mocks.userFindUniqueOrThrow.mockReset();
    mocks.userFindUnique.mockReset();
    mocks.jobAggregate.mockReset();
    mocks.freeUsageGroupBy.mockReset();
    mocks.freeUsageAggregate.mockReset();
    mocks.accountCount.mockReset();
    mocks.jobAggregate.mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    // An OPEN budget is the background for everything except the two cases
    // that are about the budget itself. Without it every refusal below would
    // arrive as FREE_BUDGET_CLOSED and would prove nothing about the check it
    // means to be testing.
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    mocks.freeUsageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: 1 },
    });
    ledgerCharged(0);
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    } else {
      process.env.FREE_TIER_MONTHLY_BUDGET_USD = ORIGINAL_BUDGET;
    }
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
    // Anchored by the phone-backed Telegram id, which is how EVERY account
    // that reaches this function is anchored - a bot-only account has both
    // email columns NULL and never touches the email half of the check.
    mocks.userFindUnique.mockResolvedValue({
      telegramId: "4242",
      emailVerified: null,
      email: null,
      emailCanonical: null,
    });
  }

  /** The account's ledger balance, shaped the way Postgres returns it: a kind
   *  with no rows is OMITTED from the group-by, never returned as a zero. */
  function ledgerCharged(seconds: number) {
    mocks.freeUsageGroupBy.mockResolvedValue(
      seconds > 0 ? [{ kind: "CHARGE", _sum: { seconds } }] : []
    );
  }

  /** getSubmissionBlocker asks job.count for [jobsToday, inFlight] once the
   *  gate has allowed the submission. The allowance itself no longer counts
   *  jobs at all - it reads the ledger. */
  function counts(today = 0, inFlight = 0) {
    mocks.jobCount
      .mockResolvedValueOnce(today)
      .mockResolvedValueOnce(inFlight);
  }

  it.runIf(TRIAL_ENABLED)(
    "lets a brand-new Russian user through with no message at all",
    async () => {
      freeUser();
      counts();
      expect(await getSubmissionBlocker("u1", t("ru"), 600)).toBeNull();
    }
  );

  // The mirror of the test above, for the state the product is actually in.
  // A free plan that is switched off must SHUT the gate, not leave it ajar:
  // this is the assertion that would catch a half-disabled NONE_LIMITS.
  it.runIf(!TRIAL_ENABLED)(
    "blocks a brand-new user outright while the free plan is off",
    async () => {
      freeUser();
      counts();
      expect(await getSubmissionBlocker("u1", t("ru"), 600)).not.toBeNull();
    }
  );

  /**
   * The refusal a real user hits today, and the one this rewrite exists to
   * produce: FREE_TIER_MONTHLY_BUDGET_USD is unset in production, an unset
   * ceiling reads as closed, and a submission with no known duration reaches
   * that check rather than being turned away for length.
   */
  it("renders the paused free plan in Russian, not in English", async () => {
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    freeUser();

    const msg = await getSubmissionBlocker("u1", t("ru"));

    expect(msg).not.toBeNull();
    expect(msg).toMatch(/[а-яё]/i);
    expect(msg).toMatch(/с моей стороны/i);
    // The English prose canSubmitJob writes for logs must not reach a chat.
    expect(msg).not.toMatch(/Free runs are paused/i);
    expect(msg).not.toMatch(/Active subscription required/i);
  });

  it("tells an English user the pause is ours, not their allowance", async () => {
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    freeUser();

    const msg = await getSubmissionBlocker("u1", t("en"));

    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/not on your account/i);
  });

  it.runIf(TRIAL_ENABLED)(
    "renders the spent allowance in Russian, not in English",
    async () => {
      freeUser();
      ledgerCharged(FREE_TIER.lifetimeSeconds);

      const msg = await getSubmissionBlocker("u1", t("ru"), 600);

      expect(msg).not.toBeNull();
      expect(msg).toMatch(/[а-яё]/i);
      expect(msg).not.toMatch(/Active subscription required/i);
    }
  );

  it.runIf(TRIAL_ENABLED)(
    "tells an English user how much of the allowance is left",
    async () => {
      freeUser();
      ledgerCharged(FREE_TIER.lifetimeSeconds);

      const msg = await getSubmissionBlocker("u1", t("en"), 600);

      expect(msg).toMatch(/free minutes/i);
      // 0 of 60 - the real numbers, off the ledger, not a generic wall.
      expect(msg).toContain(String(LIFETIME_MINUTES));
    }
  );

  it("refuses an over-long free source with the free cap, in the user's language", async () => {
    freeUser();

    const tooLong = (FREE.maxSourceDurationMinutes + 30) * 60;
    const msg = await getSubmissionBlocker("u1", t("ru"), tooLong);

    expect(msg).toContain(String(FREE.maxSourceDurationMinutes));
    expect(msg).toMatch(/[а-яё]/i);
  });

  it("does not block a paying subscriber", async () => {
    freeUser({
      plan: "STARTER",
      billingCycle: "WEEKLY",
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
    });
    // Only jobsToday and inFlight - the free gate is not entered at all.
    counts();

    // 60 min is over the free cap and well inside STARTER's.
    expect(await getSubmissionBlocker("u1", t("en"), 3600)).toBeNull();
    expect(mocks.freeUsageGroupBy.mock.calls).toHaveLength(0);
    expect(mocks.freeUsageAggregate.mock.calls).toHaveLength(0);
  });
});
