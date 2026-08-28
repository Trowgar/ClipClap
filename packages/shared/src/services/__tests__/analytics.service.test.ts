import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  funnelGroupBy: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  jobCount: vi.fn(),
  clipCount: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    account: { count: mocks.count },
    funnelEvent: { groupBy: mocks.funnelGroupBy },
    user: { count: mocks.userCount, findMany: mocks.userFindMany },
    job: { count: mocks.jobCount },
    clip: { count: mocks.clipCount },
  },
}));

import {
  excludeOwnAccountsWhere,
  excludeSyntheticWhere,
  getFunnel,
  getPulse,
  getRefusals,
  getSideActions,
  getTotals,
  isAdminEmail,
  isAdminUser,
  parseOwnAccounts,
  RETIRED_FUNNEL_EVENTS,
  SIDE_ACTION_EVENTS,
} from "../analytics.service";
import { FUNNEL_EVENTS } from "../funnel.service";

// getFunnel and getRefusals now ask which accounts are synthetic before they
// group. Default to "none", so every test that is not about that question
// behaves exactly as it did.
beforeEach(() => {
  mocks.userFindMany.mockResolvedValue([]);
});

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
      where: {
        isSynthetic: false,
        telegramId: null,
        accounts: { none: { provider: "google" } },
      },
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

/**
 * A prisma stand-in that actually APPLIES the where-clause.
 *
 * Counting mocks that return a fixed number cannot tell a right filter from a
 * wrong one - `mockResolvedValue(3)` says 3 whatever is asked - so a missing
 * `isSynthetic: false` would pass every assertion about the returned Totals
 * while /admin quietly counted proof accounts. These fixtures are filtered by
 * the clause the service builds, which makes the clause the thing under test.
 *
 * It supports exactly the operators analytics.service uses and throws on
 * anything else, so a clause this cannot model becomes a loud failure rather
 * than a silent pass.
 */
type Where = Record<string, unknown>;

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (typeof cond !== "object") return value === cond;
  const c = cond as Record<string, unknown>;
  if ("not" in c) return c.not === null ? value !== null : value !== c.not;
  if ("notIn" in c) return !(c.notIn as unknown[]).includes(value);
  if ("in" in c) return (c.in as unknown[]).includes(value);
  if ("gte" in c) return (value as Date) >= (c.gte as Date);
  throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
}

function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "AND") {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "accounts") {
      const provider = ((cond as Where).none as Where)?.provider;
      const accounts = (row.accounts as { provider: string }[]) ?? [];
      if (accounts.some((a) => a.provider === provider)) return false;
      continue;
    }
    if (!fieldMatches(row[key], cond)) return false;
  }
  return true;
}

const OLD = new Date("2026-01-01T00:00:00.000Z");
const RECENT = new Date();

/**
 * Five accounts covering every combination that matters: a plain web user, a
 * plain bot user, the owner's own bot account, a proof-script account, and one
 * that is BOTH the owner's and synthetic.
 */
const USERS = [
  {
    id: "u-web",
    email: "someone@gmail.com",
    telegramId: null,
    isSynthetic: false,
    plan: "NONE",
    subscriptionStatus: "NONE",
    createdAt: RECENT,
    accounts: [],
  },
  {
    id: "u-bot",
    email: null,
    telegramId: "111",
    isSynthetic: false,
    plan: "NONE",
    subscriptionStatus: "NONE",
    createdAt: RECENT,
    accounts: [],
  },
  {
    id: "u-own",
    email: null,
    telegramId: "999",
    isSynthetic: false,
    plan: "PLUS",
    subscriptionStatus: "ACTIVE",
    createdAt: OLD,
    accounts: [],
  },
  {
    id: "u-synth",
    email: "column-proof@test.local",
    telegramId: null,
    isSynthetic: true,
    plan: "PLUS",
    subscriptionStatus: "ACTIVE",
    createdAt: RECENT,
    accounts: [],
  },
  {
    id: "u-own-synth",
    email: "me@example.com",
    telegramId: null,
    isSynthetic: true,
    plan: "PLUS",
    subscriptionStatus: "ACTIVE",
    createdAt: RECENT,
    accounts: [],
  },
];

/** One job and one clip each, so a leak shows up as an off-by-one per user. */
const JOBS = USERS.map((u) => ({ userId: u.id, createdAt: u.createdAt }));
const CLIPS = USERS.map((u) => ({ userId: u.id, createdAt: u.createdAt }));

const OWN = "me@example.com,999";

function ownedMatch(
  rows: { userId: string; createdAt: Date }[],
  where: Where | undefined
): number {
  const { user, ...rest } = (where ?? {}) as Where & { user?: Where };
  return rows.filter((row) => {
    if (!matches(row, rest)) return false;
    if (!user) return true;
    const owner = USERS.find((u) => u.id === row.userId);
    return owner !== undefined && matches(owner, user);
  }).length;
}

function useFakeTable() {
  mocks.userCount.mockImplementation(async ({ where }: { where?: Where }) =>
    USERS.filter((u) => matches(u, where)).length
  );
  mocks.userFindMany.mockImplementation(async ({ where }: { where?: Where }) =>
    USERS.filter((u) => matches(u, where)).map((u) => ({
      id: u.id,
      telegramId: u.telegramId,
    }))
  );
  mocks.jobCount.mockImplementation(async ({ where }: { where?: Where }) =>
    ownedMatch(JOBS, where)
  );
  mocks.clipCount.mockImplementation(async ({ where }: { where?: Where }) =>
    ownedMatch(CLIPS, where)
  );
}

describe("excludeSyntheticWhere", () => {
  it("asks for the flag directly rather than tolerating a null", () => {
    // The column is NOT NULL with a default, so there is no third state -
    // `{ not: true }` would be the null-tolerant shape excludeOwnAccountsWhere
    // needs and this one does not.
    expect(excludeSyntheticWhere()).toEqual({ isSynthetic: false });
  });

  it("is a plain key, so it merges with the other two clauses", () => {
    // The three clauses are spread into one object. If this ever grew an AND
    // or an OR at the top level it would silently overwrite, or be overwritten
    // by, excludeOwnAccountsWhere's AND.
    const merged = {
      telegramId: { not: null },
      ...excludeSyntheticWhere(),
      ...excludeOwnAccountsWhere({ emails: ["me@example.com"], telegramIds: ["999"] }),
    };
    expect(Object.keys(merged).sort()).toEqual(["AND", "isSynthetic", "telegramId"]);
  });
});

describe("getTotals excludes synthetic accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFakeTable();
  });

  it("leaves them out of the PLAIN totals, not only the external ones", async () => {
    const totals = await getTotals(undefined, OWN);

    // u-web, u-bot, u-own. The two synthetic rows are in neither figure: a
    // total that counts a proof-script signup is not inclusive, it is wrong.
    expect(totals.users).toBe(3);
    expect(totals.externalUsers).toBe(2);
  });

  it("leaves them out of paying, which is a plain total too", async () => {
    const totals = await getTotals(undefined, OWN);

    // u-own is the only real account with a plan. Both synthetic rows carry
    // PLUS/ACTIVE, which is what a billing proof script leaves behind.
    expect(totals.paying).toBe(1);
    expect(totals.externalPayingActive).toBe(0);
  });

  it("leaves their jobs and clips out of both counts", async () => {
    const totals = await getTotals(undefined, OWN);

    expect(totals.jobs).toBe(3);
    expect(totals.externalJobs).toBe(2);
    expect(totals.clips).toBe(3);
    expect(totals.externalClips).toBe(2);
  });

  it("still marks nothing and hides nothing about the owner's own accounts", async () => {
    const totals = await getTotals(undefined, OWN);

    // u-own is a real person's account that happens to be his: it stays in the
    // plain totals and drops out of the external ones. That is the existing
    // contract and this change must not have touched it.
    expect(totals.users - totals.externalUsers).toBe(1);
    expect(totals.jobs - totals.externalJobs).toBe(1);
  });

  it("removes an own-AND-synthetic account exactly once", async () => {
    const totals = await getTotals(undefined, OWN);

    // u-own-synth qualifies for both exclusions. Filters are not subtractions,
    // so it must not be taken out twice: `users - externalUsers` has to keep
    // meaning "the owner's own real accounts" and stay at 1, not fall to 0 or
    // go negative.
    expect(totals.users - totals.externalUsers).toBe(1);
    expect(totals.externalUsers).toBeLessThanOrEqual(totals.users);
  });

  it("applies the same exclusion under a surface filter", async () => {
    const bot = await getTotals("bot", OWN);

    // Only the two telegram accounts are real; neither synthetic row has a
    // telegramId, so the surface clause and the synthetic clause both hold.
    expect(bot.users).toBe(2);
    expect(bot.externalUsers).toBe(1);
  });
});

describe("getPulse excludes synthetic accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFakeTable();
  });

  it("keeps them out of every window", async () => {
    const pulse = await getPulse(undefined, OWN);

    // u-web and u-bot were created just now; u-own is from January. The two
    // synthetic rows are also "just now" - the shape a test run leaves - and
    // must not appear in the number the owner reads first each morning.
    for (const window of [pulse.today, pulse.last7, pulse.last30]) {
      expect(window.newUsers).toBe(2);
      expect(window.jobs).toBe(2);
      expect(window.clips).toBe(2);
    }
  });
});

describe("getFunnel and getRefusals exclude synthetic subjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.funnelGroupBy.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(8);
  });

  it("filters by subject id in both namespaces at once", async () => {
    // web rows are keyed by User.id, bot rows by User.telegramId, and a
    // synthetic account can have either. Both go into one notIn.
    mocks.userFindMany.mockResolvedValue([
      { id: "u-synth", telegramId: null },
      { id: "u-synth-bot", telegramId: "424242" },
    ]);

    await getFunnel();

    expect(mocks.funnelGroupBy.mock.calls[0][0].where).toEqual({
      subjectId: { notIn: ["u-synth", "u-synth-bot", "424242"] },
    });
  });

  it("asks the users table which ids are synthetic", async () => {
    mocks.userFindMany.mockResolvedValue([]);

    await getFunnel();

    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { isSynthetic: true },
      select: { id: true, telegramId: true },
    });
  });

  it("sends no filter at all when nothing is synthetic", async () => {
    mocks.userFindMany.mockResolvedValue([]);

    await getFunnel("bot");

    // An empty notIn is a filter nobody needs, and Prisma treats `notIn: []`
    // as "match everything" only by accident of SQL - better not to send it.
    expect(mocks.funnelGroupBy.mock.calls[0][0].where).toEqual({ surface: "bot" });
  });

  it("excludes them from the refusal breakdown too", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "u-synth", telegramId: null }]);

    await getRefusals("web");

    expect(mocks.funnelGroupBy.mock.calls[0][0].where).toEqual({
      surface: "web",
      subjectId: { notIn: ["u-synth"] },
      event: { startsWith: "upload_rejected_" },
    });
  });
});

/**
 * The shape prod had on 2026-08-24, and the two ways it lied.
 *
 * `first_screen_link_account` sat at position two of the main path with 7
 * people against 66 - it was the "biggest drop" every day by construction, and
 * it handed `signed_up` a denominator of 7, so 68 accounts rendered as "971% of
 * previous". A branch belongs off the path, and this is the test that says so
 * in numbers rather than in a comment.
 */
describe("getFunnel keeps side actions off the main path", () => {
  beforeEach(() => {
    mocks.funnelGroupBy.mockReset();
    mocks.userCount.mockReset();
    mocks.userCount.mockResolvedValue(8);
    mocks.funnelGroupBy.mockResolvedValue([
      { event: FUNNEL_EVENTS.FIRST_SCREEN, _count: { _all: 66 }, _sum: { occurrences: 75 } },
      { event: FUNNEL_EVENTS.LINK_ACCOUNT, _count: { _all: 7 }, _sum: { occurrences: 8 } },
      { event: FUNNEL_EVENTS.SIGNED_UP, _count: { _all: 68 }, _sum: { occurrences: 68 } },
      { event: FUNNEL_EVENTS.APP_OPENED, _count: { _all: 51 }, _sum: { occurrences: 575 } },
    ]);
  });

  it("does not draw a side action as a step", async () => {
    const steps = await getFunnel();

    expect(steps.map((s) => s.event)).not.toContain(FUNNEL_EVENTS.LINK_ACCOUNT);
  });

  it("measures the next step against the last one everybody passed", async () => {
    const steps = await getFunnel();
    const signedUp = steps.find((s) => s.event === FUNNEL_EVENTS.SIGNED_UP);

    // 68 of the 66 who saw the welcome screen, not 68 of the 7 who asked for a
    // link code. The figure is over 100% because the two populations differ -
    // that is a fact about instrumentation dates, not a denominator bug.
    expect(signedUp?.pctOfPrev).toBe(103);
  });

  it("cannot hand the biggest-drop badge to a branch", async () => {
    const steps = await getFunnel();

    // 66 -> 68 -> 51: the only loss on the path is app_opened.
    expect(steps.filter((s) => s.biggestDrop).map((s) => s.event)).toEqual([
      FUNNEL_EVENTS.APP_OPENED,
    ]);
  });
});

/**
 * The same guard the funnel has, for the list next to it. An event moved out of
 * FUNNEL_ORDER is only "reclassified" if something still renders it; without
 * this, moving a name into SIDE_ACTION_EVENTS would be indistinguishable from
 * deleting it from the page - which is what had already happened to the three
 * checkout events, written on 2026-08-23 and shown nowhere.
 */
describe("getSideActions renders every declared side action", () => {
  beforeEach(() => {
    mocks.funnelGroupBy.mockReset();
  });

  it("shows every SIDE_ACTION_EVENTS value that has rows, with a label", async () => {
    mocks.funnelGroupBy.mockResolvedValue(
      SIDE_ACTION_EVENTS.map((event, i) => ({
        event,
        _count: { _all: 10 - i },
        _sum: { occurrences: 10 - i },
      }))
    );

    const actions = await getSideActions();

    expect(actions.map((a) => a.event)).toEqual([...SIDE_ACTION_EVENTS]);
    for (const action of actions) {
      expect(action.label).not.toBe(action.event);
      expect(action.label.length).toBeGreaterThan(0);
    }
  });

  it("asks only for side actions, and skips the ones nobody did", async () => {
    mocks.funnelGroupBy.mockResolvedValue([
      { event: FUNNEL_EVENTS.LINK_ACCOUNT, _count: { _all: 7 }, _sum: { occurrences: 8 } },
    ]);

    const actions = await getSideActions("bot");

    expect(actions).toEqual([
      {
        event: FUNNEL_EVENTS.LINK_ACCOUNT,
        label: "Started an account link",
        people: 7,
        repeats: 1,
      },
    ]);
    expect(mocks.funnelGroupBy.mock.calls[0][0].where).toEqual({
      event: { in: [...SIDE_ACTION_EVENTS] },
      surface: "bot",
    });
  });
});
