import { describe, expect, it } from "vitest";
import { matchMenuAction } from "../handlers";

describe("matchMenuAction", () => {
  it("matches English menu labels", () => {
    expect(matchMenuAction("📊 Account")).toBe("account");
    expect(matchMenuAction("❓ Help")).toBe("help");
    expect(matchMenuAction("⚙️ Settings")).toBe("settings");
  });

  it("matches Russian menu labels", () => {
    expect(matchMenuAction("📊 Аккаунт")).toBe("account");
    expect(matchMenuAction("❓ Помощь")).toBe("help");
    expect(matchMenuAction("⚙️ Настройки")).toBe("settings");
  });

  it("returns null for unknown text", () => {
    expect(matchMenuAction("hello")).toBeNull();
    expect(matchMenuAction("/start")).toBeNull();
    expect(matchMenuAction("")).toBeNull();
    expect(matchMenuAction("📊 Account extra")).toBeNull();
    expect(matchMenuAction("💎 Plans")).toBeNull();
    expect(matchMenuAction("🌐 Language")).toBeNull();
  });
});
