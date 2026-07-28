import { NextRequest, NextResponse } from "next/server";
import { prisma, redeemToken } from "@clipclap/shared";

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
  await prisma.user.updateMany({
    where: { email: result.email, emailVerified: null },
    data: { emailVerified: new Date() },
  });

  return NextResponse.redirect(`${APP_URL}/login?verified=ok`);
}
