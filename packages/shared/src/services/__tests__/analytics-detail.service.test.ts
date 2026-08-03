import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteVisitGroupBy: vi.fn(),
  siteVisitFindMany: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  funnelFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    siteVisit: { groupBy: mocks.siteVisitGroupBy, findMany: mocks.siteVisitFindMany },
    user: { count: mocks.userCount, findMany: mocks.userFindMany },
    job: { findMany: mocks.jobFindMany },
    funnelEvent: { findMany: mocks.funnelFindMany },
  },
}));

import {
  getBotUserDetails,
  getBotUsers,
  getWebGuests,
  paginate,
} from "../analytics-detail.service";

describe("paginate", () => {
  it("describes the first page", () => {
    expect(paginate(68, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 3,
      from: 1,
      to: 25,
      total: 68,
    });
  });

  it("describes a middle page", () => {
    expect(paginate(68, 2, 25)).toMatchObject({ skip: 25, from: 26, to: 50 });
  });

  it("stops `to` at the total on the last page", () => {
    expect(paginate(68, 3, 25)).toMatchObject({ skip: 50, from: 51, to: 68 });
  });

  it("clamps a page past the end to the last page", () => {
    // A stale bookmark must show the last page, not an empty table.
    expect(paginate(68, 99, 25)).toMatchObject({ page: 3, skip: 50 });
  });

  it("clamps a page below one", () => {
    expect(paginate(68, 0, 25)).toMatchObject({ page: 1, skip: 0 });
    expect(paginate(68, -5, 25)).toMatchObject({ page: 1, skip: 0 });
  });

  it("survives an empty table", () => {
    expect(paginate(0, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      total: 0,
    });
  });
});

describe("getWebGuests", () => {
  const DAY = new Date("2026-07-27T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one row per visitor-day with the recorded span", async () => {
    mocks.siteVisitGroupBy.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h1",
        _sum: { hits: 3 },
        _min: { firstSeenAt: new Date("2026-07-27T10:00:00.000Z") },
        _max: { lastSeenAt: new Date("2026-07-27T10:04:00.000Z") },
      },
    ]);
    mocks.siteVisitFindMany.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h1",
        country: "LV",
        referrerHost: "google.com",
        path: "/",
        hits: 2,
        firstSeenAt: new Date("2026-07-27T10:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T10:01:00.000Z"),
      },
      {
        day: DAY,
        visitorHash: "h1",
        country: "LV",
        referrerHost: null,
        path: "/login",
        hits: 1,
        firstSeenAt: new Date("2026-07-27T10:04:00.000Z"),
        lastSeenAt: new Date("2026-07-27T10:04:00.000Z"),
      },
    ]);

    const result = await getWebGuests(1);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      country: "LV",
      referrerHost: "google.com",
      views: 3,
      durationSec: 240,
    });
    expect(result.rows[0].paths.map((p) => p.path)).toEqual(["/", "/login"]);
    expect(result.rows[0].paths[1]).toEqual({
      path: "/login",
      hits: 1,
      firstSeenAt: new Date("2026-07-27T10:04:00.000Z"),
      lastSeenAt: new Date("2026-07-27T10:04:00.000Z"),
    });
  });

  it("orders visitor-days newest first, by day then by last activity", async () => {
    const older = new Date("2026-07-26T00:00:00.000Z");
    const group = (day: Date, hash: string, lastSeen: string) => ({
      day,
      visitorHash: hash,
      _sum: { hits: 2 },
      _min: { firstSeenAt: new Date(lastSeen) },
      _max: { lastSeenAt: new Date(lastSeen) },
    });
    // Deliberately out of order on the way in.
    mocks.siteVisitGroupBy.mockResolvedValue([
      group(older, "old", "2026-07-26T23:00:00.000Z"),
      group(DAY, "early", "2026-07-27T08:00:00.000Z"),
      group(DAY, "late", "2026-07-27T20:00:00.000Z"),
    ]);
    mocks.siteVisitFindMany.mockResolvedValue([]);

    const result = await getWebGuests(1);

    expect(result.rows.map((r) => r.visitorHash)).toEqual(["late", "early", "old"]);
  });

  it("slices the sorted groups by page", async () => {
    const groups = Array.from({ length: 5 }, (_, i) => ({
      day: new Date(`2026-07-2${i + 1}T00:00:00.000Z`),
      visitorHash: `h${i + 1}`,
      _sum: { hits: 1 },
      _min: { firstSeenAt: new Date("2026-07-27T10:00:00.000Z") },
      _max: { lastSeenAt: new Date("2026-07-27T10:00:00.000Z") },
    }));
    mocks.siteVisitGroupBy.mockResolvedValue(groups);
    mocks.siteVisitFindMany.mockResolvedValue([]);

    const result = await getWebGuests(2, 2);

    // Newest first is h5, h4, h3, h2, h1 - page 2 of size 2 is h3, h2.
    expect(result.rows.map((r) => r.visitorHash)).toEqual(["h3", "h2"]);
    expect(result.page).toMatchObject({ page: 2, from: 3, to: 4, total: 5 });
  });

  it("reports no duration for a single-pageview guest", async () => {
    // One request means one timestamp. Zero would read as "bounced instantly"
    // when the truth is that we cannot know.
    mocks.siteVisitGroupBy.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h2",
        _sum: { hits: 1 },
        _min: { firstSeenAt: new Date("2026-07-27T11:00:00.000Z") },
        _max: { lastSeenAt: new Date("2026-07-27T11:00:00.000Z") },
      },
    ]);
    mocks.siteVisitFindMany.mockResolvedValue([
      {
        day: DAY,
        visitorHash: "h2",
        country: null,
        referrerHost: null,
        path: "/",
        hits: 1,
        firstSeenAt: new Date("2026-07-27T11:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T11:00:00.000Z"),
      },
    ]);

    const result = await getWebGuests(1);

    expect(result.rows[0].durationSec).toBeNull();
    expect(result.rows[0].views).toBe(1);
  });

  it("excludes crawlers", async () => {
    mocks.siteVisitGroupBy.mockResolvedValue([]);
    mocks.siteVisitFindMany.mockResolvedValue([]);

    await getWebGuests(1);

    expect(mocks.siteVisitGroupBy.mock.calls[0][0].where).toEqual({ isBot: false });
  });

  it("skips the findMany entirely when the page is empty", async () => {
    // An empty OR list in Prisma matches EVERY row, so the guard is load-bearing.
    mocks.siteVisitGroupBy.mockResolvedValue([]);

    const result = await getWebGuests(1);

    expect(result.rows).toEqual([]);
    expect(mocks.siteVisitFindMany).not.toHaveBeenCalled();
  });
});

describe("getBotUsers", () => {
  const NOW = new Date("2026-07-28T10:00:00.000Z");

  function user(overrides: Record<string, unknown> = {}) {
    return {
      id: "u1",
      telegramId: "4242",
      email: null,
      name: "Ann",
      telegramLocale: "ru",
      plan: "NONE",
      subscriptionStatus: "NONE",
      currentPeriodEnd: null,
      referralCode: "ANN123",
      referredBy: null,
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
      _count: { jobs: 2, clips: 7 },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userCount.mockResolvedValue(1);
  });

  it("returns telegram users only, newest first", async () => {
    mocks.userFindMany.mockResolvedValue([user()]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(mocks.userFindMany.mock.calls[0][0].where).toEqual({
      telegramId: { not: null },
      isSynthetic: false,
    });
    expect(mocks.userFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(result.rows[0]).toMatchObject({
      id: "u1",
      label: "Ann",
      jobs: 2,
      clips: 7,
      isToday: false,
      isOwn: false,
    });
  });

  it("flags a registration inside the Riga day as today", async () => {
    // 2026-07-27T21:30Z is 00:30 on the 28th in Riga - today, despite the
    // UTC date reading the 27th.
    mocks.userFindMany.mockResolvedValue([
      user({ createdAt: new Date("2026-07-27T21:30:00.000Z") }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].isToday).toBe(true);
  });

  it("marks the owner's own accounts rather than hiding them", async () => {
    mocks.userFindMany.mockResolvedValue([user()]);

    const result = await getBotUsers(1, "4242,me@example.com", NOW);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].isOwn).toBe(true);
  });

  it("leaves synthetic accounts out of the table AND out of its row count", async () => {
    // The opposite treatment to isOwn above, and deliberately so. An own
    // account is a person; the list has to be complete to be useful. A
    // synthetic row is an artefact of a test run, and a table headed "users"
    // that lists it is wrong in the same way the totals above it would be.
    // find-test-debris.ts is where these become visible again.
    mocks.userFindMany.mockResolvedValue([user()]);

    await getBotUsers(1, undefined, NOW);

    // Both queries, not just the page read: a count that still included them
    // would paginate a table over rows it never shows, leaving a phantom last
    // page.
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { telegramId: { not: null }, isSynthetic: false },
    });
    expect(mocks.userFindMany.mock.calls[0][0].where).toMatchObject({
      isSynthetic: false,
    });
  });

  it("falls back to the telegram id when there is no name", async () => {
    mocks.userFindMany.mockResolvedValue([user({ name: null })]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].label).toBe("4242");
  });

  it("carries the billing and referral fields the accordion prints", async () => {
    mocks.userFindMany.mockResolvedValue([
      user({
        currentPeriodEnd: new Date("2026-08-04T09:00:00.000Z"),
        referredBy: { name: "Bob", telegramId: "9001" },
      }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0]).toMatchObject({
      currentPeriodEnd: new Date("2026-08-04T09:00:00.000Z"),
      referralCode: "ANN123",
      referredBy: "Bob",
    });
  });

  it("names an anonymous referrer by telegram id", async () => {
    mocks.userFindMany.mockResolvedValue([
      user({ referredBy: { name: null, telegramId: "9001" } }),
    ]);

    const result = await getBotUsers(1, undefined, NOW);

    expect(result.rows[0].referredBy).toBe("9001");
  });

  it("asks prisma for the requested page", async () => {
    mocks.userCount.mockResolvedValue(68);
    mocks.userFindMany.mockResolvedValue([]);

    const result = await getBotUsers(2, undefined, NOW);

    expect(mocks.userFindMany.mock.calls[0][0].skip).toBe(25);
    expect(mocks.userFindMany.mock.calls[0][0].take).toBe(25);
    expect(result.page).toMatchObject({ page: 2, from: 26, to: 50, total: 68 });
  });
});

describe("getBotUserDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys jobs and funnel events by user", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "j1",
        userId: "u1",
        createdAt: new Date("2026-07-21T09:00:00.000Z"),
        status: "DONE",
        sourceUrl: "https://youtu.be/x",
        originalFilename: null,
        sourceDurationSec: 600,
        clipsGenerated: 5,
        analyzeEngine: "RECALL_CRITIC",
        error: null,
        processingMs: 120000,
        estimatedTotalCostUsd: 0.42,
        steps: [
          { step: "DOWNLOAD", status: "DONE", error: null, startedAt: new Date("2026-07-21T09:00:00.000Z"), finishedAt: new Date("2026-07-21T09:00:30.000Z") },
          { step: "TRANSCRIBE", status: "DONE", error: null, startedAt: new Date("2026-07-21T09:00:30.000Z"), finishedAt: new Date("2026-07-21T09:02:00.000Z") },
          { step: "RENDER", status: "FAILED", error: "ffmpeg exited 1", startedAt: new Date("2026-07-21T09:02:00.000Z"), finishedAt: null },
        ],
        telegramDelivery: { status: "DELIVERED", error: null },
      },
    ]);
    mocks.funnelFindMany.mockResolvedValue([
      {
        subjectId: "4242",
        event: "app_opened",
        occurrences: 3,
        firstSeenAt: new Date("2026-07-20T09:00:00.000Z"),
        lastSeenAt: new Date("2026-07-27T09:00:00.000Z"),
      },
    ]);

    const details = await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(details.u1.jobs).toHaveLength(1);
    expect(details.u1.jobs[0]).toMatchObject({ id: "j1", clipsGenerated: 5 });
    expect(details.u1.jobs[0].steps.map((s) => s.step)).toEqual([
      "DOWNLOAD",
      "TRANSCRIBE",
      "RENDER",
    ]);
    // startedAt without finishedAt means still running or dead - no duration to
    // report, and 0 would be a lie.
    expect(details.u1.jobs[0].steps[2]).toMatchObject({
      status: "FAILED",
      error: "ffmpeg exited 1",
      ms: null,
    });
    expect(details.u1.jobs[0].steps[1].ms).toBe(90_000);
    expect(details.u1.events).toHaveLength(1);
    expect(details.u1.events[0]).toMatchObject({ event: "app_opened", occurrences: 3 });
  });

  it("asks prisma for steps in pipeline order", async () => {
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.funnelFindMany.mockResolvedValue([]);

    await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(mocks.jobFindMany.mock.calls[0][0].select.steps.orderBy).toEqual({
      createdAt: "asc",
    });
  });

  it("returns an empty shape for a user with no history", async () => {
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.funnelFindMany.mockResolvedValue([]);

    const details = await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(details.u1).toEqual({ jobs: [], events: [] });
  });

  it("queries nothing at all for an empty page", async () => {
    const details = await getBotUserDetails([]);

    expect(details).toEqual({});
    expect(mocks.jobFindMany).not.toHaveBeenCalled();
    expect(mocks.funnelFindMany).not.toHaveBeenCalled();
  });

  it("looks funnel events up by telegram id on the bot surface", async () => {
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.funnelFindMany.mockResolvedValue([]);

    await getBotUserDetails([{ id: "u1", telegramId: "4242" }]);

    expect(mocks.funnelFindMany.mock.calls[0][0].where).toEqual({
      surface: "bot",
      subjectId: { in: ["4242"] },
    });
  });
});
