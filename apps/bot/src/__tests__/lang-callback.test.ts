import { describe, expect, it } from "vitest";
import { LOCALES } from "@clipclap/shared";
import { langCallbackData, parseLangCallback } from "../handlers";

describe("parseLangCallback", () => {
  it("maps known callback data to a language choice", () => {
    expect(parseLangCallback(langCallbackData("en"))).toBe("en");
    expect(parseLangCallback(langCallbackData("ru"))).toBe("ru");
  });

  it("round-trips every supported locale", () => {
    for (const loc of LOCALES) {
      expect(parseLangCallback(langCallbackData(loc))).toBe(loc);
    }
  });

  it("returns null for unknown or empty data", () => {
    expect(parseLangCallback("")).toBeNull();
    expect(parseLangCallback("new_acc")).toBeNull();
    expect(parseLangCallback("lang_de")).toBeNull();
    expect(parseLangCallback("lang_auto")).toBeNull();
    expect(parseLangCallback(undefined)).toBeNull();
  });

  // The wire format is not free to change: buttons sent before a deploy stay
  // tappable in the chat history afterwards.
  it("keeps the lang_<code> callback-data format", () => {
    expect(langCallbackData("en")).toBe("lang_en");
    expect(langCallbackData("ru")).toBe("lang_ru");
  });

  // callback_data is capped at 64 bytes by Telegram, and a button that busts
  // it is rejected by the API when the message is sent, not when it is built.
  it("keeps every locale's callback data inside Telegram's 64-byte cap", () => {
    for (const loc of LOCALES) {
      expect(Buffer.byteLength(langCallbackData(loc), "utf8")).toBeLessThanOrEqual(64);
    }
  });
});
