import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  jobCount: vi.fn(),
  probeVideoUrl: vi.fn(),
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
    funnelEvent: { upsert: mocks.funnelUpsert },
    job: { count: mocks.jobCount },
  },
}));

vi.mock("../url-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../url-probe")>();
  return {
    ...actual,
    probeVideoUrl: mocks.probeVideoUrl,
  };
});

import { FUNNEL_EVENTS, uploadRejectedEvent } from "@clipclap/shared";
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
    setChatMenuButton: vi.fn(async () => {
      order.push("setChatMenuButton");
      return {};
    }),
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
    (c) => c[0].where.surface_subjectId_event.event
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
    mocks.jobCount.mockResolvedValue(0);
    mocks.probeVideoUrl.mockReset();
  });

  it("records that a stranger reached the first screen", async () => {
    const { client } = harness();

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstChoice,
      expect.anything()
    );
    expect(eventsRecorded()).toEqual([FUNNEL_EVENTS.FIRST_SCREEN]);
    const arg = mocks.funnelUpsert.mock.calls[0][0];
    expect(arg.where.surface_subjectId_event.surface).toBe("bot");
    expect(arg.where.surface_subjectId_event.subjectId).toBe("4242");
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

    expect(eventsRecorded()).not.toContain(FUNNEL_EVENTS.FIRST_SCREEN);
  });

  it("records going past the screen, by which door", async () => {
    for (const [data, event] of [
      [CALLBACK_NEW_ACCOUNT, FUNNEL_EVENTS.NEW_ACCOUNT],
      [CALLBACK_LINK_ACCOUNT, FUNNEL_EVENTS.LINK_ACCOUNT],
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

describe("app-open and video-submitted telemetry", () => {
  const EXISTING_USER = {
    id: "u1",
    telegramId: "4242",
    telegramLocale: "ru",
    supportOpen: false,
    plan: "NONE",
    billingCycle: null,
    subtitlesEnabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    mocks.userFindUnique.mockResolvedValue(EXISTING_USER);
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.userCreate.mockResolvedValue(EXISTING_USER);
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.accountCreate.mockResolvedValue({});
    mocks.linkTokenCreate.mockResolvedValue({});
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
    });
    mocks.jobCount.mockResolvedValue(0);
    mocks.probeVideoUrl.mockReset();
  });

  function menuUpdate() {
    return {
      update_id: 10,
      message: { message_id: 10, chat: CHAT, from: FROM, text: "/menu" },
    };
  }

  function videoUrlUpdate(url: string) {
    return {
      update_id: 11,
      message: { message_id: 11, chat: CHAT, from: FROM, text: url },
    };
  }

  it("records app_opened when /menu shows the main menu", async () => {
    const { client } = harness();

    await handleUpdate(client as never, menuUpdate() as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeBack,
      expect.anything()
    );
    const appOpened = eventsRecorded().filter(
      (e) => e === FUNNEL_EVENTS.APP_OPENED
    );
    expect(appOpened).toHaveLength(1);
  });

  it("records app_opened exactly once (not twice) for a brand-new account", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "u1", telegramId: "4242" });
    const { client } = harness();

    await handleUpdate(
      client as never,
      {
        update_id: 12,
        callback_query: {
          id: "cb",
          from: FROM,
          data: CALLBACK_NEW_ACCOUNT,
          message: { message_id: 7, chat: CHAT },
        },
      } as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(FUNNEL_EVENTS.NEW_ACCOUNT);
    const appOpened = eventsRecorded().filter(
      (e) => e === FUNNEL_EVENTS.APP_OPENED
    );
    expect(appOpened).toHaveLength(1);
  });

  it("records video_submitted for a URL whose probe fails", async () => {
    mocks.probeVideoUrl.mockResolvedValue({ ok: false, reason: "yt-dlp-error" });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=dead-link") as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").urlAccessFailed
    );
    expect(eventsRecorded()).toContain(FUNNEL_EVENTS.VIDEO_SUBMITTED);
  });

  it("records upload_rejected_too_long for a free-tier user whose source is too long", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: true,
      durationSec: 600,
      title: "A ten-minute video",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=long-video") as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(
      uploadRejectedEvent("FREE_SOURCE_TOO_LONG")
    );
  });
});

/**
 * Who can SEE the analytics entry, which is a separate question from who can
 * read the data behind it. The data is gated by initData at /api/admin/enter;
 * the button is gated here.
 */
describe("admin analytics button visibility", () => {
  const EXISTING_USER = {
    id: "u1",
    telegramId: "4242",
    telegramLocale: "ru",
    supportOpen: false,
    plan: "NONE",
    billingCycle: null,
    subtitlesEnabled: false,
  };

  const GROUP = { id: -100500, type: "supergroup" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "4242";
    mocks.userFindUnique.mockResolvedValue(EXISTING_USER);
    mocks.funnelUpsert.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
  });

  function menuIn(chat: { id: number; type: string }) {
    return {
      update_id: 20,
      message: { message_id: 20, chat, from: FROM, text: "/menu" },
    };
  }

  function menuButtonCalls(client: {
    setChatMenuButton: { mock: { calls: unknown[][] } };
  }) {
    return client.setChatMenuButton.mock.calls as [
      number | string,
      { type: string; text?: string; web_app?: { url: string } },
    ][];
  }

  function keyboardText(client: { sendMessage: { mock: { calls: unknown[][] } } }) {
    const opts = client.sendMessage.mock.calls[0][2] as {
      replyMarkup?: { keyboard: { text: string }[][] };
    };
    return (opts.replyMarkup?.keyboard ?? []).flat().map((b) => b.text);
  }

  it("gives an admin in a private chat the Mini App on the menu button", async () => {
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    const calls = menuButtonCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(CHAT.id);
    expect(calls[0][1].type).toBe("web_app");
    expect(calls[0][1].text).toBe("Analytics");
    expect(calls[0][1].web_app?.url).toContain("/admin?v=");
  });

  it("keeps the analytics entry off the reply keyboard", async () => {
    // A reply-keyboard web_app button receives no signed launch data from
    // Telegram, so the Mini App behind it can never authenticate. The entry
    // point belongs on the menu button, and nowhere else.
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    expect(keyboardText(client)).not.toContain("Analytics");
  });

  it("sets nothing in a group even when the sender is the admin", async () => {
    // The menu button belongs to the CHAT, not the sender: setting it in a
    // group would hand every member the entry point. They could not read the
    // data - the page re-checks - but it is not theirs to see either.
    const { client } = harness();

    await handleUpdate(client as never, menuIn(GROUP) as never, CONFIG);

    expect(menuButtonCalls(client)).toHaveLength(0);
  });

  it("sets nothing for a non-admin in their own private chat", async () => {
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "999";
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    expect(menuButtonCalls(client)).toHaveLength(0);
  });
});
