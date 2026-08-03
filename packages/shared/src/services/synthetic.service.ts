import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * Minting and marking rows that analytics must never count.
 *
 * This lives in production code, not under a tests/ folder, on purpose: the
 * things that create synthetic rows are proof scripts run inside a worker
 * container against the production client, and a helper they cannot import is
 * a helper they will not use. The whole point of the flag is that it is set by
 * the code that creates the row, at the moment it creates it, so that nobody
 * has to remember anything later.
 *
 * Nothing here deletes. Deletion is what this mechanism exists to stop
 * depending on.
 */

/**
 * The domain a synthetic address should use.
 *
 * `.local` is reserved by RFC 6762 and can never be a public domain, so an
 * address in it cannot collide with a real signup. `test.com`, which older test
 * runs used, is a REAL registrable domain - it stays in the list below because
 * rows already exist under it, but new fixtures should not add more.
 */
export const SYNTHETIC_EMAIL_DOMAIN = "test.local";

/** Domains that mark an address as belonging to a test run, historical ones
 *  included. Used to spot rows that were created before the flag existed, or
 *  through a surface that could not set it - see find-test-debris.ts. */
export const SYNTHETIC_EMAIL_DOMAINS = ["test.local", "test.com"] as const;

/** Whether an address looks like a test fixture by its domain alone.
 *
 *  A HINT, never the authority. `isSynthetic` on the row is the authority, and
 *  this is deliberately not consulted by analytics: `test.com` is a domain a
 *  real person can hold, and letting a domain string decide who is invisible
 *  would build the mirror image of the bug this whole change is about. */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return (SYNTHETIC_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

/** A unique fixture address, e.g. `syntheticEmail("usage-proof")` ->
 *  `usage-proof-lz9k3f-4821@test.local`. Unique per call so a re-run does not
 *  collide with the row a previous run left behind. */
export function syntheticEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * 10_000).toString().padStart(4, "0");
  return `${prefix}-${stamp}-${noise}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

/**
 * Creates a User that analytics will ignore.
 *
 * The flag is forced rather than defaulted, and `isSynthetic` is removed from
 * the caller's input type, so there is no spelling of this call that produces
 * an unmarked test row. Use it instead of prisma.user.create in every proof
 * script; the next one to be written cannot then forget.
 */
export async function createSyntheticUser(
  data: Omit<Prisma.UserCreateInput, "isSynthetic">
) {
  return prisma.user.create({ data: { ...data, isSynthetic: true } });
}

/**
 * Marks already-created rows as synthetic, by address.
 *
 * For test code that cannot reach prisma.user.create because it goes through a
 * public surface - tests/api.integration.test.ts registers over HTTP, and
 * /api/register must obviously not accept "please hide me from the numbers"
 * from the request body. Such a suite creates the row first and marks it
 * immediately after.
 *
 * Idempotent, and matches nothing when handed an empty list rather than
 * updating every row - an empty `in` is the difference between a no-op and
 * erasing the whole product from its own analytics.
 */
export async function markSyntheticByEmail(emails: string[]): Promise<number> {
  // Both the address as given and its lowercased form. /api/register stores
  // `email.trim().toLowerCase()`, so a suite that registers `Case-1@Test.COM`
  // and then asks to mark that exact string would match nothing and leave a
  // row that looks real to every figure on /admin.
  const wanted = [
    ...new Set(
      emails.flatMap((raw) => {
        const trimmed = raw.trim();
        return trimmed ? [trimmed, trimmed.toLowerCase()] : [];
      })
    ),
  ];
  if (wanted.length === 0) return 0;
  const { count } = await prisma.user.updateMany({
    where: { email: { in: wanted } },
    data: { isSynthetic: true },
  });
  return count;
}
