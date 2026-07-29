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
  const identifier = `${purpose}:${email}`;

  // At most one live link per purpose per address. Without this, five "send me
  // another link" clicks leave five simultaneously usable links, and an older
  // one recovered from a mailbox keeps working after the user asked for a
  // fresh one. It also stops expired rows accumulating for ever: nothing in
  // retention.service sweeps this table, so issuing is the only moment we get
  // to clean up.
  await prisma.verificationToken.deleteMany({ where: { identifier } });

  await prisma.verificationToken.create({
    data: {
      identifier,
      token: hash(token),
      expires: new Date(Date.now() + TTL_MS[purpose]),
    },
  });

  return token;
}

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not-found" | "expired" };

/** Single use, and single use under concurrency. The row is burned before the
 *  expiry is judged, so a stale link cannot be retried and an expired one
 *  cannot be sat on. */
export async function redeemToken(
  purpose: TokenPurpose,
  token: string
): Promise<RedeemResult> {
  const hashed = hash(token);

  const row = await prisma.verificationToken.findUnique({
    where: { token: hashed },
  });
  if (!row) return { ok: false, reason: "not-found" };

  const prefix = `${purpose}:`;
  // Deliberately NOT deleted: this row is a live, legitimate token for its own
  // purpose. Burning it here would let a crafted verify URL destroy someone's
  // pending password reset.
  if (!row.identifier.startsWith(prefix)) {
    return { ok: false, reason: "not-found" };
  }

  // Compare-and-delete rather than a plain delete, so the burn itself decides
  // the race. Corporate mail scanners prefetch links, so two redemptions
  // milliseconds apart are routine, not hypothetical - and the loser has to
  // get "already used" rather than an uncaught Prisma P2025.
  const { count } = await prisma.verificationToken.deleteMany({
    where: { token: hashed },
  });
  if (count === 0) return { ok: false, reason: "not-found" };

  if (row.expires.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, email: row.identifier.slice(prefix.length) };
}
