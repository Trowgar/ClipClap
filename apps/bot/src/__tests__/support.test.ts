import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  findOrCreateTelegramUser: vi.fn(),
}));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findOrCreateTelegramUser: mocks.findOrCreateTelegramUser,
    prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
  };
});

import {
  matchSupportAction,
  getSupportChatId,
  parseSupportReply,
  relaySupportMessage,
  deliverSupportReply,
} from "../handlers";

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  vi.clearAllMocks();
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
