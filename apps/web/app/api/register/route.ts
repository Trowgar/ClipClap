import { NextResponse } from "next/server";
import {
  prisma,
  canonicalizeEmail,
  isDisposableEmail,
  issueToken,
  sendVerificationEmail,
} from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * A conservative shape check, deliberately not RFC 5322.
 *
 * `canonicalizeEmail` is an identity function, not a validator - it accepts
 * anything with one `@` and a dot after it, so `rvw<b>seven@gmail.com` used to
 * register with a 200 while the 400 copy claimed to be checking. The job here
 * is only to refuse what no mail server would accept: the local part is
 * dot-separated atoms of ordinary address characters, which is what rejects
 * `a..b@x.com` and a leading or trailing dot, and the domain is dot-separated
 * labels that begin and end alphanumeric.
 *
 * The apostrophe is allowed on purpose, unlike the other quote characters:
 * `o'brien@example.com` is a real mailbox at plenty of domains, and refusing it
 * would strand exactly the kind of user Fix 3 is about. It is inert everywhere
 * this value goes - Prisma parameterises the query and the mail layout escapes
 * every interpolation.
 */
const LOCAL_PART =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_PART =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function isPlausibleEmail(value: string): boolean {
  // 254 is the longest address an SMTP envelope can carry, so anything past it
  // is unroutable by definition - and this runs before bcrypt and the database.
  if (value.length > 254) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length > 64) return false;
  return LOCAL_PART.test(local) && DOMAIN_PART.test(domain);
}

/** How long the response is willing to wait on the mail provider. */
const MAIL_TIMEOUT_MS = 5000;

/**
 * Bounds the wait, not the work.
 *
 * The Resend SDK's fetch has no timeout, and an outage that shows up as latency
 * rather than an error would otherwise hold this response open with the form
 * stuck on "Creating account..." over an account that already exists. On
 * timeout the send keeps running - this is a long-lived node server, not a
 * runtime that freezes on response - the caller just stops waiting for it.
 *
 * The timer is cleared once the race settles. Without that it stays ref'd and
 * holds the event loop for the full window on every registration, including the
 * overwhelmingly common one where the send finished in a millisecond.
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

function duplicateAddress() {
  return NextResponse.json(
    { error: "An account with this email already exists" },
    { status: 409 }
  );
}

/** True of the address the user typed, and actionable, without naming the
 *  address that already holds the mailbox. Both branches disclose "this mailbox
 *  is registered" equally, so saying which one it was costs no privacy. */
function duplicateMailbox() {
  return NextResponse.json(
    {
      error:
        "This mailbox is already registered under a different form of the same address - sign in with the address you used first",
    },
    { status: 409 }
  );
}

export async function POST(req: Request) {
  // A malformed body must not reach the generic 500: this route's 500 has an
  // empty body, and the form does `await res.json()` on every non-ok response,
  // so an unparseable failure hangs the button on "Creating account..." for
  // ever instead of showing an error.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Malformed request body");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Malformed request body");
  }

  const { email, name, password } = body as Record<string, unknown>;

  // Typed, not just truthy: `{"email":["a@b.com"]}` is neither empty nor a
  // string, and `String(email)` would have flattened the array into an address.
  if (typeof email !== "string" || typeof password !== "string") {
    return badRequest("Email and password are required");
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    return badRequest("Name must be text");
  }

  if (!email || !password) {
    return badRequest("Email and password are required");
  }

  if (password.length < 6) {
    return badRequest("Password must be at least 6 characters");
  }

  // Normalize before both the lookup and the create: the unique index on
  // email is case-sensitive in Postgres, so without this an attacker could
  // register a case variant of an existing (or admin-listed) address.
  //
  // The trailing dot goes too. "yahoo.com." is legal FQDN notation for the same
  // host and canonicalizeEmail already drops it, but authorize() looks the
  // stored address up exactly - so storing the dotted form mints an account
  // whose owner can never sign in with the natural form of their own address,
  // and cannot re-register it either.
  const normalizedEmail = email.trim().toLowerCase().replace(/\.+$/, "");

  if (!isPlausibleEmail(normalizedEmail)) {
    return badRequest("That does not look like an email address");
  }

  const canonical = canonicalizeEmail(normalizedEmail);
  if (!canonical) {
    return badRequest("That does not look like an email address");
  }

  if (isDisposableEmail(normalizedEmail)) {
    return badRequest("Disposable email addresses are not accepted");
  }

  // One round trip for both refusals, which are different: the same address
  // twice is an ordinary duplicate, while a different address that canonicalises
  // onto an existing one is the same mailbox trying to mint a second free
  // allowance.
  //
  // `take: 2`, not findFirst, because BOTH can match at once and the exact
  // address has to win. A row can hold this exact address with a NULL canonical
  // - that is precisely what an OAuth signup looks like when its claim lost to
  // an existing alias - while a second row holds the canonical. findFirst
  // returns whichever Postgres reaches first, so the user's own Google account
  // could be answered with "sign in with the address you used first" about the
  // address they just typed.
  const clashes = await prisma.user.findMany({
    where: { OR: [{ email: normalizedEmail }, { emailCanonical: canonical }] },
    select: { email: true },
    take: 2,
  });

  if (clashes.length > 0) {
    return clashes.some((row) => row.email === normalizedEmail)
      ? duplicateAddress()
      : duplicateMailbox();
  }

  const hashed = await bcrypt.hash(password, 12);

  try {
    await prisma.user.create({
      data: {
        email: normalizedEmail,
        emailCanonical: canonical,
        name: typeof name === "string" ? name.trim() || null : null,
        password: hashed,
      },
    });
  } catch (err) {
    // The lookup above races a concurrent registration of the same mailbox. The
    // unique indexes on email and emailCanonical are what actually decide that
    // race, so the loser gets the same 409 it would have got a moment earlier -
    // not an unhandled 500 that reads like a broken signup form.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const target = String(err.meta?.target ?? "");
      return target.includes("emailCanonical")
        ? duplicateMailbox()
        : duplicateAddress();
    }
    throw err;
  }

  // Fire and forget, and now actually so. The account row is committed and is
  // the only thing this request had to get right: a mail provider outage, a
  // slow one, or a failed write to verification_tokens must not turn a
  // successful registration into a 500 the form cannot even parse. An
  // unverified account simply has no free allowance until it asks for another
  // link.
  let verificationSent = false;
  try {
    const token = await issueToken("verify", normalizedEmail);
    verificationSent = await withTimeout(
      sendVerificationEmail(normalizedEmail, token),
      MAIL_TIMEOUT_MS,
      false
    );
  } catch (err) {
    console.error("[register] could not issue a verification link:", err);
  }

  // Reported, not asserted: with RESEND_API_KEY unset this is false on every
  // registration, which is the truth and is what the log says too.
  return NextResponse.json({ ok: true, verificationSent });
}
