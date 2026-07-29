import { NextRequest, NextResponse } from "next/server";
import {
  prisma,
  recordFunnelEvent,
  redeemToken,
  FUNNEL_EVENTS,
} from "@clipclap/shared";

export const dynamic = "force-dynamic";

/** The same chain email.service builds the link with, in the same order. These
 *  two have to agree: the mail says APP_URL first, so if that variable is ever
 *  set to something other than NEXT_PUBLIC_APP_URL, reading only the latter
 *  here would bounce the user off the origin they arrived on and land them on
 *  a login page with no session. Not a hypothetical worth a divergence. */
const APP_URL =
  process.env.APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "https://clipclap.io";

/** GET, not POST: this is a link in an email. Redirects rather than returning
 *  JSON, because the reader is a browser and the outcome belongs on a page. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(`${APP_URL}/login?verified=invalid`);
  }

  const result = await redeemToken("verify", token);
  if (!result.ok) {
    return NextResponse.redirect(`${APP_URL}/login?verified=${result.reason}`);
  }

  // updateMany, not update: the address is not the primary key, and a row may
  // no longer be there at all. The `emailVerified: null` guard keeps the
  // original verification timestamp if some other path (an OAuth link) got
  // there first - matching zero rows is the right outcome then, not an error,
  // because the mailbox is verified either way.
  const confirmed = await prisma.user.updateMany({
    where: { email: result.email, emailVerified: null },
    data: { emailVerified: new Date() },
  });

  // Only a real transition is recorded, and only after the redirect target is
  // decided. Zero rows means the address was already verified by some other
  // path, which is not a person crossing the wall - it is the same person
  // arriving twice, and counting it would inflate the one number that says how
  // many signups get their free minutes at all.
  //
  // The lookup is a second round trip because updateMany cannot return ids and
  // the funnel is keyed on users.id on this surface, never on an address. It
  // runs only on the transition, so it costs nothing in the common repeat case.
  if (confirmed.count > 0) {
    const user = await prisma.user.findUnique({
      where: { email: result.email },
      select: { id: true },
    });
    if (user) {
      await recordFunnelEvent("web", user.id, FUNNEL_EVENTS.EMAIL_VERIFIED);
    }
  }

  return NextResponse.redirect(`${APP_URL}/login?verified=ok`);
}
