import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const findManyMock = vi.hoisted(() => vi.fn());
const redisGetMock = vi.hoisted(() => vi.fn());
const redisSetMock = vi.hoisted(() => vi.fn());
const sendTelegramMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/prisma", () => ({
  prisma: { job: { findMany: findManyMock } },
}));
vi.mock("../../lib/redis", () => ({
  getRedis: () => ({ get: redisGetMock, set: redisSetMock }),
}));
vi.mock("../telegram-notification.service", () => ({
  sendTelegramMessage: sendTelegramMessageMock,
}));

import {
  runDownloadWatchdog,
  watchdogWindowCutoff,
  WATCHDOG_WINDOW_HOURS,
  WATCHDOG_SUPPRESS_HOURS,
  DOWNLOAD_WATCHDOG_SUPPRESS_KEY,
} from "../download-watchdog.service";

const NOW = new Date("2026-08-19T12:00:00.000Z");

// The container loads the real .env, which sets SUPPORT_CHAT_ID to a live
// value - every test below controls that variable explicitly, and this pair
// guarantees the production value is never leaked into, or out of, a test.
const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPPORT_CHAT_ID;
  redisGetMock.mockResolvedValue(null);
  redisSetMock.mockResolvedValue("OK");
  sendTelegramMessageMock.mockResolvedValue(true);
  findManyMock.mockResolvedValue([]);
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function job(status: string, error: string | null = null) {
  return { status, error };
}

describe("download watchdog: the window", () => {
  it("looks back 24 hours", () => {
    expect(WATCHDOG_WINDOW_HOURS).toBe(24);
    expect(watchdogWindowCutoff(NOW).toISOString()).toBe(
      "2026-08-18T12:00:00.000Z"
    );
  });
});

describe("download watchdog: query shape", () => {
  // Mocked prisma returns whatever it is told regardless of the where clause,
  // so the shape has to be asserted directly - a where that forgot
  // `sourceUrl: { not: null }` would silently watch uploads instead of links
  // and this watchdog would never fire on the outage it exists to catch.
  it("asks only for link jobs (sourceUrl not null) created in the window", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    await runDownloadWatchdog(NOW);

    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        sourceUrl: { not: null },
        createdAt: { gte: watchdogWindowCutoff(NOW) },
      },
      select: { status: true, error: true },
    });
  });
});

describe("download watchdog: alert condition", () => {
  it("alerts when link submissions exist and none completed", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([
      job("FAILED", "[SOURCE_UNAVAILABLE] yt-dlp: HTTP Error 403: Forbidden"),
      job("FAILED", "[SOURCE_UNAVAILABLE] yt-dlp: HTTP Error 403: Forbidden"),
      job("DOWNLOADING"),
    ]);

    const result = await runDownloadWatchdog(NOW);

    expect(result).toEqual({
      submitted: 3,
      done: 0,
      failed: 2,
      alerted: true,
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  // The condition is done === 0, not "every submission failed" - a job still
  // mid-pipeline must not buy silence, and one completion is what proves the
  // path still works.
  it("stays silent when at least one submission completed", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([job("FAILED", "boom"), job("DONE")]);

    const result = await runDownloadWatchdog(NOW);

    expect(result.alerted).toBe(false);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  // A quiet day with zero link submissions must read as silence, not as an
  // outage - otherwise the watchdog pages the owner every night nothing was
  // submitted at all.
  it("stays silent when nothing was submitted at all", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([]);

    const result = await runDownloadWatchdog(NOW);

    expect(result).toEqual({ submitted: 0, done: 0, failed: 0, alerted: false });
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });
});

describe("download watchdog: SUPPORT_CHAT_ID", () => {
  it("does nothing when unset - no send, no throw, no redis write", async () => {
    delete process.env.SUPPORT_CHAT_ID;
    findManyMock.mockResolvedValue([job("FAILED", "boom")]);

    const result = await runDownloadWatchdog(NOW);

    expect(result.alerted).toBe(false);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });
});

describe("download watchdog: the 6h suppression window", () => {
  it("does not send a second alert while the window is open", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([job("FAILED", "boom")]);

    await runDownloadWatchdog(NOW);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);

    // Simulate the key this run just set being read back by the next hourly
    // tick, one hour later - still inside the 6h window.
    redisGetMock.mockResolvedValue(NOW.toISOString());
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const secondResult = await runDownloadWatchdog(later);

    expect(secondResult.alerted).toBe(false);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("sets the suppress key with a 6h TTL only after a successful send", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([job("FAILED", "boom")]);

    await runDownloadWatchdog(NOW);

    expect(redisSetMock).toHaveBeenCalledWith(
      DOWNLOAD_WATCHDOG_SUPPRESS_KEY,
      expect.any(String),
      "EX",
      WATCHDOG_SUPPRESS_HOURS * 60 * 60
    );
  });

  it("does not set the suppress key when the send itself fails", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([job("FAILED", "boom")]);
    sendTelegramMessageMock.mockResolvedValue(false);

    const result = await runDownloadWatchdog(NOW);

    expect(result.alerted).toBe(false);
    expect(redisSetMock).not.toHaveBeenCalled();
  });
});

describe("download watchdog: message content", () => {
  it("names the counts and a truncated common error, not a vague line", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    const longError = "[SOURCE_UNAVAILABLE] " + "x".repeat(500);
    findManyMock.mockResolvedValue([
      job("FAILED", longError),
      job("FAILED", longError),
      job("PENDING"),
    ]);

    await runDownloadWatchdog(NOW);

    const text = String(sendTelegramMessageMock.mock.calls[0][1]);
    expect(text).toContain("3");
    expect(text).toContain("2");
    expect(text).toContain(longError.slice(0, 200));
    // Truncated to ~200 chars, not the full multi-kilobyte yt-dlp dump.
    expect(text.length).toBeLessThan(longError.length);
    expect(text).not.toContain(longError);
  });

  it("picks the most frequent error, not merely the first one seen", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    findManyMock.mockResolvedValue([
      job("FAILED", "rare one-off error"),
      job("FAILED", "common recurring error"),
      job("FAILED", "common recurring error"),
    ]);

    await runDownloadWatchdog(NOW);

    const text = String(sendTelegramMessageMock.mock.calls[0][1]);
    expect(text).toContain("common recurring error");
    expect(text).not.toContain("rare one-off error");
  });

  it("sends the alert to SUPPORT_CHAT_ID", async () => {
    process.env.SUPPORT_CHAT_ID = "  555  ";
    findManyMock.mockResolvedValue([job("FAILED", "boom")]);

    await runDownloadWatchdog(NOW);

    expect(sendTelegramMessageMock.mock.calls[0][0]).toBe("555");
  });
});
