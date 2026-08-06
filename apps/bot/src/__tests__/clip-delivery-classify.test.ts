import { describe, expect, it } from "vitest";
import { TelegramApiError } from "../telegram-client";
import { classifySendFailure } from "../clip-delivery";

describe("classifySendFailure", () => {
  // Not about this clip - about the chat. Retrying eleven more clips into a
  // blocked chat burns the bot's global rate limit for nothing.
  it("calls a blocked bot a chat-level failure", () => {
    const e = new TelegramApiError("Forbidden: bot was blocked by the user", "sendVideo");
    expect(classifySendFailure(e)).toBe("chat-permanent");
  });

  // Telegram answered, so the send did not take effect: safe to try again.
  it("calls any other Telegram refusal transient", () => {
    const e = new TelegramApiError("Too Many Requests: retry after 30", "sendVideo");
    expect(classifySendFailure(e)).toBe("transient");
  });

  // No answer: the clip may already be in the chat. Retrying risks a duplicate,
  // which is the trade the spec chose deliberately - but it must be VISIBLE.
  it("calls a lost connection ambiguous", () => {
    expect(classifySendFailure(new Error("socket hang up"))).toBe("ambiguous");
    expect(classifySendFailure(new Error("The operation was aborted"))).toBe("ambiguous");
  });
});
