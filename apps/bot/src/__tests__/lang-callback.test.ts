import { describe, expect, it } from "vitest";
import {
  CALLBACK_LANG_EN,
  CALLBACK_LANG_RU,
  parseLangCallback,
} from "../handlers";

describe("parseLangCallback", () => {
  it("maps known callback data to a language choice", () => {
    expect(parseLangCallback(CALLBACK_LANG_EN)).toBe("en");
    expect(parseLangCallback(CALLBACK_LANG_RU)).toBe("ru");
  });

  it("returns null for unknown or empty data", () => {
    expect(parseLangCallback("")).toBeNull();
    expect(parseLangCallback("new_acc")).toBeNull();
    expect(parseLangCallback("lang_de")).toBeNull();
    expect(parseLangCallback("lang_auto")).toBeNull();
    expect(parseLangCallback(undefined)).toBeNull();
  });

  it("exposes stable callback-data constants", () => {
    expect(CALLBACK_LANG_EN).toBe("lang_en");
    expect(CALLBACK_LANG_RU).toBe("lang_ru");
  });
});
