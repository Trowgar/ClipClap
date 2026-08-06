import { describe, expect, it, vi, afterEach } from "vitest";
import { TelegramApiError, TelegramClient } from "../telegram-client";

afterEach(() => vi.restoreAllMocks());

describe("TelegramApiError", () => {
  // Telegram answered and refused: the request definitely did not take effect,
  // so a retry is safe. That is the whole reason this type exists.
  it("is thrown when Telegram returns ok:false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
    );
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendMessage(1, "hi")).rejects.toBeInstanceOf(TelegramApiError);
  });

  // No answer at all: the send may have landed. It must NOT look like a refusal.
  it("is NOT thrown when the request never got a response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendMessage(1, "hi")).rejects.not.toBeInstanceOf(TelegramApiError);
  });
});
