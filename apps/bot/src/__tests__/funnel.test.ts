import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bot's first screen was a hole in the funnel.
 *
 * handleStart showed the two-button screen to a stranger and returned without
 * writing anything, so an account only appeared once someone pressed a button.
 * That is why we know 95 people created an account and 3 ever ran a job, but
 * cannot say how many opened the bot and walked away.
 *
 * These tests drive the real handleUpdate over a faked prisma and assert the
 * two halves of the funnel are recorded - and, more importantly, that the
 * recording is subordinate to the reply: the message goes out first, and a
 * failing write is invisible to the user.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userCreate: vi.fn(),
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  linkTokenCreate: vi.fn(),
  funnelUpsert: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
      create: mocks.userCreate,
    },
    account: {
      findUnique: mocks.accountFindUnique,
      create: mocks.accountCreate,
    },
    telegramLinkToken: { create: mocks.linkTokenCreate },
    botFunnelEvent: { upsert: mocks.funnelUpsert },
  },
}));

import { BOT_FUNNEL_EVENTS } from "@clipclap/shared";
import {
  CALLBACK_LINK_ACCOUNT,
  CALLBACK_NEW_ACCOUNT,
  handleUpdate,
} from "../handlers";
import { t } from "../i18n";

const CONFIG = { appUrl: "https://clipclap.io" };
const FROM = { id: 4242, is_bot: false, first_name: "Ann", language_code: "ru" };
const CHAT = { id: 4242, type: "private" as const };

/** Records the order of every call so "the reply came first" is testable. */
function harness() {
  const order: string[] = [];
  mocks.funnelUpsert.mockImplementation(async () => {
    order.push("telemetry");
    return {};
  });
  const client = {
    sendMessage: vi.fn(async () => {
      order.push("sendMessage");
      return { message_id: 1 };
    }),
    editMessageText: vi.fn(async () => {
      order.push("editMessageText");
      return {};
    }),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
  return { client, order };
}

function startUpdate() {
  return {
    update_id: 1,
    message: { message_id: 1, chat: CHAT, from: FROM, text: "/start" },
  };
}

function eventsRecorded() {
  return mocks.funnelUpsert.mock.calls.map(
    (c) => c[0].where.telegramId_event.event
  );
}

describe("first-screen telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.userCreate.mockResolvedValue({ id: "u1", telegramId: "4242" });
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.accountCreate.mockResolvedValue({});
    mocks.linkTokenCreate.mockResolvedValue({});
    mocks.userFindUniqueOrThrow.mockResolvedValue({ id: "u1", plan: "NONE" });
  });

  it("records that a stranger reached the first screen", async () => {
    const { client } = harness();

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstChoice,
      expect.anything()
    );
    expect(eventsRecorded()).toEqual([BOT_FUNNEL_EVENTS.FIRST_SCREEN]);
    const arg = mocks.funnelUpsert.mock.calls[0][0];
    expect(arg.where.telegramId_event.telegramId).toBe("4242");
    // The locale is worth one column: 34 of 95 users have none set and the
    // wall they hit is written in two languages only.
    expect(arg.create.locale).toBe("ru");
  });

  it("sends the reply BEFORE writing telemetry", async () => {
    const { client, order } = harness();

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(order).toEqual(["sendMessage", "telemetry"]);
  });

  it("still replies when the telemetry write rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockRejectedValue(new Error("db is down"));

    await expect(
      handleUpdate(client as never, startUpdate() as never, CONFIG)
    ).resolves.toBeUndefined();

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstChoice,
      expect.anything()
    );
    expect(err).toHaveBeenCalled();
  });

  it("still replies when the telemetry write throws synchronously", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockImplementation(() => {
      throw new TypeError("no such model");
    });

    await expect(
      handleUpdate(client as never, startUpdate() as never, CONFIG)
    ).resolves.toBeUndefined();

    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("does not record a first screen for someone who already has an account", async () => {
    const { client } = harness();
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "ru",
      supportOpen: false,
      plan: "NONE",
    });

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(eventsRecorded()).not.toContain(BOT_FUNNEL_EVENTS.FIRST_SCREEN);
  });

  it("records going past the screen, by which door", async () => {
    for (const [data, event] of [
      [CALLBACK_NEW_ACCOUNT, BOT_FUNNEL_EVENTS.NEW_ACCOUNT],
      [CALLBACK_LINK_ACCOUNT, BOT_FUNNEL_EVENTS.LINK_ACCOUNT],
    ] as const) {
      vi.clearAllMocks();
      mocks.userFindUnique.mockResolvedValue(null);
      mocks.funnelUpsert.mockResolvedValue({});
      mocks.userCreate.mockResolvedValue({ id: "u1", telegramId: "4242" });
      mocks.accountFindUnique.mockResolvedValue(null);
      mocks.accountCreate.mockResolvedValue({});
      const { client } = harness();

      await handleUpdate(
        client as never,
        {
          update_id: 2,
          callback_query: {
            id: "cb",
            from: FROM,
            data,
            message: { message_id: 7, chat: CHAT },
          },
        } as never,
        CONFIG
      );

      expect(eventsRecorded()).toContain(event);
    }
  });

  it("does not let a telemetry failure break a button press", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockRejectedValue(new Error("db is down"));

    await expect(
      handleUpdate(
        client as never,
        {
          update_id: 3,
          callback_query: {
            id: "cb",
            from: FROM,
            data: CALLBACK_NEW_ACCOUNT,
            message: { message_id: 7, chat: CHAT },
          },
        } as never,
        CONFIG
      )
    ).resolves.toBeUndefined();

    expect(client.editMessageText).toHaveBeenCalled();
  });
});
