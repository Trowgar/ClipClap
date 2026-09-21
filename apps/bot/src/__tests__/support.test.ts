import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  getOrCreateTelegramUser: vi.fn(),
  storeWebSupportReply: vi.fn(),
  markSupportEmailNotified: vi.fn(),
  sendSupportReplyEmail: vi.fn(),
}));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrCreateTelegramUser: mocks.getOrCreateTelegramUser,
    storeWebSupportReply: mocks.storeWebSupportReply,
    markSupportEmailNotified: mocks.markSupportEmailNotified,
    sendSupportReplyEmail: mocks.sendSupportReplyEmail,
    prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
  };
});

import {
  matchSupportAction,
  getSupportChatId,
  parseSupportReply,
  parseWebSupportReply,
  relaySupportMessage,
  deliverSupportReply,
  relaySupportMedia,
  closeSupport,
  deliverWebSupportReply,
} from "../handlers";

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  vi.resetAllMocks();
});

describe("matchSupportAction", () => {
  it("matches the close button in both locales", () => {
    expect(matchSupportAction(t("en").supportCloseBtn)).toBe("close");
    expect(matchSupportAction(t("ru").supportCloseBtn)).toBe("close");
    expect(matchSupportAction("nope")).toBeNull();
  });
});

describe("getSupportChatId", () => {
  it("prefers SUPPORT_CHAT_ID, falls back to first admin id, else null", () => {
    process.env.SUPPORT_CHAT_ID = "111";
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "222,333";
    expect(getSupportChatId()).toBe("111");
    delete process.env.SUPPORT_CHAT_ID;
    expect(getSupportChatId()).toBe("222");
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    expect(getSupportChatId()).toBeNull();
  });
});

describe("parseSupportReply", () => {
  const botReply = (text: string) => ({
    message_id: 2,
    chat: { id: 5, type: "private" },
    reply_to_message: {
      message_id: 1,
      chat: { id: 5, type: "private" },
      from: { id: 9, is_bot: true },
      text,
    },
  });

  it("extracts the leading #uid marker", () => {
    expect(parseSupportReply(botReply("🆕 #uid575308044 Ivan (@ivan)\n\nhi") as never))
      .toEqual({ uid: "575308044" });
  });

  it("ignores a #uid injected in the quoted body (anchored to header)", () => {
    expect(parseSupportReply(botReply("🆕 #uid999 Bob\n\n#uid575308044") as never))
      .toEqual({ uid: "999" });
  });

  it("returns null for non-bot replies, missing marker, or no reply", () => {
    const notBot = botReply("🆕 #uid1 x");
    notBot.reply_to_message.from.is_bot = false;
    expect(parseSupportReply(notBot as never)).toBeNull();
    expect(parseSupportReply(botReply("no marker here") as never)).toBeNull();
    expect(parseSupportReply({ message_id: 1, chat: { id: 5, type: "private" } } as never)).toBeNull();
  });
});

describe("parseWebSupportReply", () => {
  const botReply = (text: string) => ({
    message_id: 2, chat: { id: 5, type: "private" },
    reply_to_message: {
      message_id: 1, chat: { id: 5, type: "private" },
      from: { id: 9, is_bot: true }, text,
    },
  });

  it("accepts only an anchored server-generated web marker", () => {
    expect(parseWebSupportReply(botReply("🆕 #webcm123 User") as never)).toEqual({ userId: "cm123" });
    expect(parseWebSupportReply(botReply("prefix #webcm123") as never)).toBeNull();
    expect(parseWebSupportReply(botReply("🆕 #web../../etc") as never)).toBeNull();
  });
});

describe("deliverWebSupportReply", () => {
  it("stores one reply and emails only the first unread verified user", async () => {
    mocks.findUnique.mockResolvedValue({ id: "u1", email: "verified@example.test", emailVerified: new Date() });
    mocks.storeWebSupportReply.mockResolvedValue({
      message: { id: "r1" }, created: true, shouldNotify: true,
    });
    mocks.sendSupportReplyEmail.mockResolvedValue(true);
    mocks.markSupportEmailNotified.mockResolvedValue(undefined);
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverWebSupportReply(client, "u1", "We fixed it", "777", 42);
    expect(mocks.storeWebSupportReply).toHaveBeenCalledWith({
      userId: "u1", text: "We fixed it", supportChatId: "777", telegramMessageId: 42,
    });
    expect(mocks.sendSupportReplyEmail).toHaveBeenCalledWith("verified@example.test");
    expect(mocks.markSupportEmailNotified).toHaveBeenCalledWith("r1");
  });

  it("does not email duplicates, already-unread threads or unverified addresses", async () => {
    mocks.findUnique.mockResolvedValue({ id: "u1", email: "u@example.test", emailVerified: null });
    mocks.storeWebSupportReply.mockResolvedValue({
      message: { id: "r1" }, created: false, shouldNotify: false,
    });
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverWebSupportReply(client, "u1", "x", "777", 42);
    expect(mocks.sendSupportReplyEmail).not.toHaveBeenCalled();
  });

  it("warns the operator when the user is missing or the reply cannot be stored", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const client = { sendMessage } as never;
    mocks.findUnique.mockResolvedValueOnce(null);
    await deliverWebSupportReply(client, "missing", "x", "777", 42);
    expect(sendMessage).toHaveBeenCalledWith("777", expect.stringContaining("не найден"));
    mocks.findUnique.mockResolvedValueOnce({ id: "u1", email: null, emailVerified: null });
    mocks.storeWebSupportReply.mockRejectedValueOnce(new Error("db down"));
    await deliverWebSupportReply(client, "u1", "x", "777", 43);
    expect(sendMessage).toHaveBeenCalledWith("777", expect.stringContaining("не удалось сохранить"));
  });
});

describe("relaySupportMessage", () => {
  it("sends to the support chat with a #uid header and verbatim text", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await relaySupportMessage(client, { id: 42, first_name: "Ann" } as never, "help me");
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[0]).toBe("777");
    expect(call[1]).toContain("🆕 #uid42");
    expect(call[1]).toContain("help me");
  });

  it("strips a spoofed #uid from the sender name", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await relaySupportMessage(client, { id: 42, first_name: "#uid999" } as never, "x");
    const header = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0][1].split("\n")[0];
    expect(header.match(/#uid\d+/g)).toEqual(["#uid42"]);
  });

  it("no-ops when no support chat is configured", async () => {
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    const client = { sendMessage: vi.fn() } as never;
    await relaySupportMessage(client, { id: 1 } as never, "x");
    expect((client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled();
  });
});

describe("deliverSupportReply", () => {
  it("delivers to a known user and re-opens the session", async () => {
    mocks.findUnique.mockResolvedValue({ telegramLocale: "ru" });
    mocks.update.mockResolvedValue({});
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverSupportReply(client, "575308044", "готово", "777");
    const send = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(send[0]).toBe("575308044");
    expect(send[1]).toContain("готово");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramId: "575308044" }, data: { supportOpen: true } })
    );
  });

  it("notifies the operator and does not set the flag for an unknown user", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverSupportReply(client, "404", "hi", "777");
    const send = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(send[0]).toBe("777");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("parseSupportReply from caption", () => {
  it("reads #uid from a media reply's caption when text is absent", () => {
    const msg = {
      message_id: 3,
      chat: { id: 5, type: "private" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 5, type: "private" },
        from: { id: 9, is_bot: true },
        caption: "🆕 #uid575308044 Ivan\n\nscreenshot",
      },
    };
    expect(parseSupportReply(msg as never)).toEqual({ uid: "575308044" });
  });
});

describe("relaySupportMedia", () => {
  it("copies the media to the support chat with a #uid caption", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { copyMessage: vi.fn().mockResolvedValue(undefined) } as never;
    const msg = { message_id: 8, chat: { id: 42, type: "private" }, caption: "look" };
    const ok = await relaySupportMedia(client, { id: 42, first_name: "Ann" } as never, msg as never);
    expect(ok).toBe(true);
    const call = (client as unknown as { copyMessage: ReturnType<typeof vi.fn> }).copyMessage.mock.calls[0];
    expect(call[0]).toBe("777");
    expect(call[1]).toBe(42);
    expect(call[2]).toBe(8);
    expect(call[3].caption).toContain("🆕 #uid42");
    expect(call[3].caption).toContain("look");
  });

  it("returns false when copyMessage throws", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { copyMessage: vi.fn().mockRejectedValue(new Error("sticker")) } as never;
    const ok = await relaySupportMedia(client, { id: 1 } as never, { message_id: 2, chat: { id: 1 } } as never);
    expect(ok).toBe(false);
  });

  it("no-ops (returns true) when no support chat is configured", async () => {
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    const client = { copyMessage: vi.fn() } as never;
    const ok = await relaySupportMedia(client, { id: 1 } as never, { message_id: 2, chat: { id: 1 } } as never);
    expect(ok).toBe(true);
    expect((client as unknown as { copyMessage: ReturnType<typeof vi.fn> }).copyMessage).not.toHaveBeenCalled();
  });
});

describe("closeSupport", () => {
  it("notifies the operator that the user closed the chat", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    mocks.update.mockResolvedValue({});
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await closeSupport(
      client,
      42,
      "u1",
      { id: 42, first_name: "Ann", username: "ann" } as never,
      t("en")
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: { supportOpen: false } })
    );
    const sm = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    const opCall = sm.mock.calls.find((c) => c[0] === "777");
    expect(opCall).toBeTruthy();
    expect(opCall?.[1]).toContain("Ann");
    expect(opCall?.[1]).toContain("42");
  });

  it("does not send a separate operator notice when the closer is the operator's own chat", async () => {
    process.env.SUPPORT_CHAT_ID = "42";
    mocks.update.mockResolvedValue({});
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await closeSupport(client, 42, "u1", { id: 42 } as never, t("en"));
    const sm = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sm.mock.calls).toHaveLength(1); // only the user-facing "chat closed" message
  });
});
