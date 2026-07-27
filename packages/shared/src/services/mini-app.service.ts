import { createHmac, timingSafeEqual } from "crypto";

const MAX_AUTH_AGE_SEC = 60 * 60 * 24;

export type InitDataResult = { ok: true; telegramId: string } | { ok: false };

/**
 * Validates the `initData` Telegram injects into a Mini App.
 *
 * NOTE the secret derivation: for Mini Apps it is HMAC_SHA256("WebAppData",
 * botToken). The Login Widget uses SHA256(botToken) instead, and mixing the two
 * up is the classic reason "the signature never matches".
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string | undefined
): InitDataResult {
  try {
    if (!initData || !botToken) return { ok: false };
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false };

    params.delete("hash");
    const checkString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");

    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = createHmac("sha256", secret).update(checkString).digest("hex");

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };

    const authDate = Number(params.get("auth_date"));
    if (!Number.isFinite(authDate)) return { ok: false };
    if (Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SEC) {
      return { ok: false };
    }

    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number };
    if (!user.id) return { ok: false };
    return { ok: true, telegramId: String(user.id) };
  } catch {
    return { ok: false };
  }
}

/** `<telegramId>.<expiresAtMs>.<hmac>` - unforgeable without the secret. */
export function signAdminCookie(
  telegramId: string,
  secret: string,
  ttlMs: number
): string {
  const expiresAt = Date.now() + ttlMs;
  const body = `${telegramId}.${expiresAt}`;
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyAdminCookie(
  value: string | undefined,
  secret: string | undefined
): boolean {
  try {
    if (!value || !secret) return false;
    const [telegramId, expiresAt, mac] = value.split(".");
    if (!telegramId || !expiresAt || !mac) return false;
    if (Number(expiresAt) < Date.now()) return false;

    const expected = createHmac("sha256", secret)
      .update(`${telegramId}.${expiresAt}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(mac, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Whether a telegram id is listed in REFERRAL_ADMIN_TELEGRAM_IDS. */
export function isAdminTelegramId(
  telegramId: string,
  adminIds: string | undefined
): boolean {
  if (!adminIds) return false;
  return adminIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(telegramId);
}
