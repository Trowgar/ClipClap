import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The top of the funnel was invisible.
 *
 * We could see that 95 people finished creating an account and that 3 of them
 * ever ran a job, but the bot showed its two-button first screen and returned
 * without writing anything, so the number of people who opened the bot and
 * left was simply not recorded anywhere. This service is the smallest thing
 * that answers "how many reached the first screen, and how many went past it".
 *
 * Two properties matter and are both tested here:
 *  - it counts PEOPLE, not presses (one row per telegramId per event), so
 *    count(*) is the answer and the table stays the size of the audience;
 *  - it never throws. Telemetry that can break a stranger's first interaction
 *    with the product is worse than no telemetry, so the swallow lives inside
 *    the service where no caller can forget it.
 */

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { botFunnelEvent: { upsert: mocks.upsert } },
}));

import { BOT_FUNNEL_EVENTS, recordBotFunnelEvent } from "../bot-funnel.service";

describe("recordBotFunnelEvent", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  it("records the first screen against the telegram id and locale", async () => {
    await recordBotFunnelEvent(BOT_FUNNEL_EVENTS.FIRST_SCREEN, "42", "ru");

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      telegramId_event: { telegramId: "42", event: "start_first_screen" },
    });
    expect(arg.create).toMatchObject({
      telegramId: "42",
      event: "start_first_screen",
      locale: "ru",
    });
  });

  it("counts a repeat press on the existing row instead of adding another", async () => {
    await recordBotFunnelEvent(BOT_FUNNEL_EVENTS.FIRST_SCREEN, "42", "ru");
    const arg = mocks.upsert.mock.calls[0][0];
    // The owner's question is "how many people", so a second /start from the
    // same person must not become a second row - it increments in place.
    expect(arg.update.occurrences).toEqual({ increment: 1 });
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("accepts a missing locale (Telegram does not always send one)", async () => {
    await recordBotFunnelEvent(BOT_FUNNEL_EVENTS.FIRST_SCREEN, "42");
    expect(mocks.upsert.mock.calls[0][0].create.locale).toBeNull();
  });

  it("has one event per funnel step, and they are stable strings", () => {
    expect(BOT_FUNNEL_EVENTS.FIRST_SCREEN).toBe("start_first_screen");
    expect(BOT_FUNNEL_EVENTS.NEW_ACCOUNT).toBe("first_screen_new_account");
    expect(BOT_FUNNEL_EVENTS.LINK_ACCOUNT).toBe("first_screen_link_account");
  });

  it("resolves instead of throwing when the write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockRejectedValue(new Error("db is down"));

    await expect(
      recordBotFunnelEvent(BOT_FUNNEL_EVENTS.FIRST_SCREEN, "42", "ru")
    ).resolves.toBeUndefined();

    // Silent is not acceptable either - an operator reading a suspiciously
    // flat funnel must be able to find out the writes were failing.
    expect(err).toHaveBeenCalled();
  });

  it("resolves when the client has no such model at all", async () => {
    // Guards the deploy window: worker/bot containers run a Prisma client that
    // is regenerated per container, so botFunnelEvent may be undefined on an
    // instance that has not been regenerated yet. That must not throw either.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    await expect(
      recordBotFunnelEvent(BOT_FUNNEL_EVENTS.FIRST_SCREEN, "42")
    ).resolves.toBeUndefined();
  });
});
