import { NextResponse } from "next/server";
import {
  prisma,
  canonicalizeEmail,
  issueToken,
  sendPasswordResetEmail,
} from "@clipclap/shared";

/** How long the response is willing to wait on the mail provider. */
const MAIL_TIMEOUT_MS = 5000;

/**
 * Bounds the wait, not the work - the same helper, for the same reason, as
 * /api/register. The Resend SDK's fetch has no timeout, so an outage that shows
 * up as latency rather than an error would hold this response open with the
 * form stuck on "Sending...". On timeout the send keeps running; the caller
 * just stops waiting for it. The timer is cleared once the race settles, or it
 * stays ref'd and holds the event loop for the full window on every request.
 *
 * Duplicated from /api/register rather than shared, because lifting it (and
 * `isPlausibleEmail`) into @clipclap/shared means rebuilding the package the
 * workers run from. Worth doing, but not from this route.
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request) {
  // A malformed body must not reach the generic 500: that 500 has an empty
  // body, and the form does `await res.json()` on every non-ok response, so an
  // unparseable failure hangs the button for ever instead of showing an error.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Malformed request body");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Malformed request body");
  }

  const { email } = body as Record<string, unknown>;

  // Typed, not just truthy: `{"email":["a@b.com"]}` is neither empty nor a
  // string, and `String(email)` would have flattened the array into an address.
  if (typeof email !== "string" || !email.trim()) {
    return badRequest("Email is required");
  }

  // Exactly what /api/register stores, trailing dot included. "yahoo.com." is
  // legal FQDN notation for the same host, and dropping the strip here would
  // look up a row that cannot exist and then answer `{"ok":true}` anyway - the
  // oracle-safe response hides the failure completely.
  const normalized = email.trim().toLowerCase().replace(/\.+$/, "");

  // 254 is the longest address an SMTP envelope can carry. This bounds the
  // query parameter; it is not a shape check.
  if (normalized.length > 254) {
    return badRequest("That does not look like an email address");
  }

  // Refusing a malformed address with a 400 is not an oracle: whether a string
  // is shaped like an address is decidable offline, so this discloses nothing
  // about who is registered. Only the found/not-found answer has to be uniform.
  const canonical = canonicalizeEmail(normalized);
  if (!canonical) {
    return badRequest("That does not look like an email address");
  }

  // Matched on the canonical mailbox as well as the exact address, because
  // exact alone strands real accounts. One of the eight password rows in this
  // database was stored before registration normalised case; its email has a
  // capital letter, the unique index on email is case-sensitive in Postgres, so
  // a lowercase exact lookup misses the only account its owner has. Its
  // emailCanonical matches. The same goes for a row registered at a
  // plus-address whose owner types the plain form.
  //
  // What makes this safe is where the mail goes: the token is issued for, and
  // sent to, `target.email` - the address ON THE ACCOUNT - never the address
  // the requester typed. Canonicalisation strips `+` for every domain, so
  // looking up canonically and then mailing the typed string would hand a reset
  // link for victim@corp.com to whoever asked about victim+evil@corp.com. It
  // would also break silently even when honest: redeemToken hands back the
  // address the token was issued for, and the update in /api/auth/reset keys on
  // it, so a token issued for the typed form matches zero rows and reports
  // success while changing nothing.
  //
  // take: 2 and exact-wins, as in /api/register, because both arms can match
  // different rows at once: a Google row can hold this exact address with a
  // NULL canonical while another row holds the canonical. The address the user
  // actually typed is the one they mean.
  const rows = await prisma.user.findMany({
    where: { OR: [{ email: normalized }, { emailCanonical: canonical }] },
    select: { email: true, password: true },
    take: 2,
  });
  const target = rows.find((row) => row.email === normalized) ?? rows[0];

  // Always the same answer. Telling a stranger whether an address is registered
  // turns this endpoint into a membership oracle.
  //
  // No password means Google-only or Telegram-only: there is nothing to reset,
  // and minting a password by mail would add a second way into an account whose
  // owner never asked for one.
  if (target?.email && target.password) {
    // Guarded, and the guard is what keeps the answer uniform: an uncaught
    // throw from either call is a 500, and a 500 for a known address next to a
    // 200 for an unknown one is the oracle this route exists to avoid. The
    // response also cannot report whether the mail went out, for the same
    // reason - so it does not.
    try {
      const token = await issueToken("reset", target.email);
      await withTimeout(
        sendPasswordResetEmail(target.email, token),
        MAIL_TIMEOUT_MS,
        false
      );
    } catch (err) {
      console.error("[forgot] could not issue a reset link:", err);
    }
  }

  return NextResponse.json({ ok: true });
}
