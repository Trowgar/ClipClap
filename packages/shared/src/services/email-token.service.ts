import { createHash, randomBytes } from "crypto";
import { prisma } from "../lib/prisma";

export type TokenPurpose = "verify" | "reset";

const TTL_MS = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
} as const;

/** What the row stores. The raw token exists only in the mail we send: a
 *  database read must not be enough to take over an account. */
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Reuses Auth.js's verification_tokens table, which the adapter created and
 *  nothing else writes to. The purpose is namespaced into `identifier` so a
 *  reset link can never be redeemed as a verification link. */
export async function issueToken(
  purpose: TokenPurpose,
  email: string
): Promise<string> {
  const token = randomBytes(32).toString("hex");

  await prisma.verificationToken.create({
    data: {
      identifier: `${purpose}:${email}`,
      token: hash(token),
      expires: new Date(Date.now() + TTL_MS[purpose]),
    },
  });

  return token;
}

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not-found" | "expired" };

/** Single use: the row is deleted before the expiry is judged, so a stale link
 *  cannot be retried and an expired one cannot be sat on. */
export async function redeemToken(
  purpose: TokenPurpose,
  token: string
): Promise<RedeemResult> {
  const row = await prisma.verificationToken.findUnique({
    where: { token: hash(token) },
  });
  if (!row) return { ok: false, reason: "not-found" };

  const prefix = `${purpose}:`;
  if (!row.identifier.startsWith(prefix)) {
    return { ok: false, reason: "not-found" };
  }

  await prisma.verificationToken.delete({ where: { token: row.token } });

  if (row.expires.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, email: row.identifier.slice(prefix.length) };
}
