import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteVisitGroupBy: vi.fn(),
  siteVisitFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    siteVisit: { groupBy: mocks.siteVisitGroupBy, findMany: mocks.siteVisitFindMany },
  },
}));

import { getWebGuests, paginate } from "../analytics-detail.service";

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
