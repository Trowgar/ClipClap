import { NextResponse } from "next/server";
import { prisma, redeemToken } from "@clipclap/shared";
import bcrypt from "bcryptjs";

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request) {
  // Same reason as /api/register and /api/auth/forgot: the generic 500 has an
  // empty body, and a client doing `await res.json()` on a non-ok response
  // hangs on it rather than showing an error.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Malformed request body");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Malformed request body");
  }

  const { token, password } = body as Record<string, unknown>;

  // Typed, not just truthy. `{"token":["..."]}` is not empty, and letting a
  // non-string through would reach the hasher and the token lookup as whatever
  // coercion produced.
  if (typeof token !== "string" || typeof password !== "string") {
    return badRequest("Token and password are required");
  }
  if (!token || !password) {
    return badRequest("Token and password are required");
  }

  // Same floor as /api/register, so a password set here can also be used to
  // sign in there.
  if (password.length < 6) {
    return badRequest("Password must be at least 6 characters");
  }

  // Single use, and burned before expiry is judged, so a stale link cannot be
  // retried. A `verify` token offered here is rejected as not-found and
  // deliberately left alive - a crafted URL must not be able to destroy
  // someone's pending link for the other purpose.
  const result = await redeemToken("reset", token);
  if (!result.ok) {
    return badRequest("This link is no longer valid. Request a new one.");
  }

  const hashed = await bcrypt.hash(password, 12);

  // updateMany, not update: the address is not the primary key, and the row may
  // be gone by now. It is keyed on the address the token was ISSUED for, which
  // is the address stored on the account - /api/auth/forgot makes sure of that.
  //
  // No `password: { not: null }` filter here on purpose. The only way to hold a
  // reset token for an address is to have received it at that mailbox, and
  // /api/auth/forgot only issues one when the row already has a password - and
  // email is unique, so this matches that same single row. The filter would
  // guard nothing that the issuing side does not already guard, while turning
  // the one case it could ever catch (the account deleted and re-created via
  // Google inside the one-hour window) into a silent no-op for a person who has
  // just proved they own the mailbox.
  //
  // Two statements rather than one, in a transaction: folding
  // `emailVerified: null` into the shared where-clause would mean an
  // already-verified user matches zero rows and their PASSWORD silently stays
  // as it was. Split, the password always lands and the timestamp only fills a
  // hole - keeping the original date, exactly as /api/auth/verify does. Nothing
  // reads that date as a trial anchor today (isTrialAnchored only tests it for
  // truthiness), but overwriting history for no gain is not free.
  const [changed] = await prisma.$transaction([
    prisma.user.updateMany({
      where: { email: result.email },
      data: { password: hashed },
    }),
    // Redeeming a reset link also proves the address, so a user who verified
    // this way is not asked to do it twice.
    prisma.user.updateMany({
      where: { email: result.email, emailVerified: null },
      data: { emailVerified: new Date() },
    }),
  ]);

  // The token was valid and is now spent, but nothing was updated: the account
  // was removed between the request and the click. Saying so is not a leak -
  // only the mailbox owner can get this far - and `{"ok":true}` here would send
  // someone away to sign in with a password that was never stored.
  if (changed.count === 0) {
    return badRequest("That account no longer exists.");
  }

  return NextResponse.json({ ok: true });
}
