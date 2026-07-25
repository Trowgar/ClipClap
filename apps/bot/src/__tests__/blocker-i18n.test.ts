import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getSubmissionBlocker chooses the WORDS shown to a user who was refused.
 *
 * The free-tier half of it was localized when the free run was introduced.
 * The rest was not: a paid user over quota, a canceled subscriber, someone
 * who hit the daily cap or already has a job running all got an English
 * sentence built inline here, or the raw `reason` prose that
 * canSubmitJob composes for logs and for the web UI. Registered locales
 * include ru, ar, id, fa, uz, pt-br, uk and fr - the dictionary only speaks
 * EN and RU, but answering a Russian user in Russian is the difference
 * between a wall and an explanation.
 *
 * This suite drives the real getSubmissionBlocker against a faked prisma for
 * every remaining refusal path and asserts two things per path: the Russian
 * rendering is Russian, and the English literal that used to leak is gone.
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

import { getPlanLimits } from "@clipclap/shared";
import { getSubmissionBlocker } from "../handlers";
import { t } from "../i18n";

const STARTER_WEEKLY = getPlanLimits("STARTER", "WEEKLY");

/** Every English sentence that used to reach a chat unlocalized. None of
 *  these may appear in any rendering, in either locale - the EN copy is
 *  rewritten through the dictionary too, so even the English user stops
 *  reading strings that were written for a log line. */
const RAW_LITERALS = [
  /Source exceeds max duration/i,
  /Daily job limit reached/i,
  /active jobs \(limit/i,
  /No active subscription\. Choose a plan to get started\./i,
  /Resubscribe to create new clips/i,
  /Your subscription period has ended/i,
  /would exceed your minute limit/i,
];

const HOUR = 60 * 60 * 1000;

function paidUser(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    plan: "STARTER",
    billingCycle: "WEEKLY",
    subscriptionStatus: "ACTIVE",
    currentPeriodStart: new Date(Date.now() - 24 * HOUR),
    currentPeriodEnd: new Date(Date.now() + 24 * HOUR),
    topUpMinutesRemaining: 0,
    ...over,
  };
}

/**
 * Each case sets the world up so exactly one refusal fires, and names the
 * numbers the copy must still contain - a localized message that drops the
 * limit is a worse message than the English one it replaced.
 */
const CASES: {
  name: string;
  user: Record<string, unknown>;
  durationSec?: number;
  arrange?: () => void;
  mustContain?: string[];
}[] = [
  {
    name: "paid source too long",
    user: paidUser(),
    durationSec: (STARTER_WEEKLY.maxSourceDurationMinutes + 10) * 60,
    mustContain: [String(STARTER_WEEKLY.maxSourceDurationMinutes)],
  },
  {
    name: "lifecycle: never subscribed but plan set",
    user: paidUser({ subscriptionStatus: "NONE" }),
    durationSec: 600,
  },
  {
    name: "lifecycle: canceled",
    user: paidUser({ subscriptionStatus: "CANCELED" }),
    durationSec: 600,
  },
  {
    name: "lifecycle: canceled with grace left",
    user: paidUser({ subscriptionStatus: "CANCELED_GRACE" }),
    durationSec: 600,
  },
  {
    name: "lifecycle: period ended",
    user: paidUser({ currentPeriodEnd: new Date(Date.now() - 90 * 24 * HOUR) }),
    durationSec: 600,
  },
  {
    name: "quota exhausted",
    user: paidUser(),
    durationSec: 600,
    arrange: () => {
      // 74 of 75 minutes already spent; a 10-minute source cannot fit.
      mocks.jobAggregate.mockResolvedValue({
        _sum: { sourceDurationSec: 74 * 60 },
      });
    },
    mustContain: ["74", String(STARTER_WEEKLY.minutesPerPeriod)],
  },
  {
    name: "daily job cap",
    user: paidUser(),
    durationSec: 600,
    arrange: () => {
      mocks.jobCount.mockResolvedValueOnce(STARTER_WEEKLY.maxJobsPerDay);
    },
    mustContain: [String(STARTER_WEEKLY.maxJobsPerDay)],
  },
  {
    name: "concurrent job cap",
    user: paidUser(),
    durationSec: 600,
    arrange: () => {
      // first count() is "jobs today", second is "in flight"
      mocks.jobCount.mockResolvedValueOnce(0);
      mocks.jobCount.mockResolvedValueOnce(STARTER_WEEKLY.concurrentJobsLimit);
    },
    mustContain: [String(STARTER_WEEKLY.concurrentJobsLimit)],
  },
];

describe("getSubmissionBlocker speaks the user's language", () => {
  beforeEach(() => {
    mocks.jobCount.mockReset();
    mocks.userFindUniqueOrThrow.mockReset();
    mocks.jobAggregate.mockReset();
    mocks.jobCount.mockResolvedValue(0);
    mocks.jobAggregate.mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
  });

  for (const c of CASES) {
    it(`${c.name}: renders Russian for a Russian user`, async () => {
      mocks.userFindUniqueOrThrow.mockResolvedValue(c.user);
      c.arrange?.();
      const msg = await getSubmissionBlocker("u1", t("ru"), c.durationSec);
      expect(msg, "this path must refuse").toBeTruthy();
      expect(msg).toMatch(/[а-яё]/i);
      for (const lit of RAW_LITERALS) expect(msg).not.toMatch(lit);
    });

    it(`${c.name}: renders English for an English user`, async () => {
      mocks.userFindUniqueOrThrow.mockResolvedValue(c.user);
      c.arrange?.();
      const msg = await getSubmissionBlocker("u1", t("en"), c.durationSec);
      expect(msg, "this path must refuse").toBeTruthy();
      // English copy must not be Russian, and must not be the old log prose.
      expect(msg).not.toMatch(/[а-яё]/i);
      for (const lit of RAW_LITERALS) expect(msg).not.toMatch(lit);
    });

    it(`${c.name}: the two locales are different text`, async () => {
      mocks.userFindUniqueOrThrow.mockResolvedValue(c.user);
      c.arrange?.();
      const ru = await getSubmissionBlocker("u1", t("ru"), c.durationSec);
      mocks.jobCount.mockReset();
      mocks.jobCount.mockResolvedValue(0);
      c.arrange?.();
      const en = await getSubmissionBlocker("u1", t("en"), c.durationSec);
      expect(ru).not.toBe(en);
    });

    if (c.mustContain?.length) {
      it(`${c.name}: keeps the numbers in both locales`, async () => {
        for (const loc of ["en", "ru"] as const) {
          mocks.jobCount.mockReset();
          mocks.jobCount.mockResolvedValue(0);
          mocks.userFindUniqueOrThrow.mockResolvedValue(c.user);
          c.arrange?.();
          const msg = await getSubmissionBlocker("u1", t(loc), c.durationSec);
          for (const n of c.mustContain!) expect(msg).toContain(n);
        }
      });
    }
  }
});
