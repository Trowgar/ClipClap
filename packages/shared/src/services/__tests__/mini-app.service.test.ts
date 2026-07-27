import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  verifyTelegramInitData,
  signAdminCookie,
  verifyAdminCookie,
} from "../mini-app.service";

const BOT_TOKEN = "123456:test-bot-token";

/** Builds a correctly signed initData string the way Telegram does. */
function makeInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN
): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  // Mini App algorithm: the secret is HMAC("WebAppData", token), NOT sha256(token).
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const nowSec = Math.floor(Date.now() / 1000);
const userJson = JSON.stringify({ id: 575308044, first_name: "Oleg" });

describe("verifyTelegramInitData", () => {
  it("accepts data Telegram actually signed and returns the telegram id", () => {
    const initData = makeInitData({ auth_date: String(nowSec), user: userJson });
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toEqual({
      ok: true,
      telegramId: "575308044",
    });
  });

  it("rejects a tampered payload", () => {
    const initData = makeInitData({ auth_date: String(nowSec), user: userJson });
    const tampered = initData.replace("575308044", "999999999");
    expect(verifyTelegramInitData(tampered, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects data signed with a different bot token", () => {
    const initData = makeInitData(
      { auth_date: String(nowSec), user: userJson },
      "999999:someone-elses-token"
    );
    expect(verifyTelegramInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects a stale auth_date", () => {
    const old = String(nowSec - 60 * 60 * 25);
    const initData = makeInitData({ auth_date: old, user: userJson });
    expect(verifyTelegramInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects empty input and a missing hash", () => {
    expect(verifyTelegramInitData("", BOT_TOKEN).ok).toBe(false);
    expect(verifyTelegramInitData("auth_date=1&user=%7B%7D", BOT_TOKEN).ok).toBe(false);
  });
});

describe("admin cookie", () => {
  it("round-trips a signed value and returns the telegram id", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value, "secret")).toBe("575308044");
  });

  it("rejects a forged or edited value", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value.replace("575308044", "1"), "secret")).toBeNull();
    expect(verifyAdminCookie("1.9999999999999.deadbeef", "secret")).toBeNull();
  });

  it("rejects an expired value and a missing one", () => {
    const expired = signAdminCookie("575308044", "secret", -1000);
    expect(verifyAdminCookie(expired, "secret")).toBeNull();
    expect(verifyAdminCookie(undefined, "secret")).toBeNull();
  });

  it("rejects everything when the signing secret is missing", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value, undefined)).toBeNull();
  });
});
