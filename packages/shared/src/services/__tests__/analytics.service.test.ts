import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  funnelGroupBy: vi.fn(),
  userCount: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    account: { count: mocks.count },
    funnelEvent: { groupBy: mocks.funnelGroupBy },
    user: { count: mocks.userCount },
  },
}));

import {
  excludeOwnAccountsWhere,
  getFunnel,
  isAdminEmail,
  isAdminUser,
  parseOwnAccounts,
  RETIRED_FUNNEL_EVENTS,
  SIDE_ACTION_EVENTS,
} from "../analytics.service";
import { FUNNEL_EVENTS } from "../funnel.service";

describe("isAdminEmail", () => {
  it("accepts an email on the list, case- and space-insensitively", () => {
    expect(isAdminEmail("me@example.com", " Me@Example.com , other@x.io")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isAdminEmail("stranger@x.io", "me@example.com")).toBe(false);
  });
  it("rejects everyone when the list is empty or missing", () => {
    // A misconfigured deploy must close the page, not open it to all.
    expect(isAdminEmail("me@example.com", "")).toBe(false);
    expect(isAdminEmail("me@example.com", undefined)).toBe(false);
  });
  it("rejects a missing email", () => {
    expect(isAdminEmail(undefined, "me@example.com")).toBe(false);
  });
});

describe("isAdminUser", () => {
  beforeEach(() => {
    mocks.count.mockReset();
  });

  it("passes a listed email that has a federated account", async () => {
    mocks.count.mockResolvedValue(1);
    await expect(isAdminUser("u1", "me@example.com", "me@example.com")).resolves.toBe(true);
  });

  it("counts ONLY google as proof of the address", async () => {
    // A telegram account row proves nothing about the email, and any logged-in
    // user can mint one for themselves via /api/auth/telegram/link/redeem. If
    // "telegram" ever reappears in this list, the gate collapses back to
    // "email alone": register an unclaimed ADMIN_EMAILS address at
    // /api/register, link any telegram account, and the analytics page opens.
    mocks.count.mockResolvedValue(1);
    await isAdminUser("u1", "me@example.com", "me@example.com");
    expect(mocks.count).toHaveBeenCalledWith({
      where: { userId: "u1", provider: { in: ["google"] } },
    });
  });

  it("rejects a listed email with no federated account (self-registered credentials)", async () => {
    mocks.count.mockResolvedValue(0);
    await expect(isAdminUser("u1", "me@example.com", "me@example.com")).resolves.toBe(false);
  });

  it("rejects an unlisted email without even querying the database", async () => {
    await expect(isAdminUser("u1", "stranger@x.io", "me@example.com")).resolves.toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("rejects a missing userId", async () => {
    await expect(isAdminUser(undefined, "me@example.com", "me@example.com")).resolves.toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});

describe("parseOwnAccounts", () => {
  it("splits emails from telegram ids, trimming and lowercasing emails", () => {
    expect(parseOwnAccounts(" Me@Example.com , 12345 , other@X.io ,67890")).toEqual({
      emails: ["me@example.com", "other@x.io"],
      telegramIds: ["12345", "67890"],
    });
  });

  it("tolerates an empty or undefined value", () => {
    expect(parseOwnAccounts("")).toEqual({ emails: [], telegramIds: [] });
    expect(parseOwnAccounts(undefined)).toEqual({ emails: [], telegramIds: [] });
  });

  it("drops blank entries from stray commas", () => {
    expect(parseOwnAccounts("me@example.com,,  ,12345")).toEqual({
      emails: ["me@example.com"],
      telegramIds: ["12345"],
    });
  });
});

describe("excludeOwnAccountsWhere", () => {
  it("tolerates NULL columns instead of using NOT-OR", () => {
    // Both columns are nullable. `NOT { OR: [{email in}, {telegramId in}] }`
    // looks right but SQL three-valued logic drops every row whose email is
    // NULL: measured on the real table it returned 2 of 101 users instead of
    // 98. The clause must therefore never be a bare NOT.
    const where = excludeOwnAccountsWhere({
      emails: ["me@example.com"],
      telegramIds: ["42"],
    });
    expect(JSON.stringify(where)).not.toContain("NOT");
    expect(where).toEqual({
      AND: [
        { OR: [{ email: null }, { email: { notIn: ["me@example.com"] } }] },
        { OR: [{ telegramId: null }, { telegramId: { notIn: ["42"] } }] },
      ],
    });
  });

  it("only constrains the sides that are configured", () => {
    expect(excludeOwnAccountsWhere({ emails: ["a@b.c"], telegramIds: [] })).toEqual({
      AND: [{ OR: [{ email: null }, { email: { notIn: ["a@b.c"] } }] }],
    });
  });

  it("is empty when nothing is configured, so nobody is excluded", () => {
    expect(excludeOwnAccountsWhere({ emails: [], telegramIds: [] })).toEqual({});
  });
});

/**
 * getFunnel walks a hardcoded FUNNEL_ORDER, not the table, so an event that is
 * recorded but missing from that list is written to the database and never
 * shown to anyone. That is not hypothetical: `signed_up` and `email_verified`
 * were added to FUNNEL_EVENTS and were invisible on /admin until the order was
 * updated too. This test is the thing that makes the next one a red test rather
 * than a silent hole.
 */
describe("getFunnel renders every declared step", () => {
  beforeEach(() => {
    mocks.funnelGroupBy.mockReset();
    mocks.userCount.mockReset();
    mocks.userCount.mockResolvedValue(8);
  });

  it("shows every FUNNEL_EVENTS value that has rows", async () => {
    // Two kinds of name are excluded, and both exclusions have to be declared
    // in the service rather than assumed here - otherwise this test stops being
    // the guard it exists to be and starts rubber-stamping whatever the code
    // happens to render. RETIRED are events nothing writes any more;
    // SIDE_ACTION are recorded but are not stages on the way to anything.
    const excluded = new Set<string>([
      ...RETIRED_FUNNEL_EVENTS,
      ...SIDE_ACTION_EVENTS,
    ]);
    const all = Object.values(FUNNEL_EVENTS).filter((e) => !excluded.has(e));
    mocks.funnelGroupBy.mockResolvedValue(
      all.map((event, i) => ({
        event,
        _count: { _all: 100 - i },
        _sum: { occurrences: 100 - i },
      }))
    );

    const steps = await getFunnel();

    expect(steps.map((s) => s.event).sort()).toEqual([...all].sort());
    // And every one of them carries a human label, not the wire name.
    for (const step of steps) {
      expect(step.label).not.toBe(step.event);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("skips a step nobody has reached instead of drawing a zero", async () => {
    mocks.funnelGroupBy.mockResolvedValue([
      { event: FUNNEL_EVENTS.SIGNED_UP, _count: { _all: 10 }, _sum: { occurrences: 10 } },
      { event: FUNNEL_EVENTS.APP_OPENED, _count: { _all: 8 }, _sum: { occurrences: 12 } },
    ]);

    const steps = await getFunnel();

    expect(steps.map((s) => s.event)).toEqual([
      FUNNEL_EVENTS.SIGNED_UP,
      FUNNEL_EVENTS.APP_OPENED,
    ]);
  });
});

/**
 * The shape prod actually has, and the one that broke the label.
 *
 * `signed_up` and `email_verified` only exist for accounts created after the
 * instrumentation landed; `app_opened` fires for every account there has ever
 * been. So the counts RISE across those steps, which is not a funnel failing -
 * it is two different populations - and the old Math.abs comparison handed the
 * "biggest drop" badge to the biggest RISE and drew it in red.
 */
describe("getFunnel labels drops", () => {
  beforeEach(() => {
    mocks.funnelGroupBy.mockReset();
    mocks.userCount.mockReset();
    mocks.userCount.mockResolvedValue(8);
  });

  const rows = (counts: Record<string, number>) =>
    Object.entries(counts).map(([event, n]) => ({
      event,
      _count: { _all: n },
      _sum: { occurrences: n },
    }));

  it("never calls an increase a drop", async () => {
    mocks.funnelGroupBy.mockResolvedValue(
      rows({
        [FUNNEL_EVENTS.SIGNED_UP]: 1,
        [FUNNEL_EVENTS.APP_OPENED]: 3,
        [FUNNEL_EVENTS.VIDEO_SUBMITTED]: 2,
      })
    );

    const steps = await getFunnel();
    const risen = steps.find((s) => s.event === FUNNEL_EVENTS.APP_OPENED);

    expect(risen?.people).toBe(3);
    expect(risen?.biggestDrop).toBe(false);
    // 3 -> 2 is the only real loss on the path, so it is the one that is marked.
    expect(steps.filter((s) => s.biggestDrop).map((s) => s.event)).toEqual([
      FUNNEL_EVENTS.VIDEO_SUBMITTED,
    ]);
  });

  it("marks nothing when every step gains", async () => {
    mocks.funnelGroupBy.mockResolvedValue(
      rows({
        [FUNNEL_EVENTS.SIGNED_UP]: 1,
        [FUNNEL_EVENTS.APP_OPENED]: 3,
        [FUNNEL_EVENTS.VIDEO_SUBMITTED]: 5,
      })
    );

    const steps = await getFunnel();

    expect(steps.some((s) => s.biggestDrop)).toBe(false);
  });

  it("picks the largest loss, not the largest change", async () => {
    mocks.funnelGroupBy.mockResolvedValue(
      rows({
        [FUNNEL_EVENTS.SIGNED_UP]: 10,
        [FUNNEL_EVENTS.APP_OPENED]: 100,
        [FUNNEL_EVENTS.VIDEO_SUBMITTED]: 60,
      })
    );

    const steps = await getFunnel();

    // The 10 -> 100 change is bigger in absolute terms than 100 -> 60.
    expect(steps.filter((s) => s.biggestDrop).map((s) => s.event)).toEqual([
      FUNNEL_EVENTS.VIDEO_SUBMITTED,
    ]);
  });
});

/**
 * `email_verified` is structurally unreachable for most accounts: a telegramId
 * or a Google row anchors the trial without it, and prod had 8 accounts out of
 * 105 anchors for which the wall exists at all. Read against `app_opened` it
 * looks like a 92% loss that no amount of product work could recover.
 */
describe("getFunnel scopes the email wall to the accounts it applies to", () => {
  beforeEach(() => {
    mocks.funnelGroupBy.mockReset();
    mocks.userCount.mockReset();
  });

  const prodShape = () => {
    mocks.funnelGroupBy.mockResolvedValue([
      { event: FUNNEL_EVENTS.SIGNED_UP, _count: { _all: 10 }, _sum: { occurrences: 10 } },
      { event: FUNNEL_EVENTS.APP_OPENED, _count: { _all: 100 }, _sum: { occurrences: 100 } },
      { event: FUNNEL_EVENTS.EMAIL_VERIFIED, _count: { _all: 4 }, _sum: { occurrences: 4 } },
      { event: FUNNEL_EVENTS.VIDEO_SUBMITTED, _count: { _all: 90 }, _sum: { occurrences: 90 } },
    ]);
    mocks.userCount.mockResolvedValue(8);
  };

  it("carries its own denominator and no percentage of the step above", async () => {
    prodShape();

    const steps = await getFunnel();
    const wall = steps.find((s) => s.event === FUNNEL_EVENTS.EMAIL_VERIFIED);

    expect(wall?.pctOfPrev).toBeNull();
    expect(wall?.scope).toEqual({
      applicableTo: 8,
      pctOfApplicable: 50,
      note: expect.stringContaining("confirm an email"),
    });
  });

  it("counts only accounts with neither a telegramId nor a google row", async () => {
    prodShape();

    await getFunnel();

    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { telegramId: null, accounts: { none: { provider: "google" } } },
    });
  });

  it("does not break the chain for the step after it", async () => {
    prodShape();

    const steps = await getFunnel();
    const submitted = steps.find((s) => s.event === FUNNEL_EVENTS.VIDEO_SUBMITTED);

    // 90 of the 100 who opened the app, NOT 2250% of the 4 who confirmed.
    expect(submitted?.pctOfPrev).toBe(90);
  });

  it("is never the biggest drop, however small it is", async () => {
    prodShape();

    const steps = await getFunnel();
    const wall = steps.find((s) => s.event === FUNNEL_EVENTS.EMAIL_VERIFIED);

    expect(wall?.biggestDrop).toBe(false);
  });

  it("reports no percentage rather than dividing by zero", async () => {
    prodShape();
    mocks.userCount.mockResolvedValue(0);

    const steps = await getFunnel();
    const wall = steps.find((s) => s.event === FUNNEL_EVENTS.EMAIL_VERIFIED);

    expect(wall?.scope?.pctOfApplicable).toBeNull();
  });
});
