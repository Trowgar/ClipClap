import { NextResponse } from "next/server";
import {
  prisma,
  canonicalizeEmail,
  isDisposableEmail,
  issueToken,
  sendVerificationEmail,
} from "@clipclap/shared";
import bcrypt from "bcryptjs";

export async function POST(req: Request) {
  const body = await req.json();
  const { email, name, password } = body;

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 }
    );
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  // Normalize before both the lookup and the create: the unique index on
  // email is case-sensitive in Postgres, so without this an attacker could
  // register a case variant of an existing (or admin-listed) address.
  const normalizedEmail = String(email).trim().toLowerCase();

  const canonical = canonicalizeEmail(normalizedEmail);
  if (!canonical) {
    return NextResponse.json(
      { error: "That does not look like an email address" },
      { status: 400 }
    );
  }

  if (isDisposableEmail(normalizedEmail)) {
    return NextResponse.json(
      { error: "Disposable email addresses are not accepted" },
      { status: 400 }
    );
  }

  // Two lookups, because they refuse for different reasons: the same address
  // twice is an ordinary duplicate, while a different address that canonicalises
  // onto an existing one is the same mailbox trying to mint a second free
  // allowance.
  const [existing, sameMailbox] = await Promise.all([
    prisma.user.findUnique({ where: { email: normalizedEmail } }),
    prisma.user.findUnique({ where: { emailCanonical: canonical } }),
  ]);

  if (existing || sameMailbox) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  const hashed = await bcrypt.hash(password, 12);

  try {
    await prisma.user.create({
      data: {
        email: normalizedEmail,
        emailCanonical: canonical,
        name: name || null,
        password: hashed,
      },
    });
  } catch (error) {
    // The two lookups above race a concurrent registration of the same mailbox.
    // The unique indexes on email and emailCanonical are what actually decide
    // that race, so the loser gets the same 409 it would have got a moment
    // earlier - not an unhandled 500 that reads like a broken signup form.
    if (
      error instanceof Error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }
    throw error;
  }

  // Fire and forget by design: sendVerificationEmail never throws, and a mail
  // provider outage must not cost us the registration. An unverified account
  // simply has no free allowance until it asks for another link.
  const token = await issueToken("verify", normalizedEmail);
  await sendVerificationEmail(normalizedEmail, token);

  return NextResponse.json({ ok: true, verificationSent: true });
}
