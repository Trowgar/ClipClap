import { prisma } from "../lib/prisma";

/**
 * Has this account proven an identity worth a free allowance?
 *
 * "One trial per account" only bounds anything if an account costs something to
 * make. A Telegram account is phone-backed and a Google account takes real
 * effort; a bare email+password row costs nothing, which is why the trial was
 * switched off in July. A linked google row counts on its own, whatever the
 * adapter did or did not write into emailVerified.
 */
export async function isTrialAnchored(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      telegramId: true,
      emailVerified: true,
      email: true,
      emailCanonical: true,
    },
  });
  if (!user) return false;

  // Telegram first, and it does not care about the email columns: a bot-only
  // account has both of them NULL and is anchored by a phone-backed id.
  if (user.telegramId) return true;

  // For an account that HAS an email, a NULL emailCanonical means another
  // account already owns this mailbox - the OAuth createUser hook could not
  // claim it. Verified or not, this one does not get a second allowance.
  if (user.email && !user.emailCanonical) return false;

  if (user.emailVerified) return true;

  const federated = await prisma.account.count({
    where: { userId, provider: "google" },
  });
  return federated > 0;
}
