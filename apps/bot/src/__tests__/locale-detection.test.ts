import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The whole language lifecycle, driven through the real handleUpdate:
 *
 *   1. a stranger is answered in their Telegram client's language,
 *   2. a language we do not speak falls back to English rather than to nothing,
 *   3. the raw IETF tag Telegram sent is what gets stored on the account,
 *   4. an explicit choice from the settings menu overrides the client, and
 *   5. it keeps overriding it on every later message.
 *
 * Step 4 is the one worth a test: it writes to the same column the detection
 * reads, so a regression there does not throw - it just quietly answers a
 * Russian speaker in English, or reverts a choice they made on purpose.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  linkTokenCreate: vi.fn(),
  funnelUpsert: vi.fn(),
  jobCount: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
      create: mocks.userCreate,
      update: mocks.userUpdate,
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

import {
  CALLBACK_NEW_ACCOUNT,
  handleUpdate,
  langCallbackData,
} from "../handlers";
import { LOCALES, t } from "../i18n";

const CONFIG = { appUrl: "https://clipclap.io" };
const CHAT = { id: 4242, type: "private" as const };

function from(languageCode?: string) {
  return {
    id: 4242,
    is_bot: false,
    first_name: "Ann",
    ...(languageCode === undefined ? {} : { language_code: languageCode }),
  };
}

function harness() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    editMessageText: vi.fn(async () => ({})),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
}

function message(text: string, languageCode?: string) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: CHAT,
      from: from(languageCode),
      text,
    },
  };
}

function callback(data: string, languageCode?: string) {
  return {
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: from(languageCode),
      message: { message_id: 7, chat: CHAT },
      data,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPPORT_CHAT_ID;
  delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.funnelUpsert.mockResolvedValue({});
  mocks.userCreate.mockResolvedValue({ id: "u1", telegramId: "4242" });
  mocks.userUpdate.mockResolvedValue({ id: "u1" });
  mocks.accountFindUnique.mockResolvedValue(null);
  mocks.accountCreate.mockResolvedValue({});
  mocks.linkTokenCreate.mockResolvedValue({});
  mocks.userFindUniqueOrThrow.mockResolvedValue({ id: "u1", plan: "NONE" });
  mocks.jobCount.mockResolvedValue(0);
});

describe("automatic locale detection for a stranger", () => {
  it("answers a Russian client in Russian", async () => {
    const client = harness();

    await handleUpdate(client as never, message("/start", "ru") as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstChoice,
      expect.anything()
    );
  });

  // Telegram sends region tags, not bare codes, and this is the form most
  // desktop clients actually report.
  it("answers a ru-RU client in Russian", async () => {
    const client = harness();

    await handleUpdate(
      client as never,
      message("/start", "ru-RU") as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstChoice,
      expect.anything()
    );
  });

  // The three added 2026-07-27. pt-BR matters most: it is what both existing
  // Portuguese-speaking accounts actually report, and the registry stores the
  // primary subtag `pt`, so the region tag has to resolve rather than fall
  // through to English.
  it("answers Spanish, Portuguese and Indonesian clients in their own language", async () => {
    for (const [tag, locale] of [
      ["es", "es"],
      ["es-MX", "es"],
      ["pt", "pt"],
      ["pt-BR", "pt"],
      ["id", "id"],
      ["id-ID", "id"],
    ] as const) {
      const client = harness();
      await handleUpdate(client as never, message("/start", tag) as never, CONFIG);
      expect(client.sendMessage).toHaveBeenCalledWith(
        CHAT.id,
        t(locale).welcomeFirstChoice,
        expect.anything()
      );
    }
  });

  it("falls back to English for a language we do not speak", async () => {
    const client = harness();

    await handleUpdate(client as never, message("/start", "de") as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("en").welcomeFirstChoice,
      expect.anything()
    );
  });

  // Telegram omits language_code entirely for clients that never set one.
  it("falls back to English when the client reports no language at all", async () => {
    const client = harness();

    await handleUpdate(client as never, message("/start") as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("en").welcomeFirstChoice,
      expect.anything()
    );
  });
});

describe("what gets stored on the account", () => {
  it("stores the raw tag Telegram sent, not the resolved locale", async () => {
    const client = harness();

    await handleUpdate(
      client as never,
      callback(CALLBACK_NEW_ACCOUNT, "ru-RU") as never,
      CONFIG
    );

    expect(mocks.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ telegramLocale: "ru-RU" }),
      })
    );
  });

  // The consequence of storing the raw tag: an unsupported language is kept
  // verbatim, so the day that language IS added, the account picks it up
  // instead of being stuck on the English it was resolved to at signup.
  it("keeps an unsupported tag verbatim and still reads as English", async () => {
    const client = harness();

    await handleUpdate(
      client as never,
      callback(CALLBACK_NEW_ACCOUNT, "de") as never,
      CONFIG
    );
    expect(mocks.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ telegramLocale: "de" }),
      })
    );

    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "de",
      supportOpen: false,
    });
    await handleUpdate(client as never, message("hello", "de") as never, CONFIG);

    expect(client.sendMessage).toHaveBeenLastCalledWith(
      CHAT.id,
      t("en").sendVideoHint
    );
  });
});

describe("changing the language from the settings menu", () => {
  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "ru",
      supportOpen: false,
    });
    mocks.accountFindUnique.mockResolvedValue({ userId: "u1" });
  });

  it("offers the picker with a row per supported language", async () => {
    const client = harness();

    await handleUpdate(
      client as never,
      message(t("ru").settingsLangBtn, "ru") as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").langMenuPrompt,
      expect.objectContaining({
        replyMarkup: expect.objectContaining({
          inline_keyboard: LOCALES.map((loc) => [
            { text: t(loc).langBtn, callback_data: langCallbackData(loc) },
          ]),
        }),
      })
    );
  });

  it("persists the choice and confirms it in the language just picked", async () => {
    const client = harness();

    await handleUpdate(
      client as never,
      callback(langCallbackData("en"), "ru") as never,
      CONFIG
    );

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { telegramLocale: "en" },
    });
    expect(client.editMessageText).toHaveBeenCalledWith(
      CHAT.id,
      7,
      t("en").langSet
    );
  });

  it("lets the stored choice beat the client language on later messages", async () => {
    const client = harness();
    // Client still reports Russian; the account says English on purpose.
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "en",
      supportOpen: false,
    });

    await handleUpdate(client as never, message("hello", "ru") as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("en").sendVideoHint
    );
  });

  // findOrCreateTelegramUser writes telegramLocale only on create. If it ever
  // starts refreshing it from the profile, every /lang choice silently reverts
  // to the client language on the user's next message.
  it("never rewrites the stored locale from the client on an existing account", async () => {
    const client = harness();
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "en",
      supportOpen: false,
    });

    await handleUpdate(client as never, message("hello", "ru") as never, CONFIG);

    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
