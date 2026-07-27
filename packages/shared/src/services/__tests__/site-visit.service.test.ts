import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { siteVisit: { upsert: mocks.upsert } },
}));

import {
  isBotUserAgent,
  normalizeTrackedPath,
  OTHER_PATH,
  referrerHost,
  visitorHash,
  recordSiteVisit,
} from "../site-visit.service";

describe("normalizeTrackedPath", () => {
  it("keeps the routes the site really has", () => {
    expect(normalizeTrackedPath("/")).toBe("/");
    expect(normalizeTrackedPath("/login")).toBe("/login");
    expect(normalizeTrackedPath("/dashboard")).toBe("/dashboard");
    expect(normalizeTrackedPath("/dashboard/billing")).toBe("/dashboard/billing");
  });

  it("strips ids so one path does not become one per clip", () => {
    expect(normalizeTrackedPath("/dashboard/clips/abc-123")).toBe("/dashboard/clips");
    expect(normalizeTrackedPath("/dashboard/jobs/xyz")).toBe("/dashboard/jobs");
  });

  it("buckets anything unrecognised", () => {
    // The unique key is (day, visitorHash, path) and the middleware tracks
    // every extensionless URL including 404s - so without this bucket, an
    // anonymous visitor walking /a1, /a2, /a3... mints one row per URL per day
    // with no secret and no login.
    expect(normalizeTrackedPath("/a1")).toBe(OTHER_PATH);
    expect(normalizeTrackedPath("/dashboard/not-a-page")).toBe(OTHER_PATH);
    expect(normalizeTrackedPath("/cgi-bin/ViewLog.asp")).toBe(OTHER_PATH);
  });

  it("normalises trailing slashes and query junk onto the same row", () => {
    expect(normalizeTrackedPath("/login/")).toBe("/login");
    expect(normalizeTrackedPath("/?ref=abc")).toBe("/");
    expect(normalizeTrackedPath("")).toBe("/");
  });
});

describe("isBotUserAgent", () => {
  it("flags the crawlers that actually hit this host", () => {
    // These are real user-agents seen in the server's nginx log.
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBotUserAgent("r00ts3c-owned-you")).toBe(true);
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("python-requests/2.31.0")).toBe(true);
    expect(isBotUserAgent("HeadlessChrome/135.0.0.0")).toBe(true);
  });

  it("does not flag a normal browser", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"
      )
    ).toBe(false);
  });

  it("treats a missing user-agent as a bot", () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
  });
});

describe("referrerHost", () => {
  it("keeps only the host", () => {
    expect(referrerHost("https://www.google.com/search?q=clipclap")).toBe("www.google.com");
  });
  it("returns null for our own pages, empty and malformed values", () => {
    expect(referrerHost("https://clipclap.io/login", "clipclap.io")).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
  });
  it("does not treat a suffix-matching but distinct domain as our own", () => {
    expect(referrerHost("https://notclipclap.io/x", "clipclap.io")).not.toBeNull();
  });
});

describe("visitorHash", () => {
  it("is stable for the same visitor on the same day", () => {
    const a = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    const b = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    expect(a).toBe(b);
  });

  it("differs the next day, so a visitor cannot be followed across days", () => {
    const a = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    const b = visitorHash("1.2.3.4", "UA", "secret", "2026-07-27");
    expect(a).not.toBe(b);
  });

  it("never contains the raw ip", () => {
    expect(visitorHash("1.2.3.4", "UA", "secret", "2026-07-26")).not.toContain("1.2.3.4");
  });
});

describe("recordSiteVisit", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  it("upserts one row per visitor per path per day and increments on repeat", async () => {
    await recordSiteVisit({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0 (iPhone) Safari/604.1",
      path: "/",
      referrer: "https://www.google.com/",
      secret: "secret",
      now: new Date("2026-07-26T10:00:00Z"),
    });

    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.where.day_visitorHash_path.path).toBe("/");
    expect(arg.create.isBot).toBe(false);
    expect(arg.create.referrerHost).toBe("www.google.com");
    expect(arg.update.hits).toEqual({ increment: 1 });
  });

  it("flags a crawler instead of dropping it", async () => {
    await recordSiteVisit({
      ip: "1.2.3.4",
      userAgent: "curl/8.4.0",
      path: "/",
      secret: "secret",
      now: new Date("2026-07-26T10:00:00Z"),
    });
    expect(mocks.upsert.mock.calls[0][0].create.isBot).toBe(true);
  });

  it("never throws when the write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      recordSiteVisit({ ip: "1.2.3.4", userAgent: "Safari", path: "/", secret: "s" })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
