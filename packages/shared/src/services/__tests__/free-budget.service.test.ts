import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: { freeUsage: { aggregate: vi.fn() } },
}));

import { prisma } from "../../lib/prisma";
import { freeBudgetStatus } from "../free-budget.service";

/** What the aggregate resolves to. `null` is what an empty month really gives. */
function spent(estimatedCostUsd: number | null) {
  (prisma.freeUsage.aggregate as any).mockResolvedValue({
    _sum: { estimatedCostUsd },
  });
}

/** The argument object the service handed Prisma on its only call. */
function aggregateArgs(): any {
  expect((prisma.freeUsage.aggregate as any).mock.calls).toHaveLength(1);
  return (prisma.freeUsage.aggregate as any).mock.calls[0][0];
}

describe("free-budget.service", () => {
  const original = process.env.FREE_TIER_MONTHLY_BUDGET_USD;
  const originalTz = process.env.TZ;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    // NOT a plain assignment. process.env coerces, so restoring an unset
    // variable by assigning undefined leaves the literal string "undefined"
    // behind, which vitest then carries into the next file in this worker.
    if (original === undefined) delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    else process.env.FREE_TIER_MONTHLY_BUDGET_USD = original;

    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;

    vi.useRealTimers();
  });

  it("is open while month-to-date spend is under the ceiling", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(12.5);

    expect(await freeBudgetStatus()).toEqual({
      open: true,
      spentUsd: 12.5,
      ceilingUsd: 50,
    });
  });

  it("closes once the ceiling is reached", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(50);

    const status = await freeBudgetStatus();
    expect(status.open).toBe(false);
  });

  it("stays open one cent short of the ceiling", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(49.99);

    expect((await freeBudgetStatus()).open).toBe(true);
  });

  // The rollback switch: set the ceiling to 0 and the trial is off without a
  // deploy and without touching paying users.
  it("is closed when the ceiling is zero", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "0";
    spent(0);

    expect(await freeBudgetStatus()).toEqual({
      open: false,
      spentUsd: 0,
      ceilingUsd: 0,
    });
  });

  it("is closed when the variable is missing, never open by accident", async () => {
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    spent(0);

    expect((await freeBudgetStatus()).open).toBe(false);
  });

  // Number("") is 0, not NaN - the empty case never reaches Number.isFinite,
  // so it needs its own assertion.
  it.each([
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a word", "abc"],
    ["a European decimal comma", "50,00"],
    ["a trailing unit", "50usd"],
    ["a negative ceiling", "-5"],
  ])("is closed for %s", async (_label, raw) => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = raw;
    spent(0);

    const status = await freeBudgetStatus();
    expect(status.open).toBe(false);
    // Never a negative or NaN ceiling in the object we hand callers.
    expect(status.ceilingUsd).toBe(0);
  });

  // The one input that is NOT safe by accident. Every other bad value lands on
  // NaN or a number <= 0, both of which fail `> 0` on their own; Infinity
  // passes `> 0` and is larger than any spend, so without Number.isFinite a
  // fat-fingered exponent is an unbounded free tier rather than a closed one.
  it.each([["1e999"], ["Infinity"], ["-Infinity"]])(
    "is closed for the unbounded ceiling %s",
    async (raw) => {
      process.env.FREE_TIER_MONTHLY_BUDGET_USD = raw;
      spent(1_000_000);

      const status = await freeBudgetStatus();
      expect(status.open).toBe(false);
      expect(status.ceilingUsd).toBe(0);
    }
  );

  it("tolerates a value padded with whitespace", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = " 50 ";
    spent(1);

    expect(await freeBudgetStatus()).toEqual({
      open: true,
      spentUsd: 1,
      ceilingUsd: 50,
    });
  });

  // An empty month is the common case on the 1st, and Postgres answers a sum
  // over no rows with null. It must read as "nothing spent yet", and it must
  // not escape into the returned object as a null.
  it("reads an empty ledger as zero spend, not as null", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(null);

    expect(await freeBudgetStatus()).toEqual({
      open: true,
      spentUsd: 0,
      ceilingUsd: 50,
    });
  });

  // Today the ledger cannot produce a negative sum, so `ceilingUsd > 0` looks
  // redundant next to `spentUsd < ceilingUsd`. It is not redundant against the
  // next change to the ledger: give REFUND rows a negative estimatedCostUsd as
  // a credit and a month can sum below zero, at which point `spent < 0` is true
  // and the killswitch itself fails open. Pin it.
  it("stays closed at a zero ceiling even if the month sums negative", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "0";
    spent(-10);

    expect((await freeBudgetStatus()).open).toBe(false);
  });

  it("counts only the current calendar month", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(1);

    await freeBudgetStatus();

    const where = aggregateArgs().where;
    const from: Date = where.createdAt.gte;
    const now = new Date();
    expect(from.getUTCDate()).toBe(1);
    expect(from.getUTCMonth()).toBe(now.getUTCMonth());
    expect(from.getUTCFullYear()).toBe(now.getUTCFullYear());
    // Midnight exactly, not "some time on the 1st".
    expect(from.toISOString()).toBe(
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      ).toISOString()
    );
    // A window with no upper bound. An `lte: now` would silently drop any row
    // written between the read and the comparison.
    expect(Object.keys(where.createdAt)).toEqual(["gte"]);
  });

  // The boundary is UTC, and the test host is UTC too, so a month start built
  // from local getMonth()/getFullYear() would pass every assertion above. Node
  // 20 honours a process.env.TZ change at runtime, so pin it somewhere the two
  // answers differ by a whole month: at noon UTC on 31 July it is already
  // 02:00 on 1 August in Kiritimati (UTC+14).
  it("anchors the month to UTC, not to the host timezone", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    process.env.TZ = "Pacific/Kiritimati";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));
    spent(1);

    // Guard the guard: if a future Node stops applying TZ at runtime this test
    // would quietly stop distinguishing the two implementations.
    expect(new Date().getTimezoneOffset()).toBe(-840);

    await freeBudgetStatus();

    const from: Date = aggregateArgs().where.createdAt.gte;
    expect(from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("sums charges only, so refunded runs still cost the month", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(1);

    await freeBudgetStatus();

    expect(aggregateArgs().where.kind).toBe("CHARGE");
  });

  it("is a global ceiling, never scoped to one account", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(1);

    await freeBudgetStatus();

    const where = aggregateArgs().where;
    expect(Object.keys(where).sort()).toEqual(["createdAt", "kind"]);
  });

  // Aggregating `seconds` instead of `estimatedCostUsd` is a one-word slip that
  // makes 3600 free seconds read as 3600 dollars and closes the tier on the
  // first account through the door.
  it("sums dollars, not seconds", async () => {
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    spent(1);

    await freeBudgetStatus();

    expect(aggregateArgs()._sum).toEqual({ estimatedCostUsd: true });
  });
});
