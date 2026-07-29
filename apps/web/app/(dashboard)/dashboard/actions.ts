"use server";

import { auth } from "@/lib/auth";
import { prisma, issueToken, sendVerificationEmail } from "@clipclap/shared";

export type ResendResult =
  | { ok: true }
  | { ok: false; error: string; alreadyVerified?: boolean };

/** One request per account per minute. In process and not shared between web
 *  replicas, which is enough for what it defends: a person clicking the button
 *  repeatedly because nothing has landed yet. It is not an anti-abuse control -
 *  the action already requires a session, so the only mailbox an attacker can
 *  aim it at is one belonging to an account they can log into. */
const RESEND_COOLDOWN_MS = 60_000;
const lastSentAt = new Map<string, number>();

/**
 * Sends the account holder another verification link.
 *
 * A server action rather than a route: there is no second caller, nothing else
 * needs the endpoint, and the action's argument list is the empty set - the
 * address comes from the session, never from the request. That last part is
 * what keeps this from being a mail cannon. /api/auth/forgot has to be careful
 * about oracles because anyone can post to it; this one can only ever mail the
 * signed-in user their own address.
 */
export async function resendVerificationEmail(): Promise<ResendResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: "Your session has expired. Sign in again." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });

  if (!user?.email) {
    return {
      ok: false,
      error:
        "There is no email address on this account. Add one in Settings first.",
    };
  }

  // Not an error the user needs to fix, and worth saying plainly: the most
  // likely way to get here is a mail scanner having burned the first link, so
  // the address is verified and the page they are looking at is stale.
  if (user.emailVerified) {
    return {
      ok: false,
      alreadyVerified: true,
      error: "This address is already confirmed. Reload the page.",
    };
  }

  const now = Date.now();
  const previous = lastSentAt.get(userId);
  if (previous && now - previous < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      error: "A link went out less than a minute ago. Check your spam folder.",
    };
  }

  try {
    const token = await issueToken("verify", user.email);
    const sent = await sendVerificationEmail(user.email, token);
    if (!sent) {
      // Same marker as the register route, on purpose: one grep has to find
      // every signup that is waiting on mail we never managed to send,
      // whichever door asked for it.
      console.error(
        `[resend-verification] verification-send-failed for ${user.email}`
      );
      return {
        ok: false,
        error: "The mail could not be sent just now. Try again in a minute.",
      };
    }
    // Only on a send the provider accepted. The panel reads this to decide
    // whether it may claim a link went out, so writing it on a failure would
    // reinstate exactly the lie this column exists to end.
    await prisma.user
      .update({ where: { id: userId }, data: { verificationSentAt: new Date() } })
      .catch((err) => {
        console.error(
          "[resend-verification] could not stamp verificationSentAt:",
          err instanceof Error ? err.message : err
        );
      });
  } catch (err) {
    console.error(
      `[resend-verification] verification-send-failed for ${user.email}:`,
      err
    );
    return {
      ok: false,
      error: "The mail could not be sent just now. Try again in a minute.",
    };
  }

  // Recorded only on a send that actually happened, so a provider outage does
  // not lock the user out of retrying for a minute for nothing.
  lastSentAt.set(userId, now);
  return { ok: true };
}
