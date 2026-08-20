import { describe, expect, it, vi, beforeEach } from "vitest";

const recordClipFeedbackMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, recordClipFeedback: recordClipFeedbackMock };
});

import { handleFeedbackCallback } from "../handlers";
import { t } from "../i18n";

const client = {
  editMessageReplyMarkup: vi.fn(),
  editMessageText: vi.fn(),
  sendMessage: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  recordClipFeedbackMock.mockResolvedValue({ ok: true, verdict: "NO", reason: null });
  // The real TelegramClient methods are all async; a bare vi.fn() resolves to
  // undefined synchronously (not a Promise), which makes the handler's
  // `.catch(() => undefined)` chaining throw on a `.catch` of undefined.
  client.editMessageReplyMarkup.mockResolvedValue(undefined);
  client.editMessageText.mockResolvedValue(undefined);
  client.sendMessage.mockResolvedValue(undefined);
});

describe("handleFeedbackCallback", () => {
  it("records a verdict and swaps in the reason keyboard", async () => {
    await handleFeedbackCallback(
      client as never,
      { chatId: 1, messageId: 10, userId: "user-1", data: "fb:n:clip-1" },
      t("en")
    );
    expect(recordClipFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clipId: "clip-1",
        userId: "user-1",
        surface: "bot",
        verdict: "NO",
      })
    );
    const markup = client.editMessageReplyMarkup.mock.calls[0][2];
    expect(markup.inline_keyboard.map((r: unknown[]) => r.length)).toEqual([2, 2, 1]);
  });

  // One tap and done for the good case: asymmetric friction is the design.
  it("shows no reason keyboard after AS_IS", async () => {
    recordClipFeedbackMock.mockResolvedValue({ ok: true, verdict: "AS_IS", reason: null });
    await handleFeedbackCallback(
      client as never,
      { chatId: 1, messageId: 10, userId: "user-1", data: "fb:a:clip-1" },
      t("en")
    );
    expect(client.editMessageReplyMarkup).toHaveBeenCalledWith(1, 10, undefined);
  });

  // The keyboard is attacker-controlled. A refused write must change nothing
  // in the chat and must not tell the presser anything about the other user.
  it("leaves the message alone when the service refuses", async () => {
    recordClipFeedbackMock.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    await handleFeedbackCallback(
      client as never,
      { chatId: 1, messageId: 10, userId: "intruder", data: "fb:n:clip-1" },
      t("en")
    );
    expect(client.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  // answerCallbackQuery has already run by the time this is called, and a
  // throw here would take down the whole router for one bad write.
  it("swallows a service failure", async () => {
    recordClipFeedbackMock.mockRejectedValue(new Error("db is down"));
    await expect(
      handleFeedbackCallback(
        client as never,
        { chatId: 1, messageId: 10, userId: "user-1", data: "fb:n:clip-1" },
        t("en")
      )
    ).resolves.toBeUndefined();
  });

  // A reason tap records the reason, never a verdict - the verdict it belongs
  // to was recorded by the previous tap.
  it("records a reason without a verdict and clears the keyboard", async () => {
    recordClipFeedbackMock.mockResolvedValue({ ok: true, verdict: "NO", reason: "FRAMING" });
    await handleFeedbackCallback(
      client as never,
      { chatId: 1, messageId: 10, userId: "user-1", data: "fr:3:clip-1" },
      t("en")
    );
    const arg = recordClipFeedbackMock.mock.calls[0][0];
    expect(arg).toMatchObject({ clipId: "clip-1", surface: "bot", reason: "FRAMING" });
    expect(arg).not.toHaveProperty("verdict");
    expect(client.editMessageReplyMarkup).toHaveBeenCalledWith(1, 10, undefined);
    expect(client.sendMessage).toHaveBeenCalled();
  });

  // Not ours: the router must fall through to its other branches rather than
  // swallow another feature's callback.
  it("does nothing for a callback that is not a feedback one", async () => {
    await handleFeedbackCallback(
      client as never,
      { chatId: 1, messageId: 10, userId: "user-1", data: "resend:job-1" },
      t("en")
    );
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
    expect(client.editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});
