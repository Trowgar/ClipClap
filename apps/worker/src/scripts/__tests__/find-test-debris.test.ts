import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  funnelGroupBy: vi.fn(),
}));

// The whole package is mocked rather than just lib/prisma: the barrel is eager
// and importing it for real would open an R2 client and a queue connection to
// count rows that are not there.
vi.mock("@clipclap/shared", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    funnelEvent: { groupBy: mocks.funnelGroupBy },
    $disconnect: vi.fn(),
  },
  SYNTHETIC_EMAIL_DOMAINS: ["test.local", "test.com"],
}));

import {
  collectDebris,
  debrisCount,
  formatDebris,
} from "../find-test-debris";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-synth",
    email: "column-proof@test.local",
    telegramId: null,
    isSynthetic: true,
    createdAt: new Date("2026-08-03T06:00:00.000Z"),
    _count: { jobs: 1, clips: 3 },
    ...overrides,
  };
}

describe("find-test-debris", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.funnelGroupBy.mockResolvedValue([]);
  });

  it("is silent and exits zero when there is nothing left behind", async () => {
    mocks.userFindMany.mockResolvedValue([]);

    const report = await collectDebris(NOW);

    expect(debrisCount(report)).toBe(0);
    // Not a heading over a void: a clean run has nothing to print, and the
    // caller says "clean" in one line instead.
    expect(formatDebris(report)).toBe("");
  });

  it("reports a synthetic account with its age and what hangs off it", async () => {
    mocks.userFindMany.mockResolvedValue([row()]);

    const report = await collectDebris(NOW);

    expect(debrisCount(report)).toBe(1);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0]).toMatchObject({
      id: "u-synth",
      email: "column-proof@test.local",
      ageHours: 6,
      jobs: 1,
      clips: 3,
    });
    const text = formatDebris(report);
    expect(text).toContain("column-proof@test.local");
    expect(text).toContain("6h old");
    expect(text).toContain("1 job(s)");
  });

  it("separates an UNFLAGGED test-shaped account, which is still being counted", async () => {
    // The dangerous case: a row created through a surface that could not set
    // the flag - tests/api.integration.test.ts registers over HTTP - or one
    // that predates the column. Analytics has no idea it is not a person.
    mocks.userFindMany.mockResolvedValue([
      row(),
      row({ id: "u-loose", email: `stale-run@test.com`, isSynthetic: false }),
    ]);

    const report = await collectDebris(NOW);

    expect(report.flagged.map((r) => r.id)).toEqual(["u-synth"]);
    expect(report.unflagged.map((r) => r.id)).toEqual(["u-loose"]);
    expect(debrisCount(report)).toBe(2);
    expect(formatDebris(report)).toContain("STILL COUNTED IN /admin");
  });

  it("counts funnel rows in both subject-id namespaces", async () => {
    // web rows are keyed by User.id, bot rows by User.telegramId, and
    // funnel_events has no foreign key to join on.
    mocks.userFindMany.mockResolvedValue([row({ telegramId: "424242" })]);
    mocks.funnelGroupBy.mockResolvedValue([
      { subjectId: "u-synth", _count: { _all: 2 } },
      { subjectId: "424242", _count: { _all: 5 } },
    ]);

    const report = await collectDebris(NOW);

    expect(mocks.funnelGroupBy.mock.calls[0][0].where).toEqual({
      subjectId: { in: ["u-synth", "424242"] },
    });
    expect(report.flagged[0].funnelEvents).toBe(7);
  });

  it("looks for both the flag and the historical test domains", async () => {
    mocks.userFindMany.mockResolvedValue([]);

    await collectDebris(NOW);

    expect(mocks.userFindMany.mock.calls[0][0].where).toEqual({
      OR: [
        { isSynthetic: true },
        // endsWith and not contains: `evil@notreally-test.local.com` is not a
        // fixture, and a substring match would call it one.
        { email: { endsWith: "@test.local" } },
        { email: { endsWith: "@test.com" } },
      ],
    });
  });

  it("prints days once an account is old enough for hours to stop meaning anything", async () => {
    mocks.userFindMany.mockResolvedValue([
      row({ createdAt: new Date("2026-07-27T12:00:00.000Z") }),
    ]);

    const report = await collectDebris(NOW);

    expect(formatDebris(report)).toContain("7d old");
  });
});
